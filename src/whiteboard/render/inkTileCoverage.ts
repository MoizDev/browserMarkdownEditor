import type { Rect } from '../../platform/types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { add, interval, multiply, nextDown, nextUp } from '../geom/numeric';
import type { InkCoverage } from '../ink/outline';
import { inkCoverageChunks, type PaintInkItem } from './paintStream';

const BLOCK_BYTES = 64 * 1024;
const DESCRIPTOR_BYTES = 512;
const EMPTY = new Float64Array(0);

function intersects(item: PaintInkItem, data: Float64Array, offset: number, stride: 3 | 6, rect: Readonly<Rect>): boolean {
    const x0 = data[offset], y0 = data[offset + 1], r0 = data[offset + 2];
    const x1 = stride === 6 ? data[offset + 3] : x0, y1 = stride === 6 ? data[offset + 4] : y0;
    const r1 = stride === 6 ? data[offset + 5] : r0;
    if (![x0, y0, r0, x1, y1, r1, ...item.localToWorld].every(Number.isFinite) || r0 < 0 || r1 < 0) return true;
    const radius = Math.max(r0, r1);
    const x = { lo: nextDown(Math.min(x0, x1) - radius), hi: nextUp(Math.max(x0, x1) + radius) };
    const y = { lo: nextDown(Math.min(y0, y1) - radius), hi: nextUp(Math.max(y0, y1) + radius) };
    const [a, b, c, d, e, f] = item.localToWorld;
    const worldX = add(add(multiply(interval(a), x), multiply(interval(c), y)), interval(e));
    const worldY = add(add(multiply(interval(b), x), multiply(interval(d), y)), interval(f));
    return !(worldX.hi < rect.x || worldX.lo > nextUp(rect.x + rect.width)
        || worldY.hi < rect.y || worldY.lo > nextUp(rect.y + rect.height));
}

export class InkTileCoverageJob {
    private readonly chunks: readonly InkCoverage[];
    private readonly selected: InkCoverage[] = [];
    private readonly leases: ByteLease[] = [];
    private chunk = 0;
    private phase: 'segments' | 'discs' | 'finish' | 'complete' | 'disposed' = 'segments';
    private offset = 0;
    private run = -1;
    private used = 0;
    private heldBytes = 0;
    private value: PaintInkItem | null = null;
    private denied = false;
    constructor(private readonly item: PaintInkItem, private readonly worldRect: Readonly<Rect>, private readonly memory: MemoryAllocator) {
        if (![worldRect.x, worldRect.y, worldRect.width, worldRect.height, worldRect.x + worldRect.width,
            worldRect.y + worldRect.height].every(Number.isFinite) || worldRect.width < 0 || worldRect.height < 0) {
            throw new RangeError('Invalid ink tile bounds');
        }
        this.worldRect = Object.freeze({ ...worldRect });
        this.chunks = inkCoverageChunks(item.coverage);
    }
    get blocked(): boolean { return this.denied; }
    get memoryBytes(): number { return this.heldBytes; }
    get cpuWorkingSet(): number {
        return this.memoryBytes + (this.phase !== 'complete' && this.phase !== 'disposed'
            && this.used + DESCRIPTOR_BYTES > this.leases.length * BLOCK_BYTES ? BLOCK_BYTES : 0);
    }
    get result(): PaintInkItem | null {
        if (this.phase !== 'complete') throw new Error('Ink tile coverage is not complete');
        return this.value;
    }
    private reserveDescriptor(): boolean {
        if (this.used + DESCRIPTOR_BYTES > this.leases.length * BLOCK_BYTES) {
            const lease = this.memory.reserve(BLOCK_BYTES);
            if (!lease) { this.denied = true; return false; }
            this.leases.push(lease); this.heldBytes += lease.bytes;
        }
        this.used += DESCRIPTOR_BYTES;
        return true;
    }
    private flush(coverage: InkCoverage, data: Float64Array): boolean {
        if (this.run < 0) return true;
        if (!this.reserveDescriptor()) return false;
        const view = data.subarray(this.run, this.offset);
        this.selected.push(Object.freeze({ ...coverage,
            segments: this.phase === 'segments' ? view : EMPTY,
            discs: this.phase === 'discs' ? view : EMPTY }));
        this.run = -1;
        return true;
    }
    step(maxWork: number): boolean {
        if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid ink tile work budget');
        if (this.phase === 'disposed') throw new Error('Ink tile coverage was disposed');
        this.denied = false;
        for (let work = 0; work < maxWork && this.phase !== 'complete'; work++) {
            if (this.phase === 'finish') {
                if (this.selected.length) {
                    if (!this.reserveDescriptor()) return false;
                    this.value = Object.freeze({ ...this.item, coverage: this.selected });
                }
                this.phase = 'complete'; break;
            }
            if (this.chunk === this.chunks.length) { this.phase = 'finish'; continue; }
            const coverage = this.chunks[this.chunk];
            const stride = this.phase === 'segments' ? 6 : 3;
            const data = this.phase === 'segments' ? coverage.segments : coverage.discs;
            if (data.length % stride) throw new RangeError('Invalid canonical ink primitive stride');
            if (this.offset === data.length) {
                if (!this.flush(coverage, data)) return false;
                this.offset = 0;
                if (this.phase === 'segments') this.phase = 'discs';
                else { this.phase = 'segments'; this.chunk++; }
                continue;
            }
            const keep = intersects(this.item, data, this.offset, stride, this.worldRect);
            if (!keep && this.run >= 0 && !this.flush(coverage, data)) return false;
            if (keep && this.run < 0) this.run = this.offset;
            this.offset += stride;
        }
        return this.phase === 'complete';
    }
    cancel(): void { this.dispose(); }
    dispose(): void {
        if (this.phase === 'disposed') return;
        this.phase = 'disposed'; this.value = null;
        // Drop all views before releasing their metadata reservations.
        this.selected.length = 0;
        const errors: unknown[] = [];
        for (const lease of this.leases.splice(0)) {
            this.heldBytes -= lease.bytes;
            try { this.memory.release(lease); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Failed to release ink tile metadata');
    }
}
