import type { Block, RichText } from './richText';
import { ensureProjectionSteps, projectionBlockStart, projectionLength, projectionPosition } from './projection';
import { WeakIdentityLru } from './weakLru';
import { WordBlockIndex } from './wordIndex';
import { runIndex } from './runIndex';
import { GraphemeNavigator } from './graphemes';
import { finishTextSteps, finishTextStepsCooperative } from './cooperative';
import type { PlainTextOptions } from './plainText';

export interface BoundarySelection { readonly anchor: number; readonly focus: number }
export type BoundaryDirection = -1 | 1;

type Segments = ReturnType<Intl.Segmenter['segment']>;
interface BlockEntry {
    readonly text: string;
    readonly bytes: number;
    graphemes?: GraphemeNavigator;
    words?: Segments;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const DEFAULT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ENTRIES = 1024;
const emptyWords = new WordBlockIndex();

/** A splice preserves every untouched block's wordless classification. */
export function inheritWordBoundaries(before: RichText, after: RichText, first: number, removed: number, inserted: number): void {
    emptyWords.inherit(before, after, first, removed, inserted);
}
export function clearWordBoundaries(): void { emptyWords.clear(); }

function* endsWithCRSteps(block: Block): Generator<void, boolean> {
    let count = 0;
    for (let index = block.runs.length - 1; index >= 0; index--) {
        const text = block.runs[index].text;
        if (text.length) return text.charCodeAt(text.length - 1) === 13;
        if ((++count & 255) === 0) yield;
    }
    return false;
}
function endsWithCR(block: Block): boolean { return finishTextSteps(endsWithCRSteps(block)); }

function* blockStringSteps(block: Block): Generator<void, string> {
    if (block.runs.length === 1) return block.runs[0].text;
    const parts: string[] = [];
    let current = '', count = 0;
    for (const run of block.runs) {
        if (current && current.length + run.text.length > 4096) { parts.push(current); current = ''; }
        if (run.text.length > 4096) parts.push(run.text);
        else current += run.text;
        if ((++count & 255) === 0) yield;
    }
    if (current) parts.push(current);
    return parts.join('');
}

/**
 * Navigation is indexed by immutable blocks: no joined document and no array of
 * per-character boundary objects. ICU's Segments supports indexed containing()
 * even when a grapheme spans several differently styled runs.
 */
export class TextBoundaries {
    // LRU values retain text/ICU views, not blocks and their potentially large opaque data.
    private readonly entries: WeakIdentityLru<Block, BlockEntry>;

    constructor(byteLimit = DEFAULT_BYTES, entryLimit = DEFAULT_ENTRIES) {
        this.entries = new WeakIdentityLru(byteLimit, entryLimit);
    }

    private *entrySteps(block: Block): Generator<void, BlockEntry> {
        const cached = this.entries.get(block);
        if (cached) return cached;
        const text = yield* blockStringSteps(block);
        // Charge for the retained string and both possible ICU segmentation views.
        const bytes = 512 + text.length * 12;
        const result: BlockEntry = { text, bytes };
        this.entries.set(block, result, bytes);
        return result;
    }
    private entry(block: Block): BlockEntry { return finishTextSteps(this.entrySteps(block)); }

    private clamp(text: RichText, offset: number): number {
        return Math.max(0, Math.min(projectionLength(text), Number.isFinite(offset) ? Math.floor(offset) : 0));
    }

    /** A block separator participates in CRLF when the preceding block ends in CR. */
    *isBoundarySteps(text: RichText, offset: number): Generator<void, boolean> {
        if (!text.blocks.length || !Number.isSafeInteger(offset) || offset < 0) return false;
        yield* ensureProjectionSteps(text);
        if (offset > projectionLength(text)) return false;
        const point = projectionPosition(text, offset);
        if (point.offset === 0 && point.length !== 0) return true;
        if (point.offset === point.length)
            return point.index + 1 >= text.blocks.length || !(yield* endsWithCRSteps(point.block));
        const entry = yield* this.entrySteps(point.block);
        return (entry.graphemes ??= new GraphemeNavigator(entry.text)).isBoundary(point.offset);
    }
    isBoundary(text: RichText, offset: number): boolean { return finishTextSteps(this.isBoundarySteps(text, offset)); }
    isBoundaryCooperative(text: RichText, offset: number, options: PlainTextOptions): Promise<boolean> {
        return finishTextStepsCooperative(this.isBoundarySteps(text, offset), options);
    }

    /** One extended grapheme in projection order, including a CR+separator pair. */
    adjacent(text: RichText, offset: number, direction: BoundaryDirection): number {
        const length = projectionLength(text), cursor = this.clamp(text, offset);
        if (direction < 0 && cursor === 0) return 0;
        if (direction > 0 && cursor === length) return length;
        const point = projectionPosition(text, cursor);
        if (direction < 0 && point.offset === 0) {
            if (!point.index) return 0;
            return point.start - (endsWithCR(text.blocks[point.index - 1]) ? 2 : 1);
        }
        if (direction > 0 && point.offset === point.length)
            return point.index + 1 < text.blocks.length ? cursor + 1 : length;
        const entry = this.entry(point.block), navigator = entry.graphemes ??= new GraphemeNavigator(entry.text);
        if (direction < 0) return point.start + navigator.previous(point.offset);
        const end = navigator.next(point.offset);
        return point.start + end + (end === entry.text.length && entry.text.endsWith('\r') && point.index + 1 < text.blocks.length ? 1 : 0);
    }

    /** Expand an arbitrary UTF-16 offset to the nearest stop in the requested direction. */
    snap(text: RichText, offset: number, direction: BoundaryDirection): number {
        const cursor = this.clamp(text, offset);
        return this.isBoundary(text, cursor) ? cursor : this.adjacent(text, cursor, direction);
    }

    selectWord(text: RichText, offset: number): BoundarySelection {
        const length = projectionLength(text);
        if (!length) return { anchor: 0, focus: 0 };
        const cursor = Math.min(length - 1, this.clamp(text, offset)), point = projectionPosition(text, cursor);
        const entry = this.entry(point.block), followedByBreak = point.index + 1 < text.blocks.length;
        if (followedByBreak && point.offset === entry.text.length)
            return { anchor: entry.text.endsWith('\r') ? cursor - 1 : cursor, focus: cursor + 1 };
        if (followedByBreak && point.offset === entry.text.length - 1 && entry.text.endsWith('\r'))
            return { anchor: cursor, focus: cursor + 2 };
        const part = (entry.words ??= wordSegmenter.segment(entry.text)).containing(point.offset);
        if (!part) return { anchor: cursor, focus: cursor };
        const from = this.snap(text, point.start + part.index, -1);
        const to = this.snap(text, point.start + part.index + part.segment.length, 1);
        return { anchor: from, focus: to };
    }

    selectBlock(text: RichText, offset: number): BoundarySelection {
        const point = projectionPosition(text, this.clamp(text, offset));
        // A trailing CR belongs to the following separator, not to a partial selection.
        const end = point.start + point.length;
        return { anchor: point.start, focus: this.snap(text, end, 1) };
    }

    /** Word motion skips non-word segments and the synthetic separators between blocks. */
    word(text: RichText, offset: number, direction: BoundaryDirection): number {
        const length = projectionLength(text), cursor = this.clamp(text, offset);
        if (direction < 0 && cursor === 0) return 0;
        if (direction > 0 && cursor === length) return length;
        const point = projectionPosition(text, cursor);
        let index = point.index, start = point.start, local = point.offset;
        while (index >= 0 && index < text.blocks.length) {
            if (emptyWords.has(text, index)) {
                index = emptyWords.next(text, index, direction);
                if (index < 0 || index >= text.blocks.length) break;
                start = projectionBlockStart(text, index);
                local = direction < 0 ? runIndex(text.blocks[index]).length : 0;
            }
            const entry = this.entry(text.blocks[index]);
            const scannedWhole = direction < 0 ? local >= entry.text.length : local === 0;
            if (direction < 0) {
                local = Math.min(local, entry.text.length);
                while (local > 0) {
                    const part = (entry.words ??= wordSegmenter.segment(entry.text)).containing(local - 1);
                    if (!part) break;
                    if (part.isWordLike) return this.snap(text, start + part.index, -1);
                    if (part.index >= local) break;
                    local = part.index;
                }
                if (scannedWhole) emptyWords.mark(text, index);
                const previous = index;
                index = emptyWords.next(text, index - 1, -1);
                if (index < 0) break;
                local = runIndex(text.blocks[index]).length;
                start = index === previous - 1 ? start - local - 1 : projectionBlockStart(text, index);
            } else {
                while (local < entry.text.length) {
                    const part = (entry.words ??= wordSegmenter.segment(entry.text)).containing(local);
                    if (!part) break;
                    const end = part.index + part.segment.length;
                    if (part.isWordLike) return this.snap(text, start + end, 1);
                    if (end <= local) break;
                    local = end;
                }
                if (scannedWhole) emptyWords.mark(text, index);
                const previous = index;
                index = emptyWords.next(text, index + 1, 1);
                if (index >= text.blocks.length) break;
                start = index === previous + 1 ? start + entry.text.length + 1 : projectionBlockStart(text, index);
                local = 0;
            }
        }
        return direction < 0 ? 0 : length;
    }

    private *primeWordSteps(text: RichText): Generator<void, void> {
        let visited = 0;
        for (let index = 0; index < text.blocks.length; index++) {
            if ((++visited & 255) === 0) yield;
            if (emptyWords.has(text, index)) continue;
            const entry = this.entry(text.blocks[index]);
            let hasWord = false;
            for (const part of (entry.words ??= wordSegmenter.segment(entry.text))) {
                if ((++visited & 255) === 0) yield;
                if (part.isWordLike) { hasWord = true; break; }
            }
            if (!hasWord) emptyWords.mark(text, index);
        }
    }

    /** Warm only proven wordless blocks; aborting leaves any prior proofs valid. */
    primeWords(text: RichText, options: PlainTextOptions): Promise<void> {
        return finishTextStepsCooperative(this.primeWordSteps(text), options);
    }

    clear(): void { this.entries.clear(); }
}

/** Bounded shared cache for the synchronous, view-independent rich operation API. */
export const textBoundaries = new TextBoundaries();
