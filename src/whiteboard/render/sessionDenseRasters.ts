import type { Rect } from '../../platform/types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RegionChanges } from '../scene/boundsVersions';
import { FULL_REGION_CHANGES } from '../scene/boundsVersions';
import { TileHierarchy, tileRectWorld, tileScale, type TileAddress, type TileRecord, type TileTicket } from './tileHierarchy';

const METADATA_BYTES = 4096;
export interface DenseRasterTicket { readonly interval: string; readonly address: TileAddress; readonly revision: number }
export interface DenseRasterInput {
    readonly bitmap: ImageBitmap | null;
    readonly bytesLease: ByteLease;
    readonly owner: MemoryAllocator;
    readonly rect: Readonly<Rect>;
    readonly scale: number;
}
export interface DenseRasterBorrow {
    readonly bitmap: ImageBitmap | null;
    readonly rect: Readonly<Rect>;
    readonly scale: number;
    readonly address: TileAddress;
    readonly complete: true;
    readonly stale: boolean;
    readonly sourceRevision: number;
    release(): void;
}
type TicketState = { inner: TileTicket; lease: ByteLease; owner: MemoryAllocator; retired: boolean };
type Entry = { input: DenseRasterInput; metadata: ByteLease; metadataOwner: MemoryAllocator; interval: string;
    address: TileAddress; borrows: number; retired: boolean; freed: boolean };

/** Session-owned bitmap leases survive individual views; no rendering or scheduling is owned here. */
export class SessionDenseRasters {
    private allocator: MemoryAllocator | null = null;
    private readonly pending = new Map<DenseRasterTicket, TicketState>();
    private readonly lru = new Map<Entry, true>();
    private readonly intervals = new Map<string, number>();
    private readonly ownedLeases = new WeakSet<ByteLease>();
    private readonly hierarchy = new TileHierarchy<Entry>(record => this.retireRecord(record));
    private liveBytes = 0;
    private retiringBytes = 0;
    private ended = false;
    private currentRevision: number | null = null;

    get revision(): number | null { return this.currentRevision; }
    /** Advances to a newer source revision. Only tiles meeting the changed regions since the cached
     * revision go stale; unknown changes (or no change source) invalidate every interval. */
    advanceRevision(revision: number, changes?: (from: number) => RegionChanges): boolean {
        if (this.ended || !Number.isSafeInteger(revision) || revision < 0) return false;
        if (this.currentRevision !== null && revision < this.currentRevision) return false;
        if (this.currentRevision !== null && revision > this.currentRevision) {
            const delta = changes?.(this.currentRevision) ?? FULL_REGION_CHANGES;
            if (delta.full) this.invalidateAll(revision);
            else for (const interval of [...this.intervals.keys()]) this.invalidateRegions(interval, revision, delta.regions);
        }
        this.currentRevision = revision; return true;
    }

    bindMemory(allocator: MemoryAllocator): void {
        if (this.ended) throw new Error('Dense raster cache disposed');
        this.allocator = allocator;
    }
    begin(interval: string, address: TileAddress, revision: number): DenseRasterTicket | null {
        if (this.ended) throw new Error('Dense raster cache disposed');
        if (!interval) throw new TypeError('Dense raster interval is required');
        if (this.currentRevision !== null && revision !== this.currentRevision) return null;
        const owner = this.allocator;
        if (!owner) return null;
        const lease = owner.reserve(METADATA_BYTES);
        if (!lease) return null;
        try {
            const inner = this.hierarchy.begin(interval, address, revision);
            const ticket: DenseRasterTicket = Object.freeze({ interval, address: inner.address, revision });
            this.pending.set(ticket, { inner, lease, owner, retired: false }); this.liveBytes += lease.bytes;
            this.intervals.set(interval, revision);
            return ticket;
        } catch (error) { owner.release(lease); throw error; }
    }
    /** Call only after the producer has physically stopped using its ticket. */
    cancel(ticket: DenseRasterTicket): void {
        const state = this.pending.get(ticket);
        if (!state) return;
        this.pending.delete(ticket); this.hierarchy.cancel(state.inner);
        if (state.retired) this.retiringBytes -= state.lease.bytes; else this.liveBytes -= state.lease.bytes;
        state.owner.release(state.lease);
    }
    publish(ticket: DenseRasterTicket, input: DenseRasterInput): boolean {
        const state = this.pending.get(ticket);
        if (!state) return false;
        const expected = tileRectWorld(ticket.address), scale = tileScale(ticket.address.pyramid, ticket.address.level), rect = input.rect;
        if (!input.owner || !input.bytesLease || !Number.isSafeInteger(input.bytesLease.bytes) || input.bytesLease.bytes < 0 ||
            this.ownedLeases.has(input.bytesLease) || !Number.isFinite(input.scale) || input.scale !== scale ||
            !rect || rect.x !== expected.x || rect.y !== expected.y || rect.width !== expected.width || rect.height !== expected.height ||
            (input.bitmap && input.bytesLease.bytes < input.bitmap.width * input.bitmap.height * 4)) {
            this.cancel(ticket); return false;
        }
        if (this.ended || state.retired) { this.cancel(ticket); return false; }
        const entry: Entry = { input: { ...input, rect: Object.freeze({ ...rect }) }, metadata: state.lease, metadataOwner: state.owner,
            interval: ticket.interval, address: state.inner.address, borrows: 0, retired: false, freed: false };
        if (!this.hierarchy.publish(state.inner, entry)) { this.cancel(ticket); return false; }
        this.pending.delete(ticket); this.ownedLeases.add(input.bytesLease);
        this.liveBytes += input.bytesLease.bytes; this.lru.set(entry, true);
        return true;
    }
    borrowAncestor(interval: string, address: TileAddress, allowStale = false): DenseRasterBorrow | null {
        if (this.ended) return null;
        const record = this.hierarchy.lookupAncestor(interval, address, allowStale);
        if (!record) return null;
        const entry = record.payload;
        if (entry.retired) return null;
        entry.borrows++; this.lru.delete(entry); this.lru.set(entry, true);
        let held = true;
        return { bitmap: entry.input.bitmap, rect: entry.input.rect, scale: entry.input.scale, address: record.address,
            complete: true, stale: record.stale, sourceRevision: record.revision,
            release: () => { if (!held) return; held = false; entry.borrows--; if (entry.retired && !entry.borrows) this.free(entry); } };
    }
    invalidateRegions(interval: string, revision: number, regions: readonly Rect[]): void {
        if (this.ended) return;
        this.hierarchy.invalidateRegions(interval, revision, regions); this.retireTickets(interval); this.intervals.set(interval, revision);
    }
    invalidateOrder(interval: string, revision: number): void {
        if (this.ended) return;
        this.hierarchy.invalidateOrder(interval, revision); this.retireTickets(interval); this.intervals.set(interval, revision);
    }
    invalidateAll(revision: number): void {
        if (this.ended) return;
        if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Invalid dense raster revision');
        for (const current of this.intervals.values()) if (revision < current) throw new RangeError('Invalid dense raster revision');
        for (const interval of this.intervals.keys()) this.invalidateOrder(interval, revision);
    }
    /** Retires least-recently borrowed entries; borrowed pixels are never reclaimed here. */
    evict(bytes: number): number {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid dense raster eviction budget');
        let removed = 0;
        for (const entry of this.lru.keys()) {
            if (removed >= bytes) break;
            if (entry.borrows) continue;
            removed += entry.metadata.bytes + entry.input.bytesLease.bytes;
            this.hierarchy.retire(entry.interval, entry.address);
        }
        return removed;
    }
    /** Retires least-recently used entries that `keep` rejects, until `bytes` are freed. Borrowed entries are never
     * retired here; a kept entry is one the current view can draw, so it stays for the next draw. */
    evictUnused(keep: (interval: string, address: TileAddress) => boolean, bytes: number): number {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid dense raster eviction budget');
        let removed = 0;
        for (const entry of [...this.lru.keys()]) {
            if (removed >= bytes) break;
            if (entry.borrows || keep(entry.interval, entry.address)) continue;
            removed += entry.metadata.bytes + entry.input.bytesLease.bytes;
            this.hierarchy.retire(entry.interval, entry.address);
        }
        return removed;
    }
    /** Retires every entry charged to `owner` (its bitmap or its metadata), borrowed or not, and returns their bytes. A borrowed
     * entry is no longer served and is freed when its last borrow ends. A pane that hides gives back what it charged here: the
     * entries outlive the pane, but their leases are its cache's, and a hidden pane's cache is charged with nothing (measured: 3-7
     * of these per hidden dense board, 32.1 of the 33.6 MB CPU pool over seven hidden tabs, and every board shown after them
     * waited for memory for good). */
    releaseCharged(owner: MemoryAllocator): number {
        let removed = 0;
        for (const entry of [...this.lru.keys()]) {
            if (entry.input.owner !== owner && entry.metadataOwner !== owner) continue;
            removed += entry.metadata.bytes + entry.input.bytesLease.bytes;
            this.hierarchy.retire(entry.interval, entry.address);
        }
        if (this.allocator === owner) this.allocator = null;
        return removed;
    }
    memory(): Readonly<{ live: number; retiring: number }> { return { live: this.liveBytes, retiring: this.retiringBytes }; }
    get memoryBytes(): number { return this.liveBytes + this.retiringBytes; }
    clear(): void { this.hierarchy.clear(); this.retireTickets(); this.intervals.clear(); this.currentRevision = null; }
    dispose(): void { if (!this.ended) { this.ended = true; this.clear(); this.allocator = null; } }
    private retireTickets(interval?: string): void {
        for (const state of this.pending.values()) {
            if (state.retired || (interval !== undefined && state.inner.interval !== interval)) continue;
            state.retired = true; this.liveBytes -= state.lease.bytes; this.retiringBytes += state.lease.bytes;
        }
    }
    private retireRecord(record: TileRecord<Entry>): void {
        const entry = record.payload;
        if (entry.retired) return;
        entry.retired = true; this.lru.delete(entry);
        const bytes = entry.metadata.bytes + entry.input.bytesLease.bytes;
        this.liveBytes -= bytes; this.retiringBytes += bytes;
        if (!entry.borrows) {
            // A disposal failure must not make hierarchy publication transfer ownership ambiguously.
            try { this.free(entry); } catch { /* Accounting remains conservative if an issuer fails. */ }
        }
    }
    private free(entry: Entry): void {
        if (entry.freed) return;
        entry.freed = true;
        const bytes = entry.metadata.bytes + entry.input.bytesLease.bytes;
        try { entry.input.bitmap?.close(); }
        finally {
            try { entry.input.owner.release(entry.input.bytesLease); }
            finally {
                entry.metadataOwner.release(entry.metadata); this.ownedLeases.delete(entry.input.bytesLease); this.retiringBytes -= bytes;
            }
        }
    }
}
