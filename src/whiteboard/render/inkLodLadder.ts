import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { InkCoverageReply } from '../workers/geometryProtocol';
import { inkMinRadius, inkRadiusTolerance } from './inkGeometry';

/** Levels kept per stroke. Each is a full chain at its own error band, so the bound keeps one stroke's ladder
 * from growing with every zoom step; the least recently used level is released to make room. */
const MAX_LEVELS = 4;

/** `tolerance` is the level's own F1 centre bound (its geometry's thinnest radius); a level's centre error may not exceed it. */
interface HeldLevel { readonly reply: InkCoverageReply; readonly lease: ByteLease; readonly tolerance: number }

/** A stroke's certified coarser chains, one per error band.
 *
 * Validity is monotone: a level whose cumulative centre error is `e` serves every device budget `B >= e`,
 * so `coarsest(B)` is the cheapest chain already built for `B`. A miss is derived from the fine samples, and
 * never from a held level: any held level with error below `B` would already have been served. Levels are
 * rebuildable, so the ladder is a pure cache: its segments are charged to
 * the session allocator, released on dispose, and released first under pressure. A denied reservation keeps
 * the stroke on the fine samples. */
export class InkLodLadder {
    readonly #levels: HeldLevel[] = [];  // least recently used first
    #closed = false;

    constructor(private readonly memory: MemoryAllocator) {}

    /** Bytes of the levels currently held, as charged to the allocator. */
    get bytes(): number { return this.#levels.reduce((sum, level) => sum + level.lease.bytes, 0); }

    /** The coarsest held level whose cumulative centre error fits the budget, or null. A hit becomes most recent. */
    coarsest(budget: number): InkCoverageReply | null {
        // A level serves a budget only within its own F1 bound. The client's budget is 1/16 device px, stricter than a quarter
        // pixel, so the quarter-pixel rule holds; the bound stops a thin stroke taking a coarse chain its own width cannot absorb.
        // Both are world units and scale-free, so neither depends on the zoom the level was built at.
        let best = -1;
        for (let i = 0; i < this.#levels.length; i++) {
            const { reply, tolerance } = this.#levels[i];
            const error = reply.centreErrorWorld;
            if (error <= Math.min(budget, tolerance) && (best < 0 || error > this.#levels[best].reply.centreErrorWorld)) best = i;
        }
        if (best < 0) return null;
        const [hit] = this.#levels.splice(best, 1);
        this.#levels.push(hit);
        return hit.reply;
    }

    /** Charges the level's segments; false once disposed or when the allocator denies the bytes. */
    add(reply: InkCoverageReply): boolean {
        if (this.#closed) return false;
        if (this.#levels.length >= MAX_LEVELS) this.#release(0);
        const lease = this.memory.reserve(reply.segments.byteLength);
        if (!lease) return false;
        this.#levels.push({ reply, lease, tolerance: inkRadiusTolerance(inkMinRadius(reply)) });
        return true;
    }

    /** Releases least recently used levels until at least `bytes` are returned; the freed count is returned. */
    evict(bytes: number): number {
        let freed = 0;
        while (freed < bytes && this.#levels.length) freed += this.#release(0);
        return freed;
    }

    dispose(): void {
        this.#closed = true;
        while (this.#levels.length) this.#release(0);
    }

    #release(index: number): number {
        const [held] = this.#levels.splice(index, 1);
        this.memory.release(held.lease);
        return held.lease.bytes;
    }
}
