import type { Block, BlockCarrier, Run } from './richText';

// Independent future tails stay byte-exact as range carriers, never concatenated positional fields.
const carrierOrigins = new WeakMap<BlockCarrier, object>();
const carrierSources = new WeakMap<BlockCarrier, object>();
const blockOrigins = new WeakMap<Block, object>();
const runOrigins = new WeakMap<Run, object>();
export const carrierOrigin = (carrier: BlockCarrier): object => carrierOrigins.get(carrier) ?? carrier;
export const carrierSource = (carrier: BlockCarrier): object => carrierSources.get(carrier) ?? carrier;
export const blockOrigin = (block: Block): object => {
    let origin = blockOrigins.get(block);
    if (!origin) { origin = {}; blockOrigins.set(block, origin); }
    return origin;
};
export function trackBlock(block: Block, origin: Block): Block {
    blockOrigins.set(block, blockOrigin(origin));
    return block;
}
export function runOrigin(run: Run): object {
    let origin = runOrigins.get(run);
    if (!origin) { origin = {}; runOrigins.set(run, origin); }
    return origin;
}
export function trackRun(run: Run, origin: Run): Run {
    runOrigins.set(run, runOrigin(origin));
    return run;
}
export function mapCarrier(carrier: BlockCarrier, from: number, to: number, preserveOrigin = true): BlockCarrier {
    const mapped: BlockCarrier = { ...carrier, from, to };
    if (preserveOrigin) {
        carrierOrigins.set(mapped, carrierOrigin(carrier));
        carrierSources.set(mapped, carrierSource(carrier));
    }
    return mapped;
}
export function carrierForTail(block: Block, from: number, to: number): BlockCarrier {
    if (block.tail === undefined) throw new Error('A block carrier requires a tail');
    const carrier: BlockCarrier = { from, to, kind: block.kind, level: block.level, dir: block.dir,
        ...(block.start !== undefined ? { start: block.start } : {}), tail: block.tail };
    carrierOrigins.set(carrier, blockOrigin(block));
    return carrier;
}
export function sliceCarriers(block: Block, from: number, to: number, preserveOrigin: boolean): readonly BlockCarrier[] | undefined {
    const result: BlockCarrier[] = [];
    for (const carrier of block.carriers ?? []) {
        if (carrier.from === carrier.to) {
            if (carrier.from >= from && carrier.from <= to) result.push(mapCarrier(carrier, carrier.from - from, carrier.to - from, preserveOrigin));
        } else {
            const start = Math.max(from, carrier.from), end = Math.min(to, carrier.to);
            if (start < end) result.push(mapCarrier(carrier, start - from, end - from, preserveOrigin));
        }
    }
    return result.length ? result : undefined;
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
