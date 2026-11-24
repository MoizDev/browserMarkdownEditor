import type { Rect } from '../../platform/types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { PaintBoundsJob } from './paintBounds';
import type { PaintItem } from './paintStream';

const BLOCK_BYTES = 65_536, ENTRY_BYTES = 256;

/** One immutable frame's conservative bounds, shared by its sequential tile producer. */
export class PaintBoundsCache {
    private entries = new WeakMap<PaintItem, Readonly<{ bounds: Rect | null }>>();
    private readonly leases: ByteLease[] = [];
    private count = 0;
    private held = 0;
    private pending: { item: PaintItem; job: PaintBoundsJob } | null = null;
    private ended = false;
    blocked = false;

    constructor(private readonly memory: MemoryAllocator) {}

    get memoryBytes(): number { return this.held; }
    get cpuWorkingSet(): number {
        return this.memoryBytes + (!this.ended && !this.pending && (this.count + 1) * ENTRY_BYTES > this.leases.length * BLOCK_BYTES ? BLOCK_BYTES : 0);
    }

    read(item: PaintItem): Readonly<{ bounds: Rect | null }> | undefined {
        return this.ended ? undefined : this.entries.get(item);
    }

    step(item: PaintItem, maxWork = 1): boolean {
        if (this.ended) throw new Error('Paint bounds cache disposed');
        if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid paint bounds work slice');
        if (this.pending && this.pending.item !== item) throw new Error('Paint bounds job already in progress');
        this.blocked = false;
        if (this.entries.has(item)) return true;
        if (!this.pending) {
            if ((this.count + 1) * ENTRY_BYTES > this.leases.length * BLOCK_BYTES) {
                const lease = this.memory.reserve(BLOCK_BYTES);
                if (!lease) { this.blocked = true; return false; }
                try { this.leases.push(lease); this.held += lease.bytes; } catch (error) { this.memory.release(lease); throw error; }
            }
            this.pending = { item, job: new PaintBoundsJob(item) };
        }
        const pending = this.pending;
        try {
            if (!pending.job.step(maxWork)) return false;
            this.entries.set(item, { bounds: pending.job.result });
            this.count++; this.pending = null;
            return true;
        } catch (error) { this.pending = null; throw error; }
    }

    dispose(): void {
        if (this.ended) return;
        this.ended = true; this.pending = null; this.entries = new WeakMap(); this.count = 0; this.blocked = false;
        for (const lease of this.leases) this.memory.release(lease);
        this.leases.length = 0; this.held = 0;
    }
}
