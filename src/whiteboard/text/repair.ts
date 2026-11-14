import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import type { PlainTextOptions } from './plainText';

export interface RepairedText {
    /** CR and CRLF are normalized to LF, which represents a block separator. */
    readonly text: string;
    readonly surrogates: number;
    readonly controls: number;
    /** UTF-16 units excluding LF separators, which the block builder accounts for. */
    readonly contentLength: number;
}

function* repairSteps(value: string, limit: number): Generator<void, RepairedText> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_TEXT_LENGTH) throw new RangeError('Invalid rich text repair limit');
    // Even complete CRLF contraction cannot fit a longer input.
    if (value.length > MAX_TEXT_LENGTH * 2) throw new RangeError('Rich text exceeds limits');
    let surrogates = 0, controls = 0, contentLength = 0, separators = 0, last = 0, checkpoint = 4096;
    let batch: string[] = [];
    const pieces: string[] = [];
    const replace = (at: number, end: number, replacement: string) => {
        batch.push(value.slice(last, at), replacement); last = end;
        if (batch.length >= 512) { pieces.push(batch.join('')); batch = []; }
    };
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 13) {
            const end = value.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
            replace(index, end, '\n'); index = end - 1;
            if (++separators >= MAX_TEXT_BLOCKS) throw new RangeError('Rich text exceeds block limit');
        } else if (code === 10) {
            // The block builder accounts for the separator exactly once.
            if (++separators >= MAX_TEXT_BLOCKS) throw new RangeError('Rich text exceeds block limit');
        } else if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) { contentLength += 2; index++; }
            else { replace(index, index + 1, '\ufffd'); contentLength++; surrogates++; }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            replace(index, index + 1, '\ufffd'); contentLength++; surrogates++;
        } else if (code < 32 && code !== 9) {
            replace(index, index + 1, '\ufffd'); contentLength++; controls++;
        } else contentLength++;
        if (contentLength > limit) throw new RangeError('Rich text exceeds 1000000 UTF-16 units');
        if (index >= checkpoint) { checkpoint = index + 4096; yield; }
    }
    if (!pieces.length && !batch.length) return { text: value, surrogates, controls, contentLength };
    batch.push(value.slice(last));
    pieces.push(batch.join(''));
    return { text: pieces.join(''), surrogates, controls, contentLength };
}

/** Repair malformed legacy text; unknown carriers are not inspected or rewritten. */
export function repairLegacyCharacters(value: string, contentLimit = MAX_TEXT_LENGTH): RepairedText {
    const steps = repairSteps(value, contentLimit);
    for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

export async function repairLegacyCharactersCooperative(value: string, options: PlainTextOptions,
    contentLimit = MAX_TEXT_LENGTH): Promise<RepairedText> {
    const budget = options.sliceMilliseconds ?? 3;
    if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid text repair time slice');
    const steps = repairSteps(value, contentLimit);
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
