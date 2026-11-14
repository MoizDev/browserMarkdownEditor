import { textBoundaries } from './boundaries';
import { finishTextSteps, finishTextStepsCooperative } from './cooperative';
import { projectionSlice } from './projection';
import { deriveRichTextChangeSteps, type RichTextDiffOptions } from './richDiff';
import type { TextSpliceMap } from './rangeMap';
import type { RichText } from './richText';

const MAX_UNITS = 8192;
const MAX_TOKENS = 512;
const MAX_CELLS = 262_144;
const MAX_HUNKS = 256;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
interface Tokens { readonly values: string[]; readonly offsets: number[] }

function* tokenize(text: string): Generator<void, Tokens | null> {
    const values: string[] = [], offsets: number[] = [0];
    for (const part of graphemes.segment(text)) {
        values.push(part.segment); offsets.push(part.index + part.segment.length);
        if (values.length > MAX_TOKENS) return null;
        if ((values.length & 127) === 0) yield;
    }
    return { values, offsets };
}

/**
 * Find separated edits in a bounded changed window. Larger or adversarial diffs
 * fall back to one safe splice, so input cost and retained memory remain bounded.
 * Returned maps use evolving coordinates and can be applied in their given order.
 */
export function* deriveRichTextChangesSteps(before: RichText, after: RichText): Generator<void, readonly TextSpliceMap[]> {
    const change = yield* deriveRichTextChangeSteps(before, after);
    if (!change) return [];
    const oldLength = change.oldTo - change.from, newLength = change.newTo - change.from;
    if (oldLength > MAX_UNITS || newLength > MAX_UNITS) return [change.map];
    const oldText = projectionSlice(before, change.from, change.oldTo);
    const newText = projectionSlice(after, change.from, change.newTo);
    const old = yield* tokenize(oldText);
    const next = yield* tokenize(newText);
    if (!old || !next) return [change.map];
    const n = old.values.length, m = next.values.length, columns = m + 1, cells = (n + 1) * columns;
    if (cells > MAX_CELLS) return [change.map];
    const lcs = new Uint16Array(cells);
    let work = 0;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        const cell = i * columns + j;
        lcs[cell] = old.values[i] === next.values[j] ? 1 + lcs[(i + 1) * columns + j + 1]
            : Math.max(lcs[(i + 1) * columns + j], lcs[cell + 1]);
        if ((++work & 2047) === 0) yield;
    }
    let i = 0, j = 0, startOld = -1, startNew = -1, delta = 0, valid = true;
    const maps: TextSpliceMap[] = [];
    // Boundary proofs walk long blocks, so they yield like every other traversal here.
    // An expression, not a hoisted declaration: it keeps the narrowing of the const diff state.
    const flush = function* (): Generator<void, void> {
        if (startOld < 0) return;
        const oldFrom = change.from + old.offsets[startOld], oldTo = change.from + old.offsets[i];
        const newFrom = change.from + next.offsets[startNew], newTo = change.from + next.offsets[j];
        if (!(yield* textBoundaries.isBoundarySteps(before, oldFrom)) || !(yield* textBoundaries.isBoundarySteps(before, oldTo))
            || !(yield* textBoundaries.isBoundarySteps(after, newFrom)) || !(yield* textBoundaries.isBoundarySteps(after, newTo))) valid = false;
        const insertedLength = newTo - newFrom;
        maps.push({ from: oldFrom + delta, to: oldTo + delta, insertedLength });
        delta += insertedLength - (oldTo - oldFrom);
        startOld = startNew = -1;
    };
    while (i < n || j < m) {
        if (i < n && j < m && old.values[i] === next.values[j]) { yield* flush(); i++; j++; }
        else {
            if (startOld < 0) { startOld = i; startNew = j; }
            if (i < n && (j === m || lcs[(i + 1) * columns + j] >= lcs[i * columns + j + 1])) i++;
            else j++;
        }
        if (maps.length > MAX_HUNKS) return [change.map];
        if ((++work & 255) === 0) yield;
    }
    yield* flush();
    return valid && maps.length <= MAX_HUNKS ? maps : [change.map];
}

export function deriveRichTextChanges(before: RichText, after: RichText): readonly TextSpliceMap[] {
    return finishTextSteps(deriveRichTextChangesSteps(before, after));
}
export function deriveRichTextChangesCooperative(before: RichText, after: RichText, options: RichTextDiffOptions): Promise<readonly TextSpliceMap[]> {
    return finishTextStepsCooperative(deriveRichTextChangesSteps(before, after), options);
}
