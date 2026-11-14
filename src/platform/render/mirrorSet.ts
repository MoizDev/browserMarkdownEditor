import type { ViewState } from '../types';
import type { ByteLease } from './gfx/api';
import type { MemoryCacheHandle, MemoryGovernor, MemorySessionOwner } from './memoryGovernor';
import { renderTokenKey } from './tiles/geometry';
import type { TileKey } from './tiles/geometry';
import type { RenderToken } from './types';

/** The App session owns this store. The platform reads pixels only into an explicit borrow. */
export interface MirrorStorage<T extends object> {
    read(id: string): T | undefined;
    /** Idempotent real resource close/removal; never merely a counter decrement. */
    close(id: string): void;
}

export interface MirrorView {
    readonly token: RenderToken;
    readonly sourceRole: string;
    readonly contentRevision: string;
    readonly colourVersion: number;
    readonly geometryDigest: string;
    readonly nominalDpr: number;
    readonly view: Pick<ViewState, 'camera' | 'viewport'>;
}

export interface MirrorEntry {
    /** Publication identity, not just a tile key; replacing pixels always uses a new id. */
    readonly id: string;
    readonly key: TileKey;
    readonly geometryDigest: string;
    readonly tier: 'exact' | 'low';
    readonly bytes: number;
    /** Visible low coverage may be the last provider; hidden entries are all revocable. */
    readonly neededByCurrentFrame: boolean;
}

export interface BorrowedMirror<T extends object> {
    readonly entry: MirrorEntry;
    readonly pixels: T;
}

export interface MirrorBorrow<T extends object> {
    read(view: MirrorView): readonly BorrowedMirror<T>[];
    sharpEligible(view: MirrorView): boolean;
    release(): void;
}

export interface MirrorSetOptions<T extends object> {
    readonly owner: MemorySessionOwner;
    readonly governor: MemoryGovernor;
    readonly storage: MirrorStorage<T>;
    readonly createdAt: number;
    /** Stable App-session callback; null means this session can no longer publish. */
    readonly currentToken: () => RenderToken | null;
}

export interface MirrorReadout {
    readonly retainedBytes: number;
    readonly borrowedRetiringBytes: number;
    readonly exactEntries: number;
    readonly lowEntries: number;
    readonly activeBorrows: number;
    readonly hiddenAt: number | null;
    readonly released: boolean;
}

interface EntryRecord {
    entry: MirrorEntry;
    readonly lease: ByteLease;
    borrows: number;
    closing: boolean;
    finishing: boolean;
}

interface FrameRecord {
    readonly key: string;
    readonly entries: readonly string[];
    readonly sharp: boolean;
}

function sameOwner(owner: MemorySessionOwner, token: RenderToken): boolean {
    return owner.vaultEpoch === token.vaultEpoch && owner.documentId === token.documentId && owner.session === token.session;
}

function viewKey(view: MirrorView): string {
    const { camera, viewport } = view.view;
    if (![camera.x, camera.y, camera.z, viewport.width, viewport.height, viewport.dpr, view.nominalDpr].every(Number.isFinite) ||
        camera.z <= 0 || viewport.dpr <= 0 || view.nominalDpr <= 0 || viewport.width < 0 || viewport.height < 0) {
        throw new RangeError('Invalid mirror view');
    }
    return JSON.stringify([renderTokenKey(view.token), view.sourceRole, view.contentRevision, view.colourVersion,
    view.geometryDigest, camera.x, camera.y, camera.z, viewport.width, viewport.height, viewport.dpr, view.nominalDpr]);
}

function matches(entry: MirrorEntry, view: MirrorView): boolean {
    return entry.key.documentToken === renderTokenKey(view.token) && entry.key.sourceRole === view.sourceRole &&
        entry.key.contentRevision === view.contentRevision && entry.key.colourVersion === view.colourVersion &&
        entry.geometryDigest === view.geometryDigest;
}

function all(actions: readonly (() => void)[]): void {
    const errors: unknown[] = [];
    for (const action of actions) { try { action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Mirror cleanup failed');
}

/** One instance belongs to one App-level session (§6.4:649), never a layer or module singleton.
 * Only metadata/leases are retained here. Session storage keeps canonical pixels across graph trips.
 */
export class MirrorSet<T extends object> {
    readonly owner: MemorySessionOwner;
    private readonly governor: MemoryGovernor;
    private readonly storage: MirrorStorage<T>;
    private readonly currentToken: () => RenderToken | null;
    private readonly retained: MemoryCacheHandle;
    private readonly retiring: MemoryCacheHandle;
    private readonly entries = new Map<string, EntryRecord>();
    private readonly adopting = new Set<string>();
    private retainedBytes = 0;
    private retiringBytes = 0;
    private activeBorrows = 0;
    private exactEntries = 0;
    private lowEntries = 0;
    private protectedLow = new Set<string>();
    private hiddenAt: number | null = null;
    private lastUsedAt = 0;
    private lastVisibleAt = 0;
    private released = false;
    private frame: FrameRecord | null = null;

    constructor(options: MirrorSetOptions<T>) {
        this.owner = Object.freeze({ ...options.owner });
        this.governor = options.governor;
        this.storage = options.storage;
        this.currentToken = options.currentToken;
        if (!Number.isFinite(options.createdAt)) throw new RangeError('Invalid mirror creation time');
        this.hiddenAt = options.createdAt;
        const scope = JSON.stringify([this.owner.vaultEpoch, this.owner.documentId, this.owner.session]);
        this.retained = this.governor.register({
            id: `${scope}:mirrors`, pool: 'cpu', kind: 'mirror', class: 'scene-cache', owner: this.owner,
            hiddenAt: this.hiddenAt, lastVisibleAt: 0, lastUsedAt: 0,
            memory: () => ({ live: this.retainedBytes, retiring: 0 }), evict: bytes => this.evict(bytes),
        });
        try {
            this.retiring = this.governor.register({
                id: `${scope}:mirror-borrows`, pool: 'cpu', kind: 'mirror-retiring', class: 'critical', owner: this.owner,
                hiddenAt: null, lastVisibleAt: 0, lastUsedAt: 0,
                memory: () => ({ live: 0, retiring: this.retiringBytes }), evict: () => { /* Active users must drain; no fake free. */ },
            });
        } catch (error) { this.retained.close(); throw error; }
    }

    /** True transfers ownership, even if reentrant pressure immediately retires the new entry.
     * The producer has already published pixels in session storage and must not close/return them
     * after success. A refusal leaves its original cache/token authority untouched (§6.1:592).
     */
    adopt(entry: MirrorEntry, token: RenderToken, lease: ByteLease): boolean {
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes !== lease.bytes || !entry.id) {
            throw new RangeError('Invalid mirror allocation');
        }
        if (this.released || this.entries.has(entry.id) || this.adopting.has(entry.id) || !this.isCurrent(token) ||
            entry.key.documentToken !== renderTokenKey(token)) return false;
        // Admission can synchronously evict another cache and reenter this session.
        this.adopting.add(entry.id);
        try {
            if (!this.governor.transferLease(lease, this.retained)) return false;
            const record: EntryRecord = {
                entry: Object.freeze({ ...entry, key: Object.freeze({ ...entry.key }) }), lease,
                borrows: 0, closing: false, finishing: false,
            };
            this.entries.set(entry.id, record);
            this.retainedBytes += entry.bytes;
            if (entry.tier === 'exact') this.exactEntries++;
            else { this.lowEntries++; if (entry.neededByCurrentFrame) this.protectedLow.add(entry.id); }
            if (this.released || !this.isCurrent(token)) this.closeEntry(record);
            return true;
        } finally { this.adopting.delete(entry.id); }
    }

    /** Commit only ids whose CPU copy survived. A sharp GPU frame alone is not a CPU mirror proof. */
    commitFrame(view: MirrorView, ids: readonly string[], sharp: boolean, protectedLow: ReadonlySet<string>): void {
        if (!this.isCurrent(view.token)) return;
        const unique = [...new Set(ids)];
        const complete = unique.length > 0 && unique.every(id => {
            const record = this.entries.get(id);
            return record && !record.closing && matches(record.entry, view);
        });
        for (const id of new Set([...this.protectedLow, ...protectedLow])) {
            const record = this.entries.get(id);
            if (record && !record.closing && record.entry.tier === 'low') {
                record.entry = Object.freeze({ ...record.entry, neededByCurrentFrame: protectedLow.has(id) });
            }
        }
        this.protectedLow = new Set(protectedLow);
        this.frame = { key: viewKey(view), entries: unique, sharp: sharp && complete };
    }

    /** Camera changes drop exact pixels left behind; only the bounded near-low set is retained. */
    retainViewport(needed: ReadonlySet<string>): void {
        const discard = [...this.entries.values()].filter(record => !record.closing && !needed.has(record.entry.id));
        all(discard.map(record => () => this.closeEntry(record)));
    }

    setVisible(visible: boolean, now: number): void {
        if (!Number.isFinite(now)) throw new RangeError('Invalid mirror visibility time');
        if (this.released) return;
        if (visible) { this.hiddenAt = null; this.lastVisibleAt = now; }
        else if (this.hiddenAt === null) this.hiddenAt = now;
        // Governor eviction can reenter this set; metadata changes precede that callback.
        this.retained.updateActivity({ hiddenAt: this.hiddenAt, lastVisibleAt: this.lastVisibleAt, lastUsedAt: this.lastUsedAt });
    }

    borrow(view: MirrorView, now: number): MirrorBorrow<T> {
        const key = viewKey(view);
        const bound: MirrorView = {
            ...view, token: { ...view.token },
            view: { camera: { ...view.view.camera }, viewport: { ...view.view.viewport } }
        };
        if (!Number.isFinite(now)) throw new RangeError('Invalid mirror borrow time');
        this.lastUsedAt = now;
        this.retained.updateActivity({ hiddenAt: this.hiddenAt, lastVisibleAt: this.lastVisibleAt, lastUsedAt: now });
        let values: BorrowedMirror<T>[] | null = [];
        const records: EntryRecord[] = [];
        if (this.isCurrent(view.token) && view.view.viewport.width > 0 && view.view.viewport.height > 0) {
            try {
                for (const record of this.entries.values()) {
                    if (record.closing || !matches(record.entry, view)) continue;
                    record.borrows++;
                    records.push(record);
                    const pixels = this.storage.read(record.entry.id);
                    if (pixels) values.push(Object.freeze({ entry: record.entry, pixels }));
                    else { records.pop(); this.returnEntry(record); }
                }
            } catch (error) {
                all(records.map(record => () => this.returnEntry(record)));
                throw error;
            }
        }
        const valid = (current: MirrorView) => values !== null && this.isCurrent(current.token) &&
            renderTokenKey(current.token) === renderTokenKey(bound.token) && current.sourceRole === bound.sourceRole &&
            current.contentRevision === bound.contentRevision && current.colourVersion === bound.colourVersion &&
            current.geometryDigest === bound.geometryDigest;
        this.activeBorrows++;
        return {
            read: current => valid(current) ? values! : [],
            sharpEligible: current => {
                if (!valid(current) || viewKey(current) !== key || this.frame?.key !== key || !this.frame.sharp) return false;
                const ids = new Set(values!.map(value => value.entry.id));
                return this.frame.entries.every(id => ids.has(id));
            },
            release: () => {
                if (values === null) return;
                const held = values;
                values = null;
                held.length = 0;
                this.activeBorrows--;
                all(records.map(record => () => this.returnEntry(record)));
            },
        };
    }

    /** Hidden: exact → low → nothing. Visible: low providers needed by this frame stay pinned. */
    evict(bytes: number): void {
        if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Invalid mirror eviction');
        let retired = 0;
        const errors: unknown[] = [];
        const candidates = [...this.entries.values()].filter(record => !record.closing &&
            (this.hiddenAt !== null || record.entry.tier !== 'low' || !record.entry.neededByCurrentFrame))
            .sort((a, b) => Number(a.entry.tier === 'low') - Number(b.entry.tier === 'low') ||
                (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
        for (const record of candidates) {
            if (retired >= bytes) break;
            try { this.closeEntry(record); } catch (error) { errors.push(error); }
            if (record.closing) retired += record.entry.bytes;
        }
        if (errors.length) throw new AggregateError(errors, 'Mirror eviction failed');
    }

    /** Only the App's session-closing barrier calls this, never hide/unmount/rename (§C7.1). */
    releaseSession(): void {
        this.released = true;
        this.frame = null;
        try { all([...this.entries.values()].map(record => () => this.closeEntry(record))); }
        finally {
            // Failed transfers must remain retryable; closing the destination early would strand
            // the retained lease forever. Already-retiring borrows can drain after both close.
            if (![...this.entries.values()].some(record => !record.closing)) {
                this.retained.close();
                this.retiring.close();
            }
        }
    }

    /** Explicit retry for a failed owner close; no timer or optimistic lease return. */
    collect(): void {
        all([...this.entries.values()].filter(record => record.closing && !record.borrows).map(record => () => this.finish(record)));
    }

    readout(): MirrorReadout {
        return {
            retainedBytes: this.retainedBytes, borrowedRetiringBytes: this.retiringBytes,
            exactEntries: this.exactEntries, lowEntries: this.lowEntries, activeBorrows: this.activeBorrows,
            hiddenAt: this.hiddenAt, released: this.released
        };
    }

    private isCurrent(token: RenderToken): boolean {
        if (this.released || !sameOwner(this.owner, token)) return false;
        const current = this.currentToken();
        return current !== null && renderTokenKey(current) === renderTokenKey(token);
    }

    private closeEntry(record: EntryRecord): void {
        if (!record.closing) {
            if (!this.governor.transferLease(record.lease, this.retiring)) throw new Error('Cannot retire mirror ownership');
            record.closing = true;
            this.retainedBytes -= record.entry.bytes;
            this.retiringBytes += record.entry.bytes;
            if (record.entry.tier === 'exact') this.exactEntries--; else this.lowEntries--;
            this.protectedLow.delete(record.entry.id);
        }
        if (!record.borrows) this.finish(record);
    }

    private returnEntry(record: EntryRecord): void {
        record.borrows--;
        if (record.closing && !record.borrows) this.finish(record);
    }

    private finish(record: EntryRecord): void {
        if (record.finishing || this.entries.get(record.entry.id) !== record) return;
        record.finishing = true;
        try {
            this.storage.close(record.entry.id);
            this.retiring.release(record.lease);
            this.entries.delete(record.entry.id);
            this.retiringBytes -= record.entry.bytes;
        } finally { record.finishing = false; }
    }
}
