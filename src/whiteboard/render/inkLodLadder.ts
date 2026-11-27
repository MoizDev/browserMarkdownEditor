import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { InkCoverageReply } from '../workers/geometryProtocol';
import { inkMinRadius, inkRadiusTolerance } from './inkGeometry';

const MAX_LEVELS = 4;

interface HeldLevel { readonly reply: InkCoverageReply; readonly lease: ByteLease; readonly tolerance: number }

export class InkLodLadder {
    readonly #levels: HeldLevel[] = [];
    #closed = false;

    constructor(private readonly memory: MemoryAllocator) {}

    get bytes(): number { return this.#levels.reduce((sum, level) => sum + level.lease.bytes, 0); }

    coarsest(budget: number): InkCoverageReply | null {
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

    add(reply: InkCoverageReply): boolean {
        if (this.#closed) return false;
        if (this.#levels.length >= MAX_LEVELS) this.#release(0);
        const lease = this.memory.reserve(reply.segments.byteLength);
        if (!lease) return false;
        this.#levels.push({ reply, lease, tolerance: inkRadiusTolerance(inkMinRadius(reply)) });
        return true;
    }

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
