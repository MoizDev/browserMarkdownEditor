import { ArenaError } from '../../platform/render/resourceArena';
import type { LayerHost } from '../../platform/render/compositor.types';

/** A device or arena refusing memory means "not now", never a broken canvas (platform contract: a budget
 * refusal defers). Measured: 3 of 5 notebook runs ended in 'Could not open canvas: out-of-budget' when a
 * staging refusal reached a layer's error report. */
export function isBudgetRefusal(error: unknown): boolean {
    return error instanceof ArenaError && (error.code === 'out-of-budget' || error.code === 'allocation');
}

export interface SizedCapacityWait { readonly pool: 'cpu' | 'gpu'; readonly bytes: number }

export function awaitSizedCapacity(host: Pick<LayerHost, 'allocator'> | null | undefined, wake: () => void, wait: SizedCapacityWait): void {
    if (!Number.isSafeInteger(wait.bytes) || wait.bytes < 0) throw new RangeError('A capacity wait needs a byte count');
    host?.allocator[wait.pool].whenAvailable?.(wake, wait.bytes);
}
