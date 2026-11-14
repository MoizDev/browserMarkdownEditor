import type { RawJson } from '../model/json';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { inheritProjection, projectionLength, projectionPosition } from './projection';
import { blockOrigin, carrierForTail, carrierSource, coalesceCarriers, mapCarrier, runOrigin, sliceCarriers, trackBlock, trackRun } from './carriers';
import { firstRunAt, runContaining, runIndex } from './runIndex';

// text.md §4.1: immutable values; UTF-16 offsets refer to the plain-text projection.
export interface RichText { readonly blocks: readonly Block[] }
export type RichFragment = RichText;

export interface BlockCarrier {
    readonly from: number;
    readonly to: number;
    readonly kind: Block['kind'];
    readonly level: number;
    readonly dir: Block['dir'];
    readonly start?: number;
    readonly tail: RawJson;
}

export interface Block {
    readonly kind: 'p' | 'ul' | 'ol' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    readonly level: number;
    readonly start?: number;
    readonly dir: 'auto' | 'ltr' | 'rtl';
    readonly runs: readonly Run[];
    readonly tail?: RawJson; // R-W19/R-W21: JSON ARRAY of trailing tuple elements; writer splices its interior.
    readonly carriers?: readonly BlockCarrier[];
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

const blockTextLength = (block: Block): number => runIndex(block).length;

function sameMarks(a: Marks, b: Marks): boolean {
    return a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.code === b.code
        && a.hl === b.hl && a.link === b.link && a.x === b.x;
}
function opaqueRun(run: Run): boolean { return run.tail !== undefined || run.marks.x !== undefined; }

function normalizedRuns(runs: readonly Run[]): readonly Run[] {
    let previous: Run | undefined, changed = false;
    for (const run of runs) {
        if (!run.text.length && runs.length > 1 && !opaqueRun(run)) { changed = true; continue; }
        if (previous && !opaqueRun(previous) && !opaqueRun(run) && sameMarks(previous.marks, run.marks)) changed = true;
        previous = run;
    }
    if (!changed) return runs;
    const output: Run[] = [];
    let pending: Run | undefined, parts: string[] = [];
    const flush = () => {
        if (!pending) return;
        output.push(parts.length === 1 ? pending : { text: parts.join(''), marks: pending.marks });
        pending = undefined; parts = [];
    };
    for (const run of runs) {
        if (!run.text.length && runs.length > 1 && !opaqueRun(run)) continue;
        // Unknown tuple/mark meaning can depend on the original run boundary.
        if (opaqueRun(run)) { flush(); output.push(run); }
        else if (pending && sameMarks(pending.marks, run.marks)) parts.push(run.text);
        else { flush(); pending = run; parts = [run.text]; }
    }
    flush();
    return output.length ? output : [runs[0]];
}

const normalizedBlocks = new WeakMap<Block, Block>();
function normalizedBlock(block: Block): Block {
    const cached = normalizedBlocks.get(block);
    if (cached) return cached;
    const runs = block.runs.length ? normalizedRuns(block.runs) : [{ text: '', marks: {} }];
    const result = runs === block.runs ? block : trackBlock({ ...block, runs }, block);
    normalizedBlocks.set(block, result);
    normalizedBlocks.set(result, result);
    return result;
}

export function normalizeRichText(text: RichText): RichText {
    if (!text.blocks.length) return EMPTY_RICH_TEXT;
    let blocks: Block[] | undefined;
    for (let i = 0; i < text.blocks.length; i++) {
        const block = text.blocks[i], normalized = normalizedBlock(block);
        if (normalized !== block && !blocks) blocks = text.blocks.slice(0, i);
        if (blocks) blocks.push(normalized);
    }
    return blocks ? { blocks } : text;
}

interface TextPoint { readonly block: number; readonly offset: number; readonly start: number }
function locate(text: RichText, offset: number): TextPoint {
    const point = projectionPosition(text, offset);
    return { block: point.index, offset: point.offset, start: point.start };
}

function slicedRun(run: Run, text: string, preserveOrigin: boolean): Run {
    const result = preserveOrigin && text === run.text ? run : { ...run, text };
    return preserveOrigin && opaqueRun(run) ? trackRun(result, run) : result;
}
function sliceRuns(block: Block, from: number, to: number, keepEndAnchors: boolean, preserveOrigin: boolean): Run[] {
    const runs: Run[] = [], indexed = runIndex(block);
    for (let i = firstRunAt(indexed, from); i < block.runs.length; i++) {
        const run = block.runs[i], position = indexed.starts[i], end = indexed.starts[i + 1];
        if (position > to || (position === to && run.text.length > 0)) break;
        if (run.text.length === 0) {
            if (position >= from && (position < to || (keepEndAnchors && position === to))) runs.push(slicedRun(run, '', preserveOrigin));
        } else {
            const startInRun = Math.max(0, from - position);
            const endInRun = Math.min(run.text.length, to - position);
            if (startInRun < endInRun) runs.push(slicedRun(run, run.text.slice(startInRun, endInRun), preserveOrigin));
        }
    }
    return runs;
}
function emptyRun(block: Block, offset: number, preserveOrigin: boolean): Run {
    const indexed = runIndex(block);
    if (!indexed.count) return { text: '', marks: {} };
    const index = offset > 0 ? runContaining(indexed, offset - 1) : 0;
    return slicedRun(block.runs[index], '', preserveOrigin);
}

export function sliceRichText(text: RichText, from: number, to: number, preserveOrigins = false): RichFragment {
    if (to < from) throw new RangeError('Reversed rich-text slice');
    const first = locate(text, from);
    const last = locate(text, to);
    const blocks: Block[] = [];
    for (let i = first.block; i <= last.block; i++) {
        const block = text.blocks[i];
        const start = i === first.block ? first.offset : 0;
        const end = i === last.block ? last.offset : blockTextLength(block);
        const runs = sliceRuns(block, start, end, from === to, preserveOrigins);
        const { carriers: _carriers, ...base } = block;
        const carriers = sliceCarriers(block, start, end, preserveOrigins);
        const sliced: Block = { ...base, runs: runs.length ? runs : [emptyRun(block, start, preserveOrigins)], ...(carriers ? { carriers } : {}) };
        blocks.push(preserveOrigins ? trackBlock(sliced, block) : sliced);
    }
    return { blocks };
}

function spliceCarriers(before: readonly Block[], firstOffset: number, lastOffset: number, insert: RichFragment): readonly (readonly BlockCarrier[] | undefined)[] {
    const sourceHasCarriers = before.some((block, index) => !!block.carriers?.length || (index > 0 && block.tail !== undefined && block.tail !== '[]'));
    const insertedHasCarriers = insert.blocks.some((block, index) => !!block.carriers?.length || (index === 0 && block.tail !== undefined && block.tail !== '[]'));
    if (!sourceHasCarriers && !insertedHasCarriers) return insert.blocks.map(() => undefined);
    const last = before.length - 1, output = insert.blocks.map(() => [] as BlockCarrier[]);
    const lastOutput = output.length - 1;
    const suffixStart = (lastOutput === 0 ? firstOffset : 0) + blockTextLength(insert.blocks[lastOutput]);
    const insertedSources = new Set<object>(), insertedTails = new Set<object>();
    for (const block of insert.blocks) {
        for (const carrier of block.carriers ?? []) insertedSources.add(carrierSource(carrier));
        if (block.tail !== undefined && block.tail !== '[]') insertedTails.add(blockOrigin(block));
    }
    const place = (carrier: BlockCarrier, blockIndex: number) => {
        let retained = false;
        if (carrier.from === carrier.to) {
            if (blockIndex === 0 && carrier.from < firstOffset) {
                output[0].push(mapCarrier(carrier, carrier.from, carrier.to)); retained = true;
            } else if (blockIndex === last && carrier.from >= lastOffset) {
                const offset = suffixStart + carrier.from - lastOffset;
                output[lastOutput].push(mapCarrier(carrier, offset, offset)); retained = true;
            }
        } else {
            if (blockIndex === 0) {
                const end = Math.min(carrier.to, firstOffset);
                if (carrier.from < end) { output[0].push(mapCarrier(carrier, carrier.from, end)); retained = true; }
            }
            if (blockIndex === last) {
                const start = Math.max(carrier.from, lastOffset);
                if (start < carrier.to) {
                    output[lastOutput].push(mapCarrier(carrier, suffixStart + start - lastOffset, suffixStart + carrier.to - lastOffset));
                    retained = true;
                }
            }
        }
        if (!retained && !insertedSources.has(carrierSource(carrier)))
            output[0].push(mapCarrier(carrier, firstOffset, firstOffset));
    };
    for (let index = 0; index < before.length; index++) {
        const block = before[index];
        for (const carrier of block.carriers ?? []) place(carrier, index);
        if (index > 0 && block.tail !== undefined && block.tail !== '[]' && !insertedTails.has(blockOrigin(block)))
            place(carrierForTail(block, 0, blockTextLength(block)), index);
    }
    for (let index = 0; index < insert.blocks.length; index++) {
        const block = insert.blocks[index], offset = index === 0 ? firstOffset : 0;
        for (const carrier of block.carriers ?? []) output[index].push(mapCarrier(carrier, offset + carrier.from, offset + carrier.to));
        if (index === 0 && block.tail !== undefined && block.tail !== '[]' && blockOrigin(block) !== blockOrigin(before[0]))
            output[0].push(carrierForTail(block, offset, offset + blockTextLength(block)));
    }
    return output.map(coalesceCarriers);
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
    if (wholeBlocks && (first.offset !== 0 || last.offset !== blockTextLength(text.blocks[last.block])))
        throw new RangeError('Whole-block splice is not block-aligned');
    const count = text.blocks.length - (last.block - first.block + 1) + insert.blocks.length;
    if (count > MAX_TEXT_BLOCKS) throw new RichTextLimitError('Rich text exceeds 100000 blocks');
    const before = text.blocks.slice(first.block, last.block + 1);
    let after: readonly Block[];
    if (wholeBlocks) after = insert.blocks; // Exact history/rollback snapshot, already validated.
    else {
        const startBlock = text.blocks[first.block];
        const endBlock = text.blocks[last.block];
        const mappedCarriers = spliceCarriers(before, first.offset, last.offset, insert);
        const prefix = sliceRuns(startBlock, 0, first.offset, false, true);
        const suffix = sliceRuns(endBlock, last.offset, blockTextLength(endBlock), from === to, true);
        const retained = new Set<object>();
        for (const run of prefix) if (opaqueRun(run)) retained.add(runOrigin(run));
        for (const block of insert.blocks) for (const run of block.runs) if (opaqueRun(run)) retained.add(runOrigin(run));
        for (const run of suffix) if (opaqueRun(run)) retained.add(runOrigin(run));
        const anchors: Run[] = [];
        for (const block of before) for (const run of block.runs) {
            if (!opaqueRun(run)) continue;
            const origin = runOrigin(run);
            if (!retained.has(origin)) { anchors.push(trackRun({ ...run, text: '' }, run)); retained.add(origin); }
        }
        const blocks: Block[] = [];
        for (let i = 0; i < insert.blocks.length; i++) {
            const fragment = insert.blocks[i];
            const runs = [...(i === 0 ? prefix : []), ...(i === 0 ? anchors : []), ...fragment.runs, ...(i + 1 === insert.blocks.length ? suffix : [])];
            // Existing first-block attributes live outside the replaced character
            // range. Newline-bearing fragment blocks carry their own attributes.
            const base = i === 0 ? startBlock : fragment;
            const { carriers: _carriers, ...attributes } = base;
            const carriers = mappedCarriers[i];
            blocks.push(trackBlock({ ...attributes, runs, ...(carriers ? { carriers } : {}) }, base));
        }
        after = normalizeRichText({ blocks }).blocks;
    }
    let segmentLength = after.length - 1;
    for (let i = 0; i < after.length; i++) segmentLength += blockTextLength(after[i]);
    const replacedLength = last.start + blockTextLength(text.blocks[last.block]) - first.start;
    const length = projectionLength(text) - replacedLength + segmentLength;
    if (length > MAX_TEXT_LENGTH) throw new RichTextLimitError('Rich text exceeds 1000000 UTF-16 units');
    const blocks = [...text.blocks.slice(0, first.block), ...after, ...text.blocks.slice(last.block + 1)];
    const result = { blocks };
    inheritProjection(text, result, first.block, before.length, after);
    return {
        text: result, before, after,
        inverse: { from: first.start, to: first.start + segmentLength, insert: { blocks: before }, wholeBlocks: true },
    };
}
