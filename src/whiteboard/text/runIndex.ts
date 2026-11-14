import type { Block } from './richText';
import { WeakIdentityLru } from './weakLru';

/** UTF-16 run starts, including the endpoint; duplicate starts are zero-width anchors. */
export interface RunIndex {
    readonly starts: Uint32Array;
    readonly length: number;
    readonly count: number;
}

interface CachedRunIndex { readonly index: RunIndex; readonly bytes: number }
const BYTE_LIMIT = 8 * 1024 * 1024;
const ENTRY_LIMIT = 256;
const cache = new WeakIdentityLru<Block, CachedRunIndex>(BYTE_LIMIT, ENTRY_LIMIT);

function construct(block: Block): CachedRunIndex {
    const runs = block.runs, starts = new Uint32Array(runs.length + 1);
    let length = 0;
    for (let index = 0; index < runs.length; index++) {
        starts[index] = length;
        length += runs[index].text.length;
        if (!Number.isSafeInteger(length) || length > 0xffffffff) throw new RangeError('Text block exceeds index limits');
    }
    starts[runs.length] = length;
    // Entries retain only offsets; the weak key does not pin runs or opaque raw data.
    return { index: { starts, length, count: runs.length }, bytes: 256 + starts.byteLength };
}

export function runIndex(block: Block): RunIndex {
    const hit = cache.get(block);
    if (hit) return hit.index;
    const built = construct(block);
    cache.set(block, built, built.bytes);
    return built.index;
}

function lowerBound(values: Uint32Array, value: number): number {
    let low = 0, high = values.length;
    while (low < high) {
        const mid = low + ((high - low) >>> 1);
        if (values[mid] < value) low = mid + 1; else high = mid;
    }
    return low;
}
function upperBound(values: Uint32Array, value: number): number {
    let low = 0, high = values.length;
    while (low < high) {
        const mid = low + ((high - low) >>> 1);
        if (values[mid] <= value) low = mid + 1; else high = mid;
    }
    return low;
}

/** First run which can overlap the range, including zero-width carriers at its start. */
export function firstRunAt(index: RunIndex, offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > index.length) throw new RangeError('Invalid block offset');
    const at = lowerBound(index.starts, offset);
    if (at > 0 && index.starts[at - 1] < offset && index.starts[at] > offset) return at - 1;
    return Math.min(at, index.count);
}

/** The run containing a code unit, never a zero-width anchor. */
export function runContaining(index: RunIndex, offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= index.length) throw new RangeError('Invalid block character offset');
    return upperBound(index.starts, offset) - 1;
}

/** Explicit disposal is useful for pane/application shutdown; cached blocks are otherwise bounded. */
export function clearRunIndexes(): void { cache.clear(); }
