import type { WorkerContext } from '../../../platform/workers';
import { spellWords } from './words';

interface CachedCheck {
    readonly text: string;
    readonly dictionary: object;
    readonly ranges: Uint32Array;
}
interface ChangedRange {
    readonly from: number;
    readonly oldTo: number;
    readonly newTo: number;
}

const CACHE_BYTES = 8 * 1024 * 1024;
const WORD_CACHE_BYTES = 1024 * 1024;
const SCAN_SLICE = 16_384;
const COMPARISON_SLICE = 8192;
const RANGE_SLICE = 4096;

function current(context: WorkerContext): void {
    context.signal.throwIfAborted();
    if (context.cancelled) throw new DOMException('Spelling check cancelled', 'AbortError');
}
function space(value: string): boolean { return /\s/u.test(value); }

/** A shared whitespace boundary is a word boundary, including when an edit joins two words. */
async function changedRange(before: string, after: string, context: WorkerContext): Promise<ChangedRange | null> {
    const common = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < common && before[prefix] === after[prefix]) {
        prefix++;
        if (prefix % COMPARISON_SLICE === 0) await context.slice();
    }
    if (prefix === before.length && prefix === after.length) return null;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix
        && before[before.length - suffix - 1] === after[after.length - suffix - 1]) {
        suffix++;
        if (suffix % COMPARISON_SLICE === 0) await context.slice();
    }
    let from = prefix, oldTo = before.length - suffix, newTo = after.length - suffix, steps = 0;
    while (from > 0 && !space(before[from - 1])) {
        from--;
        if (++steps % COMPARISON_SLICE === 0) await context.slice();
    }
    // Both positions are at the start of the same suffix; advancing them together cannot
    // split a word on one side while retaining its old result on the other.
    while (oldTo < before.length && newTo < after.length && !space(before[oldTo])) {
        oldTo++; newTo++;
        if (++steps % COMPARISON_SLICE === 0) await context.slice();
    }
    current(context);
    return { from, oldTo, newTo };
}

async function scan(text: string, from: number, to: number, correct: (word: string) => boolean,
    context: WorkerContext): Promise<number[]> {
    const result: number[] = [];
    for (let start = from; start < to;) {
        current(context);
        let end = Math.min(to, start + SCAN_SLICE), scanned = 0;
        while (end < to && !space(text[end - 1]) && !space(text[end])) {
            end++;
            if (++scanned % RANGE_SLICE === 0) await context.slice();
        }
        let count = 0;
        for (const word of spellWords(text.slice(start, end))) {
            current(context);
            if (!correct(word.text)) result.push(start + word.from, start + word.to);
            if (++count % 256 === 0) await context.slice();
        }
        start = end;
        await context.slice();
    }
    current(context);
    return result;
}

async function splice(previous: Uint32Array, changed: ChangedRange, replacement: readonly number[],
    context: WorkerContext): Promise<Uint32Array> {
    let before = 0, after = 0;
    while (before < previous.length && previous[before + 1] <= changed.from) {
        before += 2;
        if (before % RANGE_SLICE === 0) await context.slice();
    }
    after = before;
    while (after < previous.length && previous[after] < changed.oldTo) {
        after += 2;
        if (after % RANGE_SLICE === 0) await context.slice();
    }
    const result = new Uint32Array(before + replacement.length + previous.length - after);
    result.set(previous.subarray(0, before));
    result.set(replacement, before);
    const shift = changed.newTo - changed.oldTo;
    let target = before + replacement.length;
    for (let index = after; index < previous.length; index += 2) {
        result[target++] = previous[index] + shift;
        result[target++] = previous[index + 1] + shift;
        if ((index - after) % RANGE_SLICE === 0) await context.slice();
    }
    current(context);
    return result;
}

/** One bounded, dictionary-affine previous result; unsupported sizes use the same full scanner. */
export class IncrementalSpelling {
    private cached: CachedCheck | null = null;
    private epoch = 0;
    private wordDictionary: object | null = null;
    private readonly words = new Map<string, boolean>();
    private wordBytes = 0;

    clear(): void {
        this.epoch++; this.cached = null; this.wordDictionary = null;
        this.words.clear(); this.wordBytes = 0;
    }

    private correct(dictionary: object, word: string, check: (word: string) => boolean, epoch: number): boolean {
        if (epoch !== this.epoch || word.length > 128) return check(word);
        if (this.wordDictionary !== dictionary) {
            this.wordDictionary = dictionary;
            this.words.clear(); this.wordBytes = 0;
        }
        const existing = this.words.get(word);
        if (existing !== undefined) {
            this.words.delete(word); this.words.set(word, existing);
            return existing;
        }
        const result = check(word), bytes = 64 + word.length * 2;
        while (this.wordBytes + bytes > WORD_CACHE_BYTES) {
            const oldest = this.words.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.words.delete(oldest);
            this.wordBytes -= 64 + oldest.length * 2;
        }
        this.words.set(word, result); this.wordBytes += bytes;
        return result;
    }

    async check(text: string, dictionary: object, correct: (word: string) => boolean, context: WorkerContext): Promise<Uint32Array> {
        current(context);
        const epoch = this.epoch, cached = this.cached?.dictionary === dictionary ? this.cached : null;
        const checkWord = (word: string) => this.correct(dictionary, word, correct, epoch);
        let result: Uint32Array;
        if (cached) {
            const changed = await changedRange(cached.text, text, context);
            if (!changed) { current(context); return cached.ranges.slice(); }
            const replacement = await scan(text, changed.from, changed.newTo, checkWord, context);
            result = await splice(cached.ranges, changed, replacement, context);
        } else result = Uint32Array.from(await scan(text, 0, text.length, checkWord, context));
        current(context);
        if (epoch === this.epoch) {
            this.cached = text.length * 2 + result.byteLength <= CACHE_BYTES
                ? { text, dictionary, ranges: result.slice() } : null;
        }
        return result;
    }
}
