import type { RawJson } from '../model/json';
import { blockTextLength, isBlockRange } from '../model/textOffsets';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';

// text.md §4.1: immutable values; UTF-16 offsets refer to the plain-text projection.
export interface RichText { readonly blocks: readonly Block[] }
export type RichFragment = RichText;

export interface Block {
    readonly kind: 'p' | 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    readonly level: number;
    readonly start?: number;
    readonly dir: 'auto' | 'ltr' | 'rtl';
    readonly runs: readonly Run[];
    readonly tail?: RawJson; // R-W19/R-W21: JSON ARRAY of trailing tuple elements; writer splices its interior.
}

export interface Run {
    readonly text: string;
    readonly marks: Marks;
    readonly tail?: RawJson; // R-W19/R-W21: JSON ARRAY of trailing tuple elements; TX-2 finalizes editing semantics.
}

export interface Marks {
    readonly b?: true;
    readonly i?: true;
    readonly u?: true;
    readonly s?: true;
    readonly code?: true;
    readonly hl?: true;
    readonly link?: string;
    readonly x?: RawJson; // R-W25: unknown marks use the same opaque preservation channel.
}

export const EMPTY_RICH_TEXT: RichText = {
    blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }],
};

export class RichTextLimitError extends RangeError {}

function sameMarks(a: Marks, b: Marks): boolean {
    return a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.code === b.code
        && a.hl === b.hl && a.link === b.link && a.x === b.x;
}
function opaqueRun(run: Run): boolean { return run.tail !== undefined || run.marks.x !== undefined; }

function normalizedRuns(runs: readonly Run[]): readonly Run[] {
    let output: Run[] | undefined;
    for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run.text.length === 0 && runs.length > 1 && !opaqueRun(run)) {
            if (!output) output = runs.slice(0, i);
            continue;
        }
        const before = output ? output[output.length - 1] : runs[i - 1];
        // Unknown tuple/mark meaning can depend on run boundaries. Never discard
        // opaque metadata just because its known drawing marks happen to match.
        if (before && !opaqueRun(before) && !opaqueRun(run) && sameMarks(before.marks, run.marks)) {
            if (!output) output = runs.slice(0, i);
            output[output.length - 1] = { text: before.text + run.text, marks: before.marks };
        } else if (output) output.push(run);
    }
    return output ? output.length ? output : [runs[0]] : runs;
}

export function normalizeRichText(text: RichText): RichText {
    let blocks: Block[] | undefined;
    for (let i = 0; i < text.blocks.length; i++) {
        const block = text.blocks[i];
        const runs = normalizedRuns(block.runs);
        if (runs !== block.runs && !blocks) blocks = text.blocks.slice(0, i);
        if (blocks) blocks.push(runs === block.runs ? block : { ...block, runs });
    }
    return blocks ? { blocks } : text;
}

interface TextPoint { readonly block: number; readonly offset: number; readonly start: number }
function locate(text: RichText, offset: number): TextPoint {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid rich-text offset');
    let start = 0;
    for (let i = 0; i < text.blocks.length; i++) {
        const length = blockTextLength(text.blocks[i]);
        if (offset <= start + length) return { block: i, offset: offset - start, start };
        start += length + 1;
    }
    throw new RangeError('Rich-text offset exceeds its projection');
}

function sliceRuns(block: Block, from: number, to: number, keepEndAnchors: boolean): Run[] {
    const runs: Run[] = [];
    let position = 0;
    for (let i = 0; i < block.runs.length; i++) {
        const run = block.runs[i];
        const end = position + run.text.length;
        if (run.text.length === 0) {
            if (position >= from && (position < to || (keepEndAnchors && position === to))) runs.push(run);
        } else {
            const startInRun = Math.max(0, from - position);
            const endInRun = Math.min(run.text.length, to - position);
            if (startInRun < endInRun) runs.push(startInRun === 0 && endInRun === run.text.length
                ? run : { ...run, text: run.text.slice(startInRun, endInRun) });
        }
        position = end;
    }
    return runs;
}
function emptyRun(block: Block, offset: number): Run {
    let position = 0;
    for (let i = 0; i < block.runs.length; i++) {
        const run = block.runs[i];
        position += run.text.length;
        if (position >= offset) return run.text.length === 0 ? run : { ...run, text: '' };
    }
    return { text: '', marks: {} };
}

export function sliceRichText(text: RichText, from: number, to: number): RichFragment {
    if (to < from) throw new RangeError('Reversed rich-text slice');
    const first = locate(text, from);
    const last = locate(text, to);
    const blocks: Block[] = [];
    for (let i = first.block; i <= last.block; i++) {
        const block = text.blocks[i];
        const start = i === first.block ? first.offset : 0;
        const end = i === last.block ? last.offset : blockTextLength(block);
        const runs = sliceRuns(block, start, end, from === to);
        blocks.push({ ...block, runs: runs.length ? runs : [emptyRun(block, start)] });
    }
    return { blocks };
}

export interface RichSpliceResult {
    readonly text: RichText;
    readonly inverse: { readonly from: number; readonly to: number; readonly insert: RichFragment; readonly wholeBlocks: true };
    readonly before: readonly Block[];
    readonly after: readonly Block[];
}

// CH-1/R-W32: inverse splices widen to boundary blocks, retaining their original
// references, not copying whole strings or assigning a saved whole RichText value.
// wholeBlocks distinguishes replacement of an empty block from ordinary insertion
// into it; without that explicit mode opaque zero-length runs would duplicate.
export function spliceRichText(text: RichText, from: number, to: number, insert: RichFragment, wholeBlocks = false): RichSpliceResult {
    if (to < from || insert.blocks.length === 0) throw new RangeError('Invalid rich splice');
    const first = locate(text, from);
    const last = locate(text, to);
    if (wholeBlocks && !isBlockRange(text, from, to)) throw new RangeError('Whole-block splice is not block-aligned');
    const count = text.blocks.length - (last.block - first.block + 1) + insert.blocks.length;
    if (count > MAX_TEXT_BLOCKS) throw new RichTextLimitError('Rich text exceeds 100000 blocks');
    const before = text.blocks.slice(first.block, last.block + 1);
    let after: readonly Block[];
    if (wholeBlocks) after = insert.blocks; // Exact history/rollback snapshot, already validated.
    else {
        const startBlock = text.blocks[first.block];
        const endBlock = text.blocks[last.block];
        const prefix = sliceRuns(startBlock, 0, first.offset, false);
        const suffix = sliceRuns(endBlock, last.offset, blockTextLength(endBlock), from === to);
        const blocks: Block[] = [];
        for (let i = 0; i < insert.blocks.length; i++) {
            const fragment = insert.blocks[i];
            const runs = [...(i === 0 ? prefix : []), ...fragment.runs, ...(i + 1 === insert.blocks.length ? suffix : [])];
            // Existing first-block attributes live outside the replaced character
            // range. Newline-bearing fragment blocks carry their own attributes.
            blocks.push({ ...(i === 0 ? startBlock : fragment), runs });
        }
        after = normalizeRichText({ blocks }).blocks;
    }
    let length = text.blocks.length - before.length + after.length - 1;
    let segmentLength = after.length - 1;
    for (let i = 0; i < after.length; i++) segmentLength += blockTextLength(after[i]);
    for (let i = 0; i < text.blocks.length; i++) {
        if (i < first.block || i > last.block) length += blockTextLength(text.blocks[i]);
    }
    length += segmentLength - (after.length - 1);
    if (length > MAX_TEXT_LENGTH) throw new RichTextLimitError('Rich text exceeds 1000000 UTF-16 units');
    const blocks = [...text.blocks.slice(0, first.block), ...after, ...text.blocks.slice(last.block + 1)];
    return {
        text: { blocks }, before, after,
        inverse: { from: first.start, to: first.start + segmentLength, insert: { blocks: before }, wholeBlocks: true },
    };
}
