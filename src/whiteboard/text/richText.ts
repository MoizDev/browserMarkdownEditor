import type { RawJson } from '../model/json';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { inheritProjectionSteps, projectionLength, projectionPosition } from './projection';
import { inheritWordBoundaries, textBoundaries } from './boundaries';
import { blockOccurrenceOrigin, carrierForTail, carrierOccurrence, carrierSource, coalesceCarrierSteps, mapCarrier, mapCarrierIdentity, runOccurrenceOrigin, runOrigin, sliceCarrierSteps, trackBlock, trackBlockIdentity, trackRunIdentity } from './carriers';
import { firstRunAt, runContaining, runIndex, runIndexSteps } from './runIndex';
import type { PlainTextOptions } from './plainText';
import { finishTextSteps, finishTextStepsCooperative } from './cooperative';

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
    /** Semantic only for ol; a future tuple tail may retain this otherwise inert slot. */
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

function sameMarks(a: Marks, b: Marks): boolean {
    return a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.code === b.code
        && a.hl === b.hl && a.link === b.link && a.x === b.x;
}
function opaqueRun(run: Run): boolean { return run.tail !== undefined || run.marks.x !== undefined; }

function* normalizedRunsSteps(runs: readonly Run[]): Generator<void, readonly Run[]> {
    let previous: Run | undefined, changed = false, visited = 0;
    for (const run of runs) {
        if ((++visited & 255) === 0) yield;
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
        if ((++visited & 255) === 0) yield;
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
export function* normalizeRichTextSteps(text: RichText): Generator<void, RichText> {
    if (!text.blocks.length) return EMPTY_RICH_TEXT;
    let blocks: Block[] | undefined;
    for (let i = 0; i < text.blocks.length; i++) {
        if ((i & 255) === 255) yield;
        const block = text.blocks[i];
        let normalized = normalizedBlocks.get(block);
        if (!normalized) {
            const runs = block.runs.length ? (yield* normalizedRunsSteps(block.runs)) : [{ text: '', marks: {} }];
            normalized = runs === block.runs ? block : trackBlock({ ...block, runs }, block);
            normalizedBlocks.set(block, normalized);
            normalizedBlocks.set(normalized, normalized);
        }
        if (normalized !== block && !blocks) blocks = text.blocks.slice(0, i);
        if (blocks) blocks.push(normalized);
    }
    return blocks ? { blocks } : text;
}

export function normalizeRichText(text: RichText): RichText {
    return finishTextSteps(normalizeRichTextSteps(text));
}

/** Large imported fragments can normalize without retaining partially published output. */
export function normalizeRichTextCooperative(text: RichText, options: PlainTextOptions): Promise<RichText> {
    return finishTextStepsCooperative(normalizeRichTextSteps(text), options);
}

interface TextPoint { readonly block: number; readonly offset: number; readonly start: number }
function locate(text: RichText, offset: number): TextPoint {
    const point = projectionPosition(text, offset);
    return { block: point.index, offset: point.offset, start: point.start };
}

function slicedRun(run: Run, text: string, origin?: object): Run {
    if (!origin) return text === run.text && !opaqueRun(run) ? run : { ...run, text };
    // A shared source object may represent independent occurrences, so never
    // attach occurrence identity by mutating the source object's WeakMap entry.
    return trackRunIdentity({ ...run, text }, origin);
}
function* sliceRunSteps(text: RichText, blockIndex: number, from: number, to: number, keepEndAnchors: boolean, preserveOrigin: boolean): Generator<void, Run[]> {
    const block = text.blocks[blockIndex], runs: Run[] = [];
    const indexed = yield* runIndexSteps(block);
    let visited = 0;
    for (let i = firstRunAt(indexed, from); i < block.runs.length; i++) {
        if ((++visited & 255) === 0) yield;
        const run = block.runs[i], position = indexed.starts[i];
        if (position > to || (position === to && run.text.length > 0)) break;
        const origin = preserveOrigin && opaqueRun(run) ? runOccurrenceOrigin(text, blockIndex, i) : undefined;
        if (run.text.length === 0) {
            if (position >= from && (position < to || (keepEndAnchors && position === to))) runs.push(slicedRun(run, '', origin));
        } else {
            const startInRun = Math.max(0, from - position);
            const endInRun = Math.min(run.text.length, to - position);
            if (startInRun < endInRun) runs.push(slicedRun(run, run.text.slice(startInRun, endInRun), origin));
        }
    }
    return runs;
}
function emptyRun(text: RichText, blockIndex: number, offset: number, preserveOrigin: boolean): Run {
    const block = text.blocks[blockIndex], indexed = runIndex(block);
    if (!indexed.count) return { text: '', marks: {} };
    const index = offset > 0 ? runContaining(indexed, offset - 1) : 0, run = block.runs[index];
    const origin = preserveOrigin && opaqueRun(run) ? runOccurrenceOrigin(text, blockIndex, index) : undefined;
    return slicedRun(run, '', origin);
}

function* sliceSteps(text: RichText, from: number, to: number, preserveOrigins: boolean): Generator<void, RichFragment> {
    if (to < from || !(yield* textBoundaries.isBoundarySteps(text, from)) || !(yield* textBoundaries.isBoundarySteps(text, to)))
        throw new RangeError('Rich-text slice must use grapheme boundaries');
    const first = locate(text, from);
    const last = locate(text, to);
    if (from === to) {
        const source = text.blocks[first.block], run = emptyRun(text, first.block, first.offset, false);
        const { tail: _tail, carriers: _carriers, ...block } = source;
        const { x: _x, ...marks } = run.marks;
        // A caret contains no unknown data to copy; the original anchors stay in place.
        return { blocks: [{ ...block, runs: [{ text: '', marks }] }] };
    }
    const blocks: Block[] = [];
    for (let i = first.block; i <= last.block; i++) {
        if (((i - first.block) & 255) === 255) yield;
        const block = text.blocks[i];
        const start = i === first.block ? first.offset : 0;
        const end = i === last.block ? last.offset : (yield* runIndexSteps(block)).length;
        const runs = yield* sliceRunSteps(text, i, start, end, from === to, preserveOrigins);
        const { carriers: _carriers, ...base } = block;
        const carriers = yield* sliceCarrierSteps(block, start, end, preserveOrigins, index => carrierOccurrence(text, i, index));
        const sliced: Block = { ...base, runs: runs.length ? runs : [emptyRun(text, i, start, preserveOrigins)], ...(carriers ? { carriers } : {}) };
        blocks.push(preserveOrigins ? trackBlockIdentity(sliced, blockOccurrenceOrigin(text, i)) : sliced);
    }
    return { blocks };
}

export function sliceRichText(text: RichText, from: number, to: number, preserveOrigins = false): RichFragment {
    return finishTextSteps(sliceSteps(text, from, to, preserveOrigins));
}

/** A long selection can be captured cooperatively without publishing a partial fragment. */
export function sliceRichTextCooperative(text: RichText, from: number, to: number, options: PlainTextOptions,
    preserveOrigins = false): Promise<RichFragment> {
    return finishTextStepsCooperative(sliceSteps(text, from, to, preserveOrigins), options);
}

function* spliceCarrierSteps(text: RichText, firstIndex: number, before: readonly Block[], firstOffset: number, lastOffset: number,
    insert: RichFragment): Generator<void, readonly (readonly BlockCarrier[] | undefined)[]> {
    let sourceHasCarriers = false, insertedHasCarriers = false, work = 0;
    for (let index = 0; index < before.length; index++) {
        const block = before[index];
        if (block.carriers?.length || (index > 0 && block.tail !== undefined && block.tail !== '[]')) { sourceHasCarriers = true; break; }
        if ((++work & 255) === 0) yield;
    }
    for (let index = 0; index < insert.blocks.length; index++) {
        const block = insert.blocks[index];
        if (block.carriers?.length || (index === 0 && block.tail !== undefined && block.tail !== '[]')) { insertedHasCarriers = true; break; }
        if ((++work & 255) === 0) yield;
    }
    if (!sourceHasCarriers && !insertedHasCarriers) {
        const empty: undefined[] = [];
        for (let index = 0; index < insert.blocks.length; index++) { empty.push(undefined); if ((++work & 255) === 0) yield; }
        return empty;
    }
    const last = before.length - 1, output: BlockCarrier[][] = [];
    for (let index = 0; index < insert.blocks.length; index++) { output.push([]); if ((++work & 255) === 0) yield; }
    const lastOutput = output.length - 1;
    const suffixStart = (lastOutput === 0 ? firstOffset : 0) + (yield* runIndexSteps(insert.blocks[lastOutput])).length;
    const insertedSources = new Set<object>(), insertedTails = new Set<object>();
    for (let b = 0; b < insert.blocks.length; b++) {
        const block = insert.blocks[b];
        for (let c = 0; c < (block.carriers?.length ?? 0); c++) {
            insertedSources.add(carrierOccurrence(insert, b, c).source);
            if ((++work & 255) === 0) yield;
        }
        if ((++work & 255) === 0) yield;
        if (block.tail !== undefined && block.tail !== '[]') insertedTails.add(blockOccurrenceOrigin(insert, b));
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
        for (let c = 0; c < (block.carriers?.length ?? 0); c++) {
            const carrier = block.carriers![c];
            place(mapCarrierIdentity(carrier, carrier.from, carrier.to, carrierOccurrence(text, firstIndex + index, c)), index);
            if ((++work & 255) === 0) yield;
        }
        if ((++work & 255) === 0) yield;
        const origin = block.tail !== undefined && block.tail !== '[]' ? blockOccurrenceOrigin(text, firstIndex + index) : undefined;
        if (index > 0 && origin && !insertedTails.has(origin))
            place(carrierForTail(block, 0, (yield* runIndexSteps(block)).length, origin), index);
    }
    for (let index = 0; index < insert.blocks.length; index++) {
        const block = insert.blocks[index], offset = index === 0 ? firstOffset : 0;
        for (let c = 0; c < (block.carriers?.length ?? 0); c++) {
            const carrier = block.carriers![c];
            output[index].push(mapCarrierIdentity(carrier, offset + carrier.from, offset + carrier.to, carrierOccurrence(insert, index, c)));
            if ((++work & 255) === 0) yield;
        }
        if ((++work & 255) === 0) yield;
        if (index === 0 && block.tail !== undefined && block.tail !== '[]' && blockOccurrenceOrigin(insert, index) !== blockOccurrenceOrigin(text, firstIndex))
            output[0].push(carrierForTail(block, offset, offset + (yield* runIndexSteps(block)).length, blockOccurrenceOrigin(insert, index)));
    }
    const result: (readonly BlockCarrier[] | undefined)[] = [];
    for (const carriers of output) {
        result.push(yield* coalesceCarrierSteps(carriers));
        if ((++work & 255) === 0) yield;
    }
    return result;
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
export function* spliceRichTextSteps(text: RichText, from: number, to: number, insert: RichFragment,
    wholeBlocks = false): Generator<void, RichSpliceResult> {
    if (to < from || insert.blocks.length === 0 || !(yield* textBoundaries.isBoundarySteps(text, from))
        || !(yield* textBoundaries.isBoundarySteps(text, to))) throw new RangeError('Invalid rich splice or grapheme boundary');
    const first = locate(text, from);
    const last = locate(text, to);
    const lastLength = (yield* runIndexSteps(text.blocks[last.block])).length;
    if (wholeBlocks && (first.offset !== 0 || last.offset !== lastLength))
        throw new RangeError('Whole-block splice is not block-aligned');
    const count = text.blocks.length - (last.block - first.block + 1) + insert.blocks.length;
    if (count > MAX_TEXT_BLOCKS) throw new RichTextLimitError('Rich text exceeds 100000 blocks');
    const before = text.blocks.slice(first.block, last.block + 1);
    let after: readonly Block[];
    if (wholeBlocks) after = insert.blocks; // Exact history/rollback snapshot, already validated.
    else {
        const startBlock = text.blocks[first.block];
        const mappedCarriers = yield* spliceCarrierSteps(text, first.block, before, first.offset, last.offset, insert);
        const prefix = yield* sliceRunSteps(text, first.block, 0, first.offset, false, true);
        const suffix = yield* sliceRunSteps(text, last.block, last.offset, lastLength, from === to, true);
        const retained = new Set<object>();
        let work = 0;
        for (const run of prefix) { if (opaqueRun(run)) retained.add(runOrigin(run)); if ((++work & 255) === 0) yield; }
        for (const block of insert.blocks) {
            for (const run of block.runs) { if (opaqueRun(run)) retained.add(runOrigin(run)); if ((++work & 255) === 0) yield; }
            if ((++work & 255) === 0) yield;
        }
        for (const run of suffix) { if (opaqueRun(run)) retained.add(runOrigin(run)); if ((++work & 255) === 0) yield; }
        const anchors: Run[] = [];
        for (let b = 0; b < before.length; b++) {
            const block = before[b];
            const indexed = yield* runIndexSteps(block);
            const low = b === 0 ? first.offset : 0, high = b + 1 === before.length ? last.offset : indexed.length;
            for (let r = firstRunAt(indexed, low); r < indexed.count; r++) {
                const position = indexed.starts[r], run = block.runs[r];
                if (position > high || (position === high && run.text.length > 0)) break;
                if ((++work & 255) === 0) yield;
                if (!opaqueRun(run)) continue;
                const origin = runOccurrenceOrigin(text, first.block + b, r);
                if (!retained.has(origin)) { anchors.push(trackRunIdentity({ ...run, text: '' }, origin)); retained.add(origin); }
            }
            if ((++work & 255) === 0) yield;
        }
        const blocks: Block[] = [];
        for (let i = 0; i < insert.blocks.length; i++) {
            const fragment = insert.blocks[i], runs: Run[] = [];
            const groups: readonly (readonly Run[])[] = [i === 0 ? prefix : [], i === 0 ? anchors : [], fragment.runs,
                i + 1 === insert.blocks.length ? suffix : []];
            for (const group of groups) for (const run of group) {
                runs.push(run);
                if ((++work & 255) === 0) yield;
            }
            // Existing first-block attributes live outside the replaced character
            // range. Newline-bearing fragment blocks carry their own attributes.
            const base = i === 0 ? startBlock : fragment;
            const { carriers: _carriers, ...attributes } = base;
            const carriers = mappedCarriers[i];
            const next = { ...attributes, runs, ...(carriers ? { carriers } : {}) };
            blocks.push(trackBlockIdentity(next, i === 0 ? blockOccurrenceOrigin(text, first.block) : blockOccurrenceOrigin(insert, i)));
            if ((++work & 255) === 0) yield;
        }
        after = (yield* normalizeRichTextSteps({ blocks })).blocks;
    }
    let segmentLength = after.length - 1;
    for (let i = 0; i < after.length; i++) {
        segmentLength += (yield* runIndexSteps(after[i])).length;
        if ((i & 255) === 255) yield;
    }
    const replacedLength = last.start + lastLength - first.start;
    const length = projectionLength(text) - replacedLength + segmentLength;
    if (length > MAX_TEXT_LENGTH) throw new RichTextLimitError('Rich text exceeds 1000000 UTF-16 units');
    const blocks: Block[] = [];
    for (let i = 0; i < first.block; i++) { blocks.push(text.blocks[i]); if ((i & 255) === 255) yield; }
    for (let i = 0; i < after.length; i++) { blocks.push(after[i]); if ((i & 255) === 255) yield; }
    for (let i = last.block + 1; i < text.blocks.length; i++) { blocks.push(text.blocks[i]); if ((i & 255) === 255) yield; }
    const result = { blocks };
    yield* inheritProjectionSteps(text, result, first.block, before.length, after);
    inheritWordBoundaries(text, result, first.block, before.length, after.length);
    return {
        text: result, before, after,
        inverse: { from: first.start, to: first.start + segmentLength, insert: { blocks: before }, wholeBlocks: true },
    };
}

export function spliceRichText(text: RichText, from: number, to: number, insert: RichFragment, wholeBlocks = false): RichSpliceResult {
    return finishTextSteps(spliceRichTextSteps(text, from, to, insert, wholeBlocks));
}
export function spliceRichTextCooperative(text: RichText, from: number, to: number, insert: RichFragment,
    options: PlainTextOptions, wholeBlocks = false): Promise<RichSpliceResult> {
    return finishTextStepsCooperative(spliceRichTextSteps(text, from, to, insert, wholeBlocks), options);
}
