import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';

export interface PlainTextOptions {
    readonly signal?: AbortSignal;
    /** Yield to the host scheduler, not just another microtask. */
    readonly cooperate: () => Promise<void>;
    readonly sliceMilliseconds?: number;
}

/** Shared strict ingress: CR/CRLF become separators; unsupported UTF-16 is refused. */
function* normalizeSteps(value: string): Generator<void, string> {
    // CRLF can contract by at most half; reject impossible input before allocating a second string.
    if (value.length > MAX_TEXT_LENGTH * 2) throw new RangeError('Rich text exceeds limits');
    let blocks = 1, length = 0, last = 0, checkpoint = 4096;
    const pieces: string[] = [];
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 13) {
            pieces.push(value.slice(last, index), '\n');
            if (value.charCodeAt(index + 1) === 10) index++;
            last = index + 1;
            if (++blocks > MAX_TEXT_BLOCKS) throw new RangeError('Rich text exceeds limits');
            length++;
        } else if (code === 10) {
            if (++blocks > MAX_TEXT_BLOCKS) throw new RangeError('Rich text exceeds limits');
            length++;
        } else if (code < 32 && code !== 9) throw new RangeError('Text contains an unsupported control character');
        else if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new RangeError('Text contains an unpaired surrogate');
            index++; length += 2;
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new RangeError('Text contains an unpaired surrogate');
        else length++;
        if (length > MAX_TEXT_LENGTH) throw new RangeError('Rich text exceeds limits');
        if (index >= checkpoint) { checkpoint = index + 4096; yield; }
    }
    if (!pieces.length) return value;
    pieces.push(value.slice(last));
    return pieces.join('');
}

export function normalizePlainInsertion(value: string): string {
    const steps = normalizeSteps(value);
    for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
    }
}

/** Cancellation discards the unpublished partial conversion. */
export async function normalizePlainInsertionCooperative(value: string, options: PlainTextOptions): Promise<string> {
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid text normalization time slice');
    const steps = normalizeSteps(value);
    let started = performance.now();
    for (;;) {
        options.signal?.throwIfAborted();
        const step = steps.next();
        if (step.done) return step.value;
        if (performance.now() - started >= budget) {
            await options.cooperate();
            options.signal?.throwIfAborted();
            started = performance.now();
        }
    }
}
