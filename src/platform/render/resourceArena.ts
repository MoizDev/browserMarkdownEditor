import type {
    BufferHandle, ByteLease, ClipHandle, GfxError, Handle, PipelineHandle,
    SamplerHandle, TargetHandle, TextureHandle,
} from './gfx/api';
import type { GpuReleaseReason } from './types';

// rendering-design.md:88: kind brands are public; device/generation/slot are not.
export interface ArenaHandleMap {
    buffer: BufferHandle;
    texture: TextureHandle;
    sampler: SamplerHandle;
    pipeline: PipelineHandle;
    target: TargetHandle;
    clip: ClipHandle;
}

export type ArenaResourceKind = keyof ArenaHandleMap;
export type ArenaResourceMap = { [K in ArenaResourceKind]: unknown };

/** Backend-only seam, never passed to a layer (design:88, 298).
 * create is synchronous and must clean up its own partial native allocation on throw.
 * Async pipeline preparation finishes before its descriptor reaches this seam.
 * completed only polls; destroy must be safe to retry if a partial deletion throws.
 */
export interface ResourceArenaBackend<D extends ArenaResourceMap, O extends ArenaResourceMap> {
    create<K extends ArenaResourceKind>(kind: K, descriptor: D[K]): O[K];
    destroy<K extends ArenaResourceKind>(kind: K, object: O[K]): void;
    completed(serial: number): boolean;
}

/** Creation-time generation and governor callbacks; no budget is invented here (design:601–603). */
export interface ResourceArenaOptions<D extends ArenaResourceMap, O extends ArenaResourceMap> {
    generation: number;
    backend: ResourceArenaBackend<D, O>;
    releaseLease(lease: ByteLease): void;
}

/** Runtime product refusal, not a verification assertion (design:114–115, 603). */
export class ArenaError extends Error {
    readonly code: GfxError;

    constructor(code: GfxError) {
        super(code);
        this.name = 'ArenaError';
        this.code = code;
    }
}

/** An identity-checked encoding token pins resources until submit or cancel (design:298). */
export interface ArenaEncoding { readonly id: number }

/** O(1) counters: retired allocations remain charged separately (design:601–603). */
export interface ArenaMemory {
    readonly live: number;
    readonly retiring: number;
}

/** A shared lease returns only after owner closure AND final resource destruction (vr-lead ruling). */
export interface ArenaLeaseMemory extends ArenaMemory {
    readonly lease: ByteLease;
    readonly closed: boolean;
    readonly returned: boolean;
}

interface LeaseRecord {
    readonly lease: ByteLease;
    readonly id: number;
    readonly bytes: number;
    live: number;
    retiring: number;
    resources: number;
    closed: boolean;
    returned: boolean;
}

interface ResourceRecord<O extends ArenaResourceMap> {
    readonly handle: ArenaHandleMap[ArenaResourceKind];
    readonly deviceId: number;
    readonly generation: number;
    readonly slot: number;
    readonly kind: ArenaResourceKind;
    readonly lease: LeaseRecord;
    readonly bytes: number;
    readonly dependencies: readonly ResourceRecord<O>[];
    readonly pins: Set<EncodingRecord<O>>;
    state: 'live' | 'retiring' | 'destroyed';
    serial: number;
    references: number;
    creating: boolean;
    collecting: boolean;
    object: O[ArenaResourceKind] | null;
}

interface EncodingRecord<O extends ArenaResourceMap> {
    readonly token: ArenaEncoding;
    readonly resources: Set<ResourceRecord<O>>;
    state: 'encoding' | 'submitted' | 'cancelled' | 'abandoned';
}

let nextDeviceId = 1;
let nextHandleId = 1;

/** One immutable device generation owns all native resources (design:88, 298, 771–773).
 * Only backend/platform code sees the arena; layers receive the resource/pass API instead.
 */
export class ResourceArena<
    D extends ArenaResourceMap = ArenaResourceMap,
    O extends ArenaResourceMap = ArenaResourceMap,
> {
    readonly generation: number;
    readonly #deviceId: number;
    readonly #backend: ResourceArenaBackend<D, O>;
    readonly #releaseLease: (lease: ByteLease) => void;
    readonly #records = new Map<number, ResourceRecord<O>>();
    readonly #identities = new WeakMap<Handle, ResourceRecord<O>>();
    readonly #retiring = new Set<ResourceRecord<O>>();
    readonly #leases = new WeakMap<ByteLease, LeaseRecord>();
    readonly #leaseIds = new Map<number, LeaseRecord>();
    readonly #encodings = new WeakMap<ArenaEncoding, EncodingRecord<O>>();
    readonly #openEncodings = new Set<EncodingRecord<O>>();
    readonly #freeSlots: number[] = [];
    #nextSlot = 0;
    #nextEncoding = 1;
    #lastSerial = 0;
    #liveBytes = 0;
    #retiringBytes = 0;
    #abandoned = false;

    constructor(options: ResourceArenaOptions<D, O>) {
        this.#checkCount(options.generation);
        if (!Number.isSafeInteger(nextDeviceId)) throw new ArenaError('allocation');
        this.generation = options.generation;
        this.#deviceId = nextDeviceId++;
        this.#backend = options.backend;
        this.#releaseLease = options.releaseLease;
    }

    /** Reserve → create → publish, rolling back every failed allocation (design:603, 771).
     * Explicit dependencies are target/clip → live texture only (design:241; vr-lead ruling).
     * A retained pipeline/sampler cannot smuggle a working texture into the hidden reserve.
     */
    create<K extends ArenaResourceKind>(
        kind: K,
        descriptor: D[K],
        bytes: number,
        lease: ByteLease,
        dependencies: readonly Handle[] = [],
    ): ArenaHandleMap[K] {
        this.#requireHealthy();
        this.#checkCount(bytes);
        const held = this.#dependencies(kind, dependencies);
        const budget = this.#lease(lease);
        if (budget.closed) throw new ArenaError('invalid-input');
        if (bytes > budget.bytes - budget.live - budget.retiring ||
            !Number.isSafeInteger(this.#liveBytes + this.#retiringBytes + bytes)) {
            throw new ArenaError('out-of-budget');
        }
        if (!Number.isSafeInteger(nextHandleId) || !Number.isSafeInteger(this.#nextSlot)) {
            throw new ArenaError('allocation');
        }
        // The generic map preserves the exact kind brand; the minted shape is identical
        // for every kind, but TypeScript cannot correlate a generic indexed union here.
        const handle = Object.freeze({ id: nextHandleId++, kind }) as unknown as ArenaHandleMap[K];
        const record: ResourceRecord<O> = {
            handle, deviceId: this.#deviceId, generation: this.generation,
            slot: this.#freeSlots.pop() ?? this.#nextSlot++, kind, lease: budget, bytes,
            dependencies: held, pins: new Set(), state: 'live', serial: 0,
            references: 0, creating: true, collecting: false, object: null,
        };
        this.#records.set(handle.id, record);
        this.#identities.set(handle, record);
        for (const dependency of held) dependency.references++;
        budget.live += bytes;
        budget.resources++;
        this.#liveBytes += bytes;
        try {
            const object = this.#backend.create(kind, descriptor);
            this.#requireHealthy();
            if (object == null) throw new ArenaError('allocation');
            record.object = object;
            record.creating = false;
            // A re-entrant hide can retire this allocation before create returns.
            if (record.state !== 'live') throw new ArenaError('aborted');
            return handle;
        } catch (error) {
            if (error instanceof ArenaError && error.code === 'lost') this.abandon();
            if (!this.#abandoned) {
                record.creating = false;
                this.release(handle);
                this.#collectRecord(record, new Map());
            }
            throw error instanceof ArenaError ? error : new ArenaError('allocation');
        }
    }

    /** Backend-only native lookup; foreign/stale/retired identities never resolve (design:88). */
    validate<K extends ArenaResourceKind>(handle: Handle, expectedKind: K): O[K] {
        const record = this.#liveRecord(handle, expectedKind);
        if (record.creating || record.object === null) throw new ArenaError('invalid-resource');
        return record.object as O[K];
    }

    /** Encoding pins are distinct from submitted serials; neither can stand in for the other (design:298). */
    beginEncoding(): ArenaEncoding {
        this.#requireHealthy();
        if (!Number.isSafeInteger(this.#nextEncoding)) throw new ArenaError('allocation');
        const token = Object.freeze({ id: this.#nextEncoding++ });
        const record: EncodingRecord<O> = { token, resources: new Set(), state: 'encoding' };
        this.#encodings.set(token, record);
        this.#openEncodings.add(record);
        return token;
    }

    /** Resolve while live, then retain that native object through submission (design:298; R-060).
     * Already encoded commands keep their pinned native objects even if release follows.
     */
    pin<K extends ArenaResourceKind>(frame: ArenaEncoding, handle: Handle, kind: K): O[K] {
        const encoding = this.#encoding(frame);
        const object = this.validate(handle, kind);
        this.#pinRecord(encoding, this.#liveRecord(handle, kind));
        return object;
    }

    /** Called with the actual queue serial; ordered submissions make the latest fence sufficient (design:298). */
    submit(frame: ArenaEncoding, serial: number): void {
        const encoding = this.#encoding(frame);
        this.#checkCount(serial);
        if (serial <= this.#lastSerial) throw new ArenaError('invalid-input');
        this.#lastSerial = serial;
        for (const record of encoding.resources) {
            record.serial = Math.max(record.serial, serial);
            record.pins.delete(encoding);
        }
        encoding.resources.clear();
        encoding.state = 'submitted';
        this.#openEncodings.delete(encoding);
    }

    /** Cancellation is idempotent, including cleanup after generation loss (design:298, 773). */
    cancel(frame: ArenaEncoding): void {
        const encoding = this.#encodings.get(frame);
        if (!encoding) throw new ArenaError('invalid-resource');
        if (encoding.state !== 'encoding') return;
        for (const record of encoding.resources) record.pins.delete(encoding);
        encoding.resources.clear();
        encoding.state = 'cancelled';
        this.#openEncodings.delete(encoding);
    }

    /** Immediately revoke the public handle; its native allocation remains charged (design:298). */
    release(handle: Handle): void {
        const record = this.#record(handle);
        if (record.state !== 'live') return;
        record.state = 'retiring';
        record.lease.live -= record.bytes;
        record.lease.retiring += record.bytes;
        this.#liveBytes -= record.bytes;
        this.#retiringBytes += record.bytes;
        this.#retiring.add(record);
    }

    /** Owner closure prevents further allocations; fenced resources still hold the grant (design:603). */
    closeLease(lease: ByteLease): void {
        const record = this.#lease(lease);
        record.closed = true;
        this.#returnLease(record);
    }

    /** Nonblocking only: an unsignalled fence never authorizes reuse or a GPU wait (design:298; R-061). */
    collect(): void {
        if (this.#abandoned) return;
        const completed = new Map<number, boolean>();
        for (const record of this.#retiring) this.#collectRecord(record, completed);
    }

    /** Same-task cache release; only device-owned programs/sampler descriptors survive (design:370).
     * Unsubmitted encodings are cancelled; submitted uses remain charged as fenced retirement.
     */
    releaseAll(reason: GpuReleaseReason): void {
        if (reason === 'context-lost') {
            this.abandon();
            return;
        }
        if (this.#abandoned) return;
        for (const frame of this.#openEncodings) this.cancel(frame.token);
        for (const record of this.#records.values()) {
            if (record.kind !== 'pipeline' && record.kind !== 'sampler') this.release(record.handle);
        }
        this.collect();
    }

    /** Loss invalidates the entire generation without calling the lost backend (design:298, 771).
     * Lease owners still close their grants; closeLease remains usable after abandonment.
     */
    abandon(): void {
        if (this.#abandoned) return;
        this.#abandoned = true;
        for (const frame of this.#openEncodings) {
            frame.resources.clear();
            frame.state = 'abandoned';
        }
        this.#openEncodings.clear();
        for (const record of this.#records.values()) {
            record.state = 'destroyed';
            record.object = null;
            record.pins.clear();
            record.references = 0;
        }
        this.#records.clear();
        this.#retiring.clear();
        this.#freeSlots.length = 0;
        this.#liveBytes = 0;
        this.#retiringBytes = 0;
        // Update every ledger before invoking owner callbacks, which may re-enter cleanup.
        const leases = [...this.#leaseIds.values()];
        for (const lease of leases) {
            lease.live = 0;
            lease.retiring = 0;
            lease.resources = 0;
        }
        const failures: unknown[] = [];
        for (const lease of leases) {
            try {
                this.#returnLease(lease);
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length) throw failures[0];
    }

    memory(): ArenaMemory {
        return { live: this.#liveBytes, retiring: this.#retiringBytes };
    }

    /** Constant-time per-lease readout, not a per-frame walk over the resource cache (design:603). */
    leaseMemory(lease: ByteLease): ArenaLeaseMemory {
        const record = this.#leases.get(lease);
        return {
            lease, live: record?.live ?? 0, retiring: record?.retiring ?? 0,
            closed: record?.closed ?? false, returned: record?.returned ?? false,
        };
    }

    #requireHealthy(): void {
        if (this.#abandoned) throw new ArenaError('lost');
    }

    #checkCount(value: number): void {
        if (!Number.isSafeInteger(value) || value < 0) throw new ArenaError('invalid-input');
    }

    #record(handle: Handle): ResourceRecord<O> {
        const record = this.#identities.get(handle);
        if (!record || record.deviceId !== this.#deviceId || record.generation !== this.generation) {
            throw new ArenaError('invalid-resource');
        }
        return record;
    }

    #liveRecord(handle: Handle, kind: ArenaResourceKind): ResourceRecord<O> {
        const record = this.#record(handle);
        if (this.#abandoned || record.state !== 'live' || record.kind !== kind) {
            throw new ArenaError('invalid-resource');
        }
        return record;
    }

    #encoding(frame: ArenaEncoding): EncodingRecord<O> {
        const record = this.#encodings.get(frame);
        if (record?.state === 'cancelled') throw new ArenaError('aborted');
        if (this.#abandoned || !record || record.state !== 'encoding') {
            throw new ArenaError('invalid-resource');
        }
        return record;
    }

    #dependencies(kind: ArenaResourceKind, handles: readonly Handle[]): ResourceRecord<O>[] {
        if (handles.length && kind !== 'target' && kind !== 'clip') throw new ArenaError('invalid-input');
        // Parents are new and dependencies must already be live textures, so cycles cannot form.
        const held = new Set<ResourceRecord<O>>();
        for (const handle of handles) {
            const record = this.#liveRecord(handle, 'texture');
            if (record.creating || record.object === null) throw new ArenaError('invalid-resource');
            held.add(record);
        }
        return [...held];
    }

    #pinRecord(frame: EncodingRecord<O>, record: ResourceRecord<O>): void {
        if (frame.resources.has(record)) return;
        frame.resources.add(record);
        record.pins.add(frame);
        for (const dependency of record.dependencies) this.#pinRecord(frame, dependency);
    }

    #lease(lease: ByteLease): LeaseRecord {
        this.#checkCount(lease.id);
        this.#checkCount(lease.bytes);
        const known = this.#leases.get(lease);
        if (known) {
            if (known.id !== lease.id || known.bytes !== lease.bytes) throw new ArenaError('invalid-input');
            return known;
        }
        if (this.#leaseIds.has(lease.id)) throw new ArenaError('invalid-input');
        const record: LeaseRecord = {
            lease, id: lease.id, bytes: lease.bytes, live: 0, retiring: 0,
            resources: 0, closed: false, returned: false,
        };
        this.#leases.set(lease, record);
        this.#leaseIds.set(lease.id, record);
        return record;
    }

    #returnLease(lease: LeaseRecord): void {
        if (!lease.closed || lease.resources !== 0 || lease.returned) return;
        // Mark before the callback so re-entrant close/abandon never returns a lease twice.
        lease.returned = true;
        this.#leaseIds.delete(lease.id);
        this.#releaseLease(lease.lease);
    }

    #collectRecord(record: ResourceRecord<O>, completed: Map<number, boolean>): void {
        if (this.#abandoned || record.state !== 'retiring' || record.creating || record.collecting ||
            record.pins.size || record.references) return;
        // Backend/owner callbacks may re-enter cleanup; only one collector can own deletion.
        record.collecting = true;
        try {
            if (record.serial !== 0) {
                let ready = completed.get(record.serial);
                if (ready === undefined) {
                    ready = this.#backend.completed(record.serial);
                    completed.set(record.serial, ready);
                }
                if (!ready) return;
            }
            // A synchronous completion callback may already have abandoned the generation.
            if (this.#abandoned) return;
            if (record.object !== null) this.#backend.destroy(record.kind, record.object);
            if (this.#abandoned) return;
            record.object = null;
            record.state = 'destroyed';
            record.lease.retiring -= record.bytes;
            record.lease.resources--;
            this.#retiringBytes -= record.bytes;
            this.#retiring.delete(record);
            this.#records.delete(record.handle.id);
            this.#freeSlots.push(record.slot);
            for (const dependency of record.dependencies) dependency.references--;
            this.#returnLease(record.lease);
            // Dependencies are texture leaves; freeing a parent may make them eligible now,
            // even when they appeared earlier in this collection's insertion order.
            for (const dependency of record.dependencies) this.#collectRecord(dependency, completed);
        } catch (error) {
            if (error instanceof ArenaError && error.code === 'lost') this.abandon();
            throw error instanceof ArenaError ? error : new ArenaError('allocation');
        } finally {
            record.collecting = false;
        }
    }
}
