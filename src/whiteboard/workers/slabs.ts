import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';

const MIN_SLAB = 64 * 1024;
const MAX_SLAB = 256 * 1024;
export interface SlabHandle { readonly slab: number; readonly offset: number; readonly bytes: number; readonly generation: number }
interface Block { offset: number; bytes: number }
interface Slab { buffer: ArrayBuffer; free: Block[]; live: Map<number, SlabHandle>; lease: ByteLease | null }
export interface MovedSlab { readonly buffer: ArrayBuffer; release(): void }

/** Local, transferable storage. A moved slab is never available for reuse. */
export class TransferSlabs {
    private slabs = new Map<number, Slab>();
    private nextSlab = 1;
    private nextGeneration = 1;
    private closed = false;
    constructor(private readonly allocator?: MemoryAllocator) {}
    get byteLength(): number { let bytes = 0; for (const slab of this.slabs.values()) bytes += slab.buffer.byteLength; return bytes; }
    allocate(bytes: number): SlabHandle {
        if (this.closed) throw new Error('Slab allocator is disposed');
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_SLAB) throw new RangeError('Invalid slab allocation');
        const size = Math.ceil(bytes / 8) * 8;
        let id = 0, slab: Slab | undefined, block = -1;
        for (const [candidate, value] of this.slabs) {
            if (!value.buffer.byteLength) {
                this.slabs.delete(candidate);
                if (value.lease) this.allocator!.release(value.lease);
                continue;
            }
            const index = value.free.findIndex(part => part.bytes >= size);
            if (index >= 0) { id = candidate; slab = value; block = index; break; }
        }
        if (!slab) {
            const capacity = size <= MIN_SLAB ? MIN_SLAB : size <= 2 * MIN_SLAB ? 2 * MIN_SLAB : MAX_SLAB;
            const lease = this.allocator?.reserve(capacity) ?? null;
            if (this.allocator && !lease) throw new RangeError('Slab memory admission refused');
            let buffer: ArrayBuffer;
            try { buffer = new ArrayBuffer(capacity); }
            catch (error) { if (lease) this.allocator!.release(lease); throw error; }
            id = this.nextSlab++;
            slab = { buffer, free: [{ offset: 0, bytes: capacity }], live: new Map(), lease };
            this.slabs.set(id, slab); block = 0;
        }
        if (!Number.isSafeInteger(this.nextGeneration)) throw new RangeError('Slab generation exhausted');
        const part = slab.free[block], offset = part.offset;
        part.offset += size; part.bytes -= size;
        if (!part.bytes) slab.free.splice(block, 1);
        const handle = Object.freeze({ slab: id, offset, bytes, generation: this.nextGeneration++ });
        slab.live.set(offset, handle);
        return handle;
    }
    private checked(handle: SlabHandle): Slab {
        const slab = this.slabs.get(handle.slab), live = slab?.live.get(handle.offset);
        if (!slab || !live || live.generation !== handle.generation || live.bytes !== handle.bytes || !slab.buffer.byteLength) {
            throw new RangeError('Stale slab handle');
        }
        return slab;
    }
    view(handle: SlabHandle): Uint8Array { const slab = this.checked(handle); return new Uint8Array(slab.buffer, handle.offset, handle.bytes); }
    free(handle: SlabHandle): void {
        const slab = this.checked(handle);
        slab.live.delete(handle.offset);
        slab.free.push({ offset: handle.offset, bytes: Math.ceil(handle.bytes / 8) * 8 });
        slab.free.sort((a, b) => a.offset - b.offset);
        for (let i = 1; i < slab.free.length;) {
            const before = slab.free[i - 1], after = slab.free[i];
            if (before.offset + before.bytes === after.offset) { before.bytes += after.bytes; slab.free.splice(i, 1); }
            else i++;
        }
    }
    move(handle: SlabHandle): MovedSlab {
        const slab = this.checked(handle);
        const buffer = structuredClone(slab.buffer, { transfer: [slab.buffer] });
        this.slabs.delete(handle.slab);
        slab.live.clear();
        let lease = slab.lease;
        return { buffer, release: () => { if (lease) { this.allocator!.release(lease); lease = null; } } };
    }
    trim(): void {
        for (const [id, slab] of this.slabs) {
            if (slab.live.size) continue;
            this.slabs.delete(id);
            if (slab.lease) this.allocator!.release(slab.lease);
        }
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true;
        for (const slab of this.slabs.values()) if (slab.lease) this.allocator!.release(slab.lease);
        this.slabs.clear();
    }
}
