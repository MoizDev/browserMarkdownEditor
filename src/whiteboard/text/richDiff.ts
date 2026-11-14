import { textBoundaries } from './boundaries';
import { ensureProjectionSteps, projectionLength } from './projection';
import type { TextSpliceMap } from './rangeMap';
import type { RichText } from './richText';
import { finishTextSteps, finishTextStepsCooperative } from './cooperative';

/** Result coordinates are in the old and new projections, respectively. */
export interface RichTextChange {
    readonly from: number;
    readonly oldTo: number;
    readonly newTo: number;
    readonly map: TextSpliceMap;
}

function* pieces(text: RichText, reverse: boolean): Generator<string> {
    const blocks = text.blocks;
    if (!reverse) {
        for (let b = 0; b < blocks.length; b++) {
            if (b) yield '\n';
            for (const run of blocks[b].runs) yield run.text;
        }
    } else {
        for (let b = blocks.length - 1; b >= 0; b--) {
            if (b + 1 < blocks.length) yield '\n';
            const runs = blocks[b].runs;
            for (let r = runs.length - 1; r >= 0; r--) yield runs[r].text;
        }
    }
}

// Compare bounded pieces without flattening either document or allocating a
// grapheme array. Yielding also counts empty runs, not just text units.
function* common(before: RichText, after: RichText, reverse: boolean, limit: number): Generator<void, number> {
    const left = pieces(before, reverse), right = pieces(after, reverse);
    let a = '', b = '', ai = 0, bi = 0, count = 0, visits = 0;
    while (count < limit) {
        while (ai === a.length) {
            const next = left.next();
            if (next.done) return count;
            a = next.value; ai = 0;
            if ((++visits & 255) === 0) yield;
        }
        while (bi === b.length) {
            const next = right.next();
            if (next.done) return count;
            b = next.value; bi = 0;
            if ((++visits & 255) === 0) yield;
        }
        const size = Math.min(a.length - ai, b.length - bi, limit - count, 4096);
        let matched = 0;
        if (ai === bi && a === b) matched = size;
        else for (; matched < size; matched++) {
            const ac = a.charCodeAt(reverse ? a.length - 1 - ai - matched : ai + matched);
            const bc = b.charCodeAt(reverse ? b.length - 1 - bi - matched : bi + matched);
            if (ac !== bc) break;
        }
        count += matched; ai += matched; bi += matched;
        if (matched !== size) return count;
        yield;
    }
    return count;
}

/**
 * The smallest common UTF-16 prefix/suffix is widened together until both old
 * and new endpoints are grapheme boundaries. This handles combining marks,
 * regional indicators, and a CR followed by a projected block separator.
 */
export function* deriveRichTextChangeSteps(before: RichText, after: RichText): Generator<void, RichTextChange | null> {
    if (before === after) return null;
    yield* ensureProjectionSteps(before);
    yield* ensureProjectionSteps(after);
    const oldLength = projectionLength(before), newLength = projectionLength(after);
    const limit = Math.min(oldLength, newLength);
    let from = yield* common(before, after, false, limit);
    if (from === oldLength && from === newLength) return null;
    const suffix = yield* common(before, after, true, Math.min(oldLength - from, newLength - from));
    let oldTo = oldLength - suffix, newTo = newLength - suffix;
    for (;;) {
        const oldStart = yield* textBoundaries.snapSteps(before, from, -1);
        const newStart = yield* textBoundaries.snapSteps(after, from, -1);
        const next = Math.min(oldStart, newStart);
        if (next === from) break;
        from = next;
        yield;
    }
    for (;;) {
        const oldEnd = yield* textBoundaries.snapSteps(before, oldTo, 1);
        const newEnd = yield* textBoundaries.snapSteps(after, newTo, 1);
        const extra = Math.max(oldEnd - oldTo, newEnd - newTo);
        if (!extra) break;
        oldTo += extra; newTo += extra;
        if (oldTo > oldLength || newTo > newLength) throw new RangeError('Cannot align text change boundaries');
        yield;
    }
    return { from, oldTo, newTo, map: { from, to: oldTo, insertedLength: newTo - from } };
}

/** Synchronous form for small changes and callers already inside a transaction. */
export function deriveRichTextChange(before: RichText, after: RichText): RichTextChange | null {
    return finishTextSteps(deriveRichTextChangeSteps(before, after));
}

export interface RichTextDiffOptions {
    readonly signal?: AbortSignal;
    /** Must yield to the host scheduler; called between bounded comparison batches. */
    readonly cooperate: () => Promise<void>;
    readonly sliceMilliseconds?: number;
}

/** Long external changes can share the same algorithm without monopolizing a frame. */
export function deriveRichTextChangeCooperative(before: RichText, after: RichText, options: RichTextDiffOptions): Promise<RichTextChange | null> {
    return finishTextStepsCooperative(deriveRichTextChangeSteps(before, after), options);
}
