import type { Block, BlockCarrier, RichText, Run } from './richText';

// Independent future tails stay byte-exact as range carriers, never concatenated positional fields.
const carrierOrigins = new WeakMap<BlockCarrier, object>();
const carrierSources = new WeakMap<BlockCarrier, object>();
const blockOrigins = new WeakMap<Block, object>();
const blockOccurrences = new WeakMap<RichText, Map<number, object>>();
const blockClaims = new WeakMap<RichText, WeakMap<Block, number>>();
const runOrigins = new WeakMap<Run, object>();
const runOccurrences = new WeakMap<RichText, Map<number, Map<number, object>>>();
const runClaims = new WeakMap<RichText, WeakMap<Run, { readonly block: number; readonly index: number }>>();
export const carrierOrigin = (carrier: BlockCarrier): object => carrierOrigins.get(carrier) ?? carrier;
export const carrierSource = (carrier: BlockCarrier): object => carrierSources.get(carrier) ?? carrier;
export const blockOrigin = (block: Block): object => {
    let origin = blockOrigins.get(block);
    if (!origin) { origin = {}; blockOrigins.set(block, origin); }
    return origin;
};
export function blockOccurrenceOrigin(text: RichText, index: number): object {
    let occurrences = blockOccurrences.get(text);
    if (!occurrences) { occurrences = new Map(); blockOccurrences.set(text, occurrences); }
    let origin = occurrences.get(index);
    if (!origin) {
        const block = text.blocks[index], tracked = blockOrigins.get(block);
        if (tracked) {
            let claims = blockClaims.get(text);
            if (!claims) { claims = new WeakMap(); blockClaims.set(text, claims); }
            const claim = claims.get(block);
            if (claim === undefined) { claims.set(block, index); origin = tracked; }
            else origin = claim === index ? tracked : {};
        } else origin = {};
        occurrences.set(index, origin);
    }
    return origin;
}
export function trackBlockIdentity(block: Block, origin: object): Block {
    blockOrigins.set(block, origin);
    return block;
}
export function trackBlock(block: Block, origin: Block): Block {
    return trackBlockIdentity(block, blockOrigin(origin));
}
export function runOrigin(run: Run): object { return runOrigins.get(run) ?? run; }
/** An untracked run can appear more than once by object identity; occurrences remain independent. */
export function runOccurrenceOrigin(text: RichText, blockIndex: number, runIndex: number): object {
    let blocks = runOccurrences.get(text);
    if (!blocks) { blocks = new Map(); runOccurrences.set(text, blocks); }
    let runs = blocks.get(blockIndex);
    if (!runs) { runs = new Map(); blocks.set(blockIndex, runs); }
    let origin = runs.get(runIndex);
    if (!origin) {
        const run = text.blocks[blockIndex].runs[runIndex], tracked = runOrigins.get(run);
        if (tracked) {
            let claims = runClaims.get(text);
            if (!claims) { claims = new WeakMap(); runClaims.set(text, claims); }
            const claim = claims.get(run);
            if (!claim) { claims.set(run, { block: blockIndex, index: runIndex }); origin = tracked; }
            else origin = claim.block === blockIndex && claim.index === runIndex ? tracked : {};
        } else origin = {};
        runs.set(runIndex, origin);
    }
    return origin;
}
export function trackRunIdentity(run: Run, origin: object): Run {
    runOrigins.set(run, origin);
    return run;
}
export function trackRun(run: Run, origin: Run): Run {
    return trackRunIdentity(run, runOrigin(origin));
}
export function mapCarrier(carrier: BlockCarrier, from: number, to: number, preserveOrigin = true): BlockCarrier {
    const mapped: BlockCarrier = { ...carrier, from, to };
    if (preserveOrigin) {
        carrierOrigins.set(mapped, carrierOrigin(carrier));
        carrierSources.set(mapped, carrierSource(carrier));
    }
    return mapped;
}
export function carrierForTail(block: Block, from: number, to: number, origin = blockOrigin(block)): BlockCarrier {
    if (block.tail === undefined) throw new Error('A block carrier requires a tail');
    const carrier: BlockCarrier = { from, to, kind: block.kind, level: block.level, dir: block.dir,
        ...(block.start !== undefined ? { start: block.start } : {}), tail: block.tail };
    carrierOrigins.set(carrier, origin);
    return carrier;
}
export function* sliceCarrierSteps(block: Block, from: number, to: number, preserveOrigin: boolean): Generator<void, readonly BlockCarrier[] | undefined> {
    const result: BlockCarrier[] = [];
    let visited = 0;
    for (const carrier of block.carriers ?? []) {
        if ((++visited & 255) === 0) yield;
        if (carrier.from === carrier.to) {
            if (carrier.from >= from && carrier.from <= to) result.push(mapCarrier(carrier, carrier.from - from, carrier.to - from, preserveOrigin));
        } else {
            const start = Math.max(from, carrier.from), end = Math.min(to, carrier.to);
            if (start < end) result.push(mapCarrier(carrier, start - from, end - from, preserveOrigin));
        }
    }
    return result.length ? result : undefined;
}
export function sliceCarriers(block: Block, from: number, to: number, preserveOrigin: boolean): readonly BlockCarrier[] | undefined {
    const steps = sliceCarrierSteps(block, from, to, preserveOrigin);
    for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
export function coalesceCarriers(carriers: readonly BlockCarrier[]): readonly BlockCarrier[] | undefined {
    if (!carriers.length) return undefined;
    const groups = new Map<object, BlockCarrier[]>();
    for (const carrier of carriers) {
        const origin = carrierOrigin(carrier);
        const group = groups.get(origin);
        if (group) group.push(carrier); else groups.set(origin, [carrier]);
    }
    const result: BlockCarrier[] = [];
    for (const group of groups.values()) {
        group.sort((a, b) => a.from - b.from || a.to - b.to);
        let current = group[0];
        for (let i = 1; i < group.length; i++) {
            const next = group[i];
            const bothRanges = current.from < current.to && next.from < next.to;
            if (next.from <= current.to && (bothRanges || carrierSource(current) === carrierSource(next)))
                current = mapCarrier(current, current.from, Math.max(current.to, next.to));
            else { result.push(current); current = next; }
        }
        result.push(current);
    }
    result.sort((a, b) => a.from - b.from || a.to - b.to);
    return result.map(carrier => {
        const stored = { ...carrier };
        carrierOrigins.set(stored, carrierOrigin(carrier));
        carrierSources.set(stored, carrierSource(carrier));
        return stored;
    });
}
