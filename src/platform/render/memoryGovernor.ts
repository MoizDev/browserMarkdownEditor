import { RENDER_CONSTANTS as POLICY } from './constants';
import type { ByteLease } from './gfx/api';
import type { ArenaMemory } from './resourceArena';
import type { RenderToken } from './types';

export type MemoryPool = 'gpu' | 'cpu';
export type MemoryClass = 'hidden-mirror' | 'obsolete-arrival' | 'offscreen-high' |
    'redundant-level' | 'prefetch' | 'scene-cache' | 'critical';
export type MemoryKind = 'working' | 'canvas-working' | 'program' | 'context' | 'surface' | 'mirror' | 'mirror-retiring' | 'capture';
export type MemorySessionOwner = Readonly<Pick<RenderToken, 'vaultEpoch' | 'documentId' | 'session'>>;
export type MemoryPressureState = 'normal' | 'trimming' | 'degraded' | 'cpu-pinned';
export type DeviceMemoryClass = 'low' | 'medium' | 'high';

/** The exact token object crosses the arena boundary; never reconstruct a ByteLease by id. */
export interface MemoryAllocator {
    reserve(bytes: number): ByteLease | null;
    release(lease: ByteLease): void;
}

export interface CacheActivity {
    readonly hiddenAt: number | null;
    readonly lastVisibleAt: number;
    readonly lastUsedAt: number;
}

/** One O(1) cache counter, not one registration per tile. The session remains the bitmap owner. */
export interface MemoryCacheRegistration extends CacheActivity {
    /** Session/device-scoped identity, never a file path; a graph trip does not close mirror caches. */
    readonly id: string;
    readonly pool: MemoryPool;
    readonly kind: MemoryKind;
    readonly class: MemoryClass;
    readonly paneId?: string;
    readonly owner?: MemorySessionOwner;
    readonly memory: () => ArenaMemory;
    /** Synchronous eviction request. Only returned leases free capacity, not this call's return. */
    readonly evict: (bytes: number) => void;
}

export interface MemoryCacheReadout extends ArenaMemory {
    readonly reservedBytes: number;
    readonly leaseCount: number;
    readonly closed: boolean;
}

export interface MemoryCacheHandle extends MemoryAllocator {
    readout(): MemoryCacheReadout;
    updateActivity(activity: CacheActivity): void;
    /** Stops new admissions; outstanding GPU leases still wait for arena completion. */
    close(): void;
}

export interface PaneMemoryDemand {
    readonly paneId: string;
    readonly visible: boolean;
    readonly focused: boolean;
    readonly requestedPixels: number;
    readonly gpuNeedBytes: number;
    readonly cpuNeedBytes: number;
    /** Visible working set; optional excess in cpuNeedBytes is shared only after mandatory demand. */
    readonly cpuMandatoryBytes?: number;
    /** The broker/session owns the loss circuit; pressure cannot pin unrelated documents. */
    readonly cpuPinned: boolean;
}

export interface PaneMemoryGrant {
    readonly paneId: string;
    /** Both GPU and 2D displayed surfaces need a backing-pixel grant. */
    readonly pixelGrant: number;
    readonly gpuEligible: boolean;
    /** Admission targets; previously submitted retiring allocations remain in the pool ledger. */
    readonly gpuCacheBytes: number;
    readonly cpuBytes: number;
    readonly qualityScale: number;
    readonly state: MemoryPressureState;
    readonly qualityNotice: boolean;
}

export interface PoolMemoryReadout {
    readonly targetBytes: number;
    readonly effectiveBytes: number;
    readonly chargedBytes: number;
    readonly workingBytes: number;
    readonly retiringBytes: number;
    /** Queued work plus unused reserved lease capacity, never charged a second time. */
    readonly queuedBytes: number;
    readonly surfaceReserveBytes: number;
    readonly contextReserveBytes: number;
    readonly programAllocationBytes: number;
}

export interface MemoryReadout {
    readonly deviceClass: DeviceMemoryClass;
    readonly state: Exclude<MemoryPressureState, 'cpu-pinned'>;
    readonly lastTrouble: MemoryTrouble | null;
    readonly gpu: PoolMemoryReadout;
    readonly cpu: PoolMemoryReadout;
    readonly hiddenMirrorBytes: number;
    readonly borrowedRetiringBytes: number;
    readonly hiddenMirrorLimitBytes: number;
    readonly workerHeapBytes: number;
    readonly sourceBytes: number;
}

export type MemoryTrouble = 'allocation' | 'framebuffer' | 'context-loss' | 'capability' | 'slow-gpu' | 'stalled-fence';

interface CacheRecord {
    readonly registration: MemoryCacheRegistration;
    activity: CacheActivity;
    bytes: number;
    leaseCount: number;
    closed: boolean;
    readonly handle: MemoryCacheHandle;
}

interface LeaseRecord {
    cache: CacheRecord;
    readonly bytes: number;
    returned: boolean;
}

interface Share {
    readonly id: string;
    readonly need: number;
    readonly weight: number;
}

export class MemoryAdmissionError extends Error {
    constructor(readonly code: 'invalid-input' | 'invalid-lease' | 'foreign-owner' | 'unaccounted') {
        super(code);
        this.name = 'MemoryAdmissionError';
    }
}

function count(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new MemoryAdmissionError('invalid-input');
}

function activityValid(activity: CacheActivity): void {
    if ((activity.hiddenAt !== null && !Number.isFinite(activity.hiddenAt)) ||
        !Number.isFinite(activity.lastVisibleAt) || !Number.isFinite(activity.lastUsedAt)) {
        throw new MemoryAdmissionError('invalid-input');
    }
}

/** Need-capped weighted water filling (§6.3:640–641); integer remainders use stable ids. */
function waterFill(items: readonly Share[], capacity: number): Map<string, number> {
    const grants = new Map(items.map(item => [item.id, 0]));
    let active = items.filter(item => item.need > 0);
    let remaining = Math.max(0, Math.floor(capacity));
    while (active.length && remaining > 0) {
        const weights = active.reduce((sum, item) => sum + item.weight, 0);
        const full = active.filter(item => item.need <= remaining * item.weight / weights);
        if (full.length) {
            for (const item of full) {
                grants.set(item.id, item.need);
                remaining -= item.need;
            }
            const ids = new Set(full.map(item => item.id));
            active = active.filter(item => !ids.has(item.id));
            continue;
        }
        const allowance = remaining;
        for (const item of active) {
            const grant = Math.floor(allowance * item.weight / weights);
            grants.set(item.id, grant);
            remaining -= grant;
        }
        // Floor leaves fewer than one byte/pixel per participating pane.
        for (const item of [...active].sort((a, b) => stableId(a.id, b.id))) {
            if (!remaining) break;
            grants.set(item.id, grants.get(item.id)! + 1);
            remaining--;
        }
        break;
    }
    return grants;
}

function stableId(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** No navigator/DOM/timers: the app passes the coarsened hint once and advances the clock explicitly. */
export class MemoryGovernor {
    readonly deviceClass: DeviceMemoryClass;
    private readonly caches = new Map<string, CacheRecord>();
    private readonly leases = new WeakMap<ByteLease, LeaseRecord>();
    private readonly cacheHandles = new WeakMap<MemoryCacheHandle, CacheRecord>();
    private readonly charged = { gpu: 0, cpu: 0 };
    private readonly target: { gpu: number; cpu: number } = { gpu: POLICY.gpuGrantMinBytes, cpu: POLICY.cpuGrantMinBytes };
    private readonly ceilings: Readonly<{ gpuBytes: number; cpuRasterBytes: number }>;
    private panes: readonly PaneMemoryDemand[] = [];
    private grants = new Map<string, PaneMemoryGrant>();
    private nextLease = 1;
    private trimming = false;
    private state: Exclude<MemoryPressureState, 'cpu-pinned'> = 'normal';
    private lastTrouble: MemoryTrouble | null = null;
    private qualityLimit = 1;
    private belowRecoverySince: number | null = null;
    private now = 0;
    private workerHeapBytes = 0;
    private readonly workerHeaps = new Map<object, number>();
    private readonly legacyWorker = {};
    private sourceBytes = 0;

    constructor(deviceMemory: unknown, private readonly onPressureChange?: () => void) {
        // Chromium reports rounded/capped hints (historically at 8 GiB), not installed RAM (§6.2:607).
        const hint = typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory : 0;
        this.deviceClass = hint >= POLICY.deviceMemoryHighGiB ? 'high' :
            hint >= POLICY.deviceMemoryMiddleGiB ? 'medium' : 'low';
        this.ceilings = POLICY.memoryCeilings[this.deviceClass];
    }

    register(registration: MemoryCacheRegistration): MemoryCacheHandle {
        activityValid(registration);
        if (registration.owner) {
            count(registration.owner.vaultEpoch);
            count(registration.owner.session);
            if (!registration.owner.documentId) throw new MemoryAdmissionError('invalid-input');
        }
        if (!registration.id || this.caches.has(registration.id) ||
            (['mirror', 'mirror-retiring'].includes(registration.kind) && registration.pool !== 'cpu') ||
            (['program', 'context', 'surface', 'canvas-working'].includes(registration.kind) && registration.pool !== 'gpu') ||
            (registration.pool === 'gpu' && registration.kind !== 'context' && !registration.paneId)) {
            throw new MemoryAdmissionError('invalid-input');
        }
        const cache: CacheRecord = {
            registration: { ...registration, owner: registration.owner ? Object.freeze({ ...registration.owner }) : undefined },
            activity: { ...registration }, bytes: 0, leaseCount: 0, closed: false,
            handle: {
                reserve: bytes => this.reserve(cache, bytes),
                release: lease => this.release(lease, cache),
                readout: () => this.cacheReadout(cache),
                updateActivity: activity => {
                    activityValid(activity);
                    if (cache.closed) return;
                    cache.activity = { ...activity };
                    this.trimHiddenMirrors();
                },
                close: () => {
                    if (cache.closed) return;
                    cache.closed = true;
                    if (!cache.leaseCount) this.caches.delete(registration.id);
                },
            },
        };
        this.caches.set(registration.id, cache);
        this.cacheHandles.set(cache.handle, cache);
        return cache.handle;
    }

    /** N/P are app-visible geometry, never browser-window visibility (§6.2:615). */
    updatePanes(panes: readonly PaneMemoryDemand[]): void {
        const ids = new Set<string>();
        let pixels = 0;
        let visible = 0;
        for (const pane of panes) {
            count(pane.requestedPixels);
            count(pane.gpuNeedBytes);
            count(pane.cpuNeedBytes);
            if (pane.cpuMandatoryBytes !== undefined) {
                count(pane.cpuMandatoryBytes);
                if (pane.cpuMandatoryBytes > pane.cpuNeedBytes) throw new MemoryAdmissionError('invalid-input');
            }
            if (!pane.paneId || ids.has(pane.paneId)) throw new MemoryAdmissionError('invalid-input');
            ids.add(pane.paneId);
            if (pane.visible && pane.requestedPixels > 0) { pixels += pane.requestedPixels; visible++; }
        }
        count(pixels);
        if (visible > POLICY.maxVisiblePaneContexts) throw new MemoryAdmissionError('invalid-input');
        this.panes = panes.map(pane => ({ ...pane }));
        this.target.gpu = Math.min(this.ceilings.gpuBytes, Math.max(POLICY.gpuGrantMinBytes,
            POLICY.gpuGrantBaseBytes + POLICY.gpuGrantPerVisiblePaneBytes * visible + POLICY.gpuGrantPerVisiblePixelBytes * pixels));
        this.target.cpu = Math.min(this.ceilings.cpuRasterBytes, Math.max(POLICY.cpuGrantMinBytes,
            POLICY.cpuGrantPerVisiblePaneBytes * visible + POLICY.cpuGrantPerVisiblePixelBytes * pixels));
        this.plan();
        this.trimHiddenMirrors();
        for (const pool of ['gpu', 'cpu'] as const) {
            if (this.charged[pool] > this.target[pool]) this.trimPool(pool, this.target[pool]);
        }
    }

    grant(paneId: string): PaneMemoryGrant | null { return this.grants.get(paneId) ?? null; }

    /** Arena close&&zero callback, never arena.release(handle) (§6.1:603; R-B2 lease seam). */
    releaseLease(lease: ByteLease): void { this.release(lease); }

    /** Ownership handoff, NOT an allocation/copy. The old cache loses release authority (§6.4:649).
     * Closing borrowed mirrors moves their charge to CPU retirement until the last borrow drains.
     */
    transferLease(lease: ByteLease, target: MemoryCacheHandle): boolean {
        const record = this.leases.get(lease);
        const destination = this.cacheHandles.get(target);
        if (!record || !destination) throw new MemoryAdmissionError('invalid-lease');
        if (record.returned || destination.closed || this.caches.get(destination.registration.id) !== destination) return false;
        const source = record.cache;
        if (source.registration.pool !== 'cpu' || destination.registration.pool !== 'cpu') throw new MemoryAdmissionError('invalid-input');
        const from = source.registration.owner;
        const to = destination.registration.owner;
        if (!from || !to || from.vaultEpoch !== to.vaultEpoch || from.documentId !== to.documentId || from.session !== to.session) {
            throw new MemoryAdmissionError('foreign-owner');
        }
        if (source === destination) return true;
        if (destination.registration.kind === 'mirror') {
            if (this.trimming || this.charged.cpu > this.target.cpu) return false;
            const incoming = destination.activity.hiddenAt !== null ? record.bytes : 0;
            const outgoing = source.registration.kind === 'mirror' && source.activity.hiddenAt !== null ? record.bytes : 0;
            this.trimHiddenMirrors(Math.max(0, incoming - outgoing));
            if (record.returned || destination.closed || record.cache !== source ||
                this.hiddenMirrorBytes() + incoming - outgoing > this.hiddenMirrorLimit()) return false;
        }
        source.bytes -= record.bytes;
        source.leaseCount--;
        destination.bytes += record.bytes;
        destination.leaseCount++;
        record.cache = destination;
        if (source.closed && !source.leaseCount) this.caches.delete(source.registration.id);
        return true;
    }

    /** A detached browser canvas is working scratch until it becomes the one displayed surface.
     * Promotion keeps the SAME tokens and total charge; arena-owned GPU resources never use it.
     * The caller has already zeroed the previous displayed backing in the atomic canvas swap.
     */
    promoteCanvasBacking(leases: readonly ByteLease[], target: MemoryCacheHandle): boolean {
        const destination = this.cacheHandles.get(target);
        if (!destination || destination.registration.pool !== 'gpu' || destination.registration.kind !== 'surface') {
            throw new MemoryAdmissionError('invalid-input');
        }
        if (destination.closed || this.caches.get(destination.registration.id) !== destination) return false;
        if (new Set(leases).size !== leases.length) throw new MemoryAdmissionError('invalid-lease');
        const records = leases.map(lease => {
            const record = this.leases.get(lease);
            if (!record) throw new MemoryAdmissionError('invalid-lease');
            return record;
        });
        const owner = destination.registration.owner;
        for (const record of records) {
            const source = record.cache.registration;
            if (record.returned) return false;
            if (source.pool !== 'gpu' || source.kind !== 'canvas-working' || source.paneId !== destination.registration.paneId ||
                !owner || !source.owner || owner.vaultEpoch !== source.owner.vaultEpoch || owner.documentId !== source.owner.documentId ||
                owner.session !== source.owner.session || record.bytes % POLICY.surfaceReserveBytesPerPixel !== 0) {
                throw new MemoryAdmissionError('foreign-owner');
            }
        }
        const paneId = destination.registration.paneId;
        const pane = this.panes.find(pane => pane.paneId === paneId);
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
        const displayed = [...this.caches.values()].filter(cache => cache.registration.paneId === paneId &&
            cache.registration.kind === 'surface').reduce((sum, cache) => sum + cache.bytes, 0);
        if (!pane?.visible || !grant || destination.activity.hiddenAt !== null || this.charged.gpu > this.target.gpu ||
            displayed + bytes > grant.pixelGrant * POLICY.surfaceReserveBytesPerPixel) return false;
        for (const record of records) {
            const source = record.cache;
            source.bytes -= record.bytes;
            source.leaseCount--;
            destination.bytes += record.bytes;
            destination.leaseCount++;
            record.cache = destination;
            if (source.closed && !source.leaseCount) this.caches.delete(source.registration.id);
        }
        return true;
    }

    /** Estimates are owned/WASM bytes, not the browser's unobservable real JS heap. */
    reportWorkerMemory(worker: object, ownedBytes: number): void {
        if (typeof worker !== 'object' || worker === null) throw new MemoryAdmissionError('invalid-input');
        count(ownedBytes);
        const previous = this.workerHeaps.get(worker) ?? 0;
        const total = this.workerHeapBytes - previous + ownedBytes;
        const charged = this.charged.cpu - previous + ownedBytes;
        count(total);
        count(charged);
        if (ownedBytes) this.workerHeaps.set(worker, ownedBytes);
        else this.workerHeaps.delete(worker);
        this.workerHeapBytes = total;
        this.charged.cpu = charged;
        if (previous !== ownedBytes) this.onPressureChange?.();
    }

    releaseWorkerMemory(worker: object): void { this.reportWorkerMemory(worker, 0); }

    reportExternalHeaps(workerHeapBytes: number, sourceBytes: number): void {
        count(sourceBytes);
        this.reportWorkerMemory(this.legacyWorker, workerHeapBytes);
        this.sourceBytes = sourceBytes;
    }

    /** Called by the shared scheduler, not a governor-owned timer (§6.4:653). */
    advance(now: number, liveGesture: boolean): void {
        if (!Number.isFinite(now) || now < this.now) throw new MemoryAdmissionError('invalid-input');
        this.now = now;
        this.trimHiddenMirrors();
        for (const pool of ['gpu', 'cpu'] as const) {
            if (this.charged[pool] > this.target[pool] * POLICY.memorySoftPressureRatio) {
                this.state = 'trimming';
                this.trimPool(pool, Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio));
            }
        }
        if (this.charged.gpu > this.target.gpu || this.charged.cpu > this.target.cpu) this.degrade();
        const cool = this.charged.gpu < this.target.gpu * POLICY.memoryRecoveryRatio &&
            this.charged.cpu < this.target.cpu * POLICY.memoryRecoveryRatio && !liveGesture;
        if (!cool) this.belowRecoverySince = null;
        else if (this.belowRecoverySince === null) this.belowRecoverySince = now;
        else if (now - this.belowRecoverySince >= POLICY.memoryRecoveryDelayMs) {
            this.qualityLimit = Math.min(1, this.qualityLimit / POLICY.qualityReductionFactor);
            this.state = this.qualityLimit < 1 ? 'degraded' : 'normal';
            if (this.state === 'normal') this.lastTrouble = null;
            this.belowRecoverySince = now;
            this.plan();
        }
    }

    signalTrouble(reason: MemoryTrouble): void {
        this.lastTrouble = reason;
        this.state = 'trimming';
        this.belowRecoverySince = null;
        for (const pool of ['gpu', 'cpu'] as const) {
            this.trimPool(pool, Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio));
        }
        this.degrade();
    }

    observeGpuTiming(p95Ms: number, frameIntervalMs: number, samples: number, disjoint: boolean): void {
        if (disjoint) return;
        if (!Number.isFinite(p95Ms) || p95Ms < 0 || !Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
            throw new MemoryAdmissionError('invalid-input');
        }
        count(samples);
        if (samples >= POLICY.slowGpuSampleCount && p95Ms > frameIntervalMs) this.signalTrouble('slow-gpu');
    }

    observeFence(oldestPendingMs: number, mainThreadInputHealthy: boolean): void {
        if (!Number.isFinite(oldestPendingMs) || oldestPendingMs < 0) throw new MemoryAdmissionError('invalid-input');
        if (mainThreadInputHealthy && oldestPendingMs > POLICY.stalledFenceMs) this.signalTrouble('stalled-fence');
    }

    /** O(number of registered caches), never a walk of their tile/resource entries (§6.1:603). */
    readout(): MemoryReadout {
        const gpu = this.poolReadout('gpu');
        const cpu = this.poolReadout('cpu');
        return {
            deviceClass: this.deviceClass, state: this.state, lastTrouble: this.lastTrouble, gpu, cpu,
            hiddenMirrorBytes: this.hiddenMirrorBytes(), borrowedRetiringBytes: this.kindBytes('mirror-retiring'),
            hiddenMirrorLimitBytes: this.hiddenMirrorLimit(),
            workerHeapBytes: this.workerHeapBytes, sourceBytes: this.sourceBytes,
        };
    }

    private cacheReadout(cache: CacheRecord): MemoryCacheReadout {
        const { live, retiring } = cache.registration.memory();
        count(live);
        count(retiring);
        // Publication without a covering reservation is a product failure, not a test hook.
        if (live + retiring > cache.bytes) throw new MemoryAdmissionError('unaccounted');
        return { live, retiring, reservedBytes: cache.bytes, leaseCount: cache.leaseCount, closed: cache.closed };
    }

    private poolReadout(pool: MemoryPool): PoolMemoryReadout {
        let workingBytes = pool === 'cpu' ? this.workerHeapBytes : 0;
        let retiringBytes = 0;
        let attributed = workingBytes;
        let contextReserveBytes = 0;
        let surfaceReserveBytes = 0;
        let programAllocationBytes = 0;
        for (const cache of this.caches.values()) {
            if (cache.registration.pool !== pool) continue;
            const { live, retiring } = this.cacheReadout(cache);
            const kind = cache.registration.kind;
            if (kind === 'context') contextReserveBytes += cache.bytes;
            else if (kind === 'surface') surfaceReserveBytes += cache.bytes;
            else {
                attributed += live + retiring;
                retiringBytes += retiring;
                if (kind === 'program') programAllocationBytes += live;
                else workingBytes += live;
            }
        }
        return {
            targetBytes: this.target[pool],
            // A shrinking formula cannot make an already-submitted driver allocation disappear.
            effectiveBytes: Math.min(pool === 'gpu' ? this.ceilings.gpuBytes : this.ceilings.cpuRasterBytes,
                Math.max(this.target[pool], this.charged[pool])),
            chargedBytes: this.charged[pool], workingBytes, retiringBytes,
            queuedBytes: this.charged[pool] - contextReserveBytes - surfaceReserveBytes - attributed,
            surfaceReserveBytes, contextReserveBytes, programAllocationBytes,
        };
    }

    private reserve(cache: CacheRecord, bytes: number): ByteLease | null {
        count(bytes);
        if (cache.closed || this.trimming || cache.registration.kind === 'mirror-retiring' || !this.caches.has(cache.registration.id)) return null;
        const { kind, pool } = cache.registration;
        if (kind === 'context' && bytes !== POLICY.keptContextReserveBytes) throw new MemoryAdmissionError('invalid-input');
        if (kind === 'surface' && bytes % POLICY.surfaceReserveBytesPerPixel !== 0) throw new MemoryAdmissionError('invalid-input');
        const allowed = () => this.fits(cache, bytes);
        if (!allowed()) {
            this.state = 'trimming';
            this.belowRecoverySince = null;
            this.trimPool(pool, Math.max(0, Math.min(this.target[pool] - bytes,
                Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio))));
            this.trimHiddenMirrors(kind === 'mirror' && cache.activity.hiddenAt !== null ? bytes : 0);
            if (!allowed()) {
                this.lastTrouble = 'allocation';
                this.degrade();
                this.onPressureChange?.();
                return null;
            }
        }
        if (!Number.isSafeInteger(this.nextLease)) throw new MemoryAdmissionError('invalid-input');
        const lease = Object.freeze({ id: this.nextLease++, bytes });
        this.leases.set(lease, { cache, bytes, returned: false });
        cache.bytes += bytes;
        cache.leaseCount++;
        this.charged[pool] += bytes;
        // Context overhead reduces the next surface/cache plan before any device is created.
        if (kind === 'context' || kind === 'program') this.plan();
        if (this.charged[pool] > this.target[pool] * POLICY.memorySoftPressureRatio) this.onPressureChange?.();
        return lease;
    }

    private fits(cache: CacheRecord, bytes: number): boolean {
        const { pool, kind, paneId } = cache.registration;
        // Existing leases are grandfathered only for accounting, never for new admission.
        if (this.charged[pool] > this.target[pool] || this.charged[pool] + bytes > this.target[pool]) return false;
        // The broker's one app-wide allocator owns all reservations, including lost ones (§3.3:360).
        if (kind === 'context') {
            const held = this.kindBytes('context');
            return held + bytes <= (POLICY.maxAppContexts - POLICY.reservedTerminalContexts) * POLICY.keptContextReserveBytes;
        }
        const pane = this.panes.find(item => item.paneId === paneId);
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (pool === 'gpu' && (cache.activity.hiddenAt !== null || !pane?.visible || !pane.requestedPixels ||
            (pane.cpuPinned && kind !== 'surface' && kind !== 'canvas-working'))) return false;
        if (kind === 'mirror' && cache.activity.hiddenAt !== null &&
            this.hiddenMirrorBytes() + bytes > this.hiddenMirrorLimit()) return false;
        if (paneId === undefined || kind === 'program') return true;
        if (pool === 'gpu' && !grant?.pixelGrant) return false;
        if (pool === 'cpu' && (cache.activity.hiddenAt !== null || !pane?.visible)) return true;
        if (!grant) return false;
        const limit = kind === 'surface' ? grant.pixelGrant * POLICY.surfaceReserveBytesPerPixel :
            pool === 'gpu' ? grant.gpuCacheBytes : grant.cpuBytes;
        const used = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
            other.registration.pool === pool && other.activity.hiddenAt === null && (kind === 'surface' ? other.registration.kind === 'surface' :
                !['surface', 'program', 'context'].includes(other.registration.kind)))
            .reduce((sum, other) => sum + other.bytes, 0);
        if (pool === 'gpu' && kind === 'capture') {
            const captures = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
                other.registration.kind === 'capture' && other.activity.hiddenAt === null).reduce((sum, other) => sum + other.bytes, 0);
            if (captures + bytes > Math.max(0, grant.gpuCacheBytes - this.minimumProgressBytes())) return false;
        }
        return used + bytes <= limit;
    }

    private release(lease: ByteLease, expected?: CacheRecord): void {
        const record = this.leases.get(lease);
        if (!record || (expected && record.cache !== expected)) throw new MemoryAdmissionError('invalid-lease');
        if (record.returned) return;
        record.returned = true;
        const cache = record.cache;
        cache.bytes -= record.bytes;
        cache.leaseCount--;
        this.charged[cache.registration.pool] -= record.bytes;
        if (cache.closed && !cache.leaseCount) this.caches.delete(cache.registration.id);
        if (!this.trimming && ['context', 'program'].includes(cache.registration.kind)) this.plan();
        if (this.state !== 'normal') this.onPressureChange?.();
    }

    private hiddenMirrorBytes(): number {
        let bytes = 0;
        for (const cache of this.caches.values()) {
            if (cache.registration.kind === 'mirror' && cache.activity.hiddenAt !== null) bytes += cache.bytes;
        }
        return bytes;
    }

    private hiddenMirrorLimit(): number { return Math.min(POLICY.hiddenCpuMirrorLimitBytes, this.ceilings.cpuRasterBytes); }

    private trimHiddenMirrors(incoming = 0): void {
        if (this.trimming) return;
        const candidates = [...this.caches.values()].filter(cache => cache.registration.kind === 'mirror' &&
            cache.activity.hiddenAt !== null && cache.bytes > 0)
            .sort((a, b) => a.activity.hiddenAt! - b.activity.hiddenAt! || stableId(a.registration.id, b.registration.id));
        this.trimming = true;
        try {
            for (const cache of candidates) {
                const excess = this.hiddenMirrorBytes() + incoming - this.hiddenMirrorLimit();
                if (excess <= 0) break;
                // Session eviction drops exact pixels, then low levels, without touching model/undo.
                cache.registration.evict(excess);
            }
        } finally { this.trimming = false; }
    }

    private trimPool(pool: MemoryPool, target: number): void {
        if (this.trimming) return;
        const order: readonly MemoryClass[] = ['hidden-mirror', 'obsolete-arrival', 'offscreen-high',
            'redundant-level', 'prefetch', 'scene-cache', 'critical'];
        const evictionClass = (cache: CacheRecord): MemoryClass => cache.registration.kind === 'mirror' && cache.activity.hiddenAt !== null ?
            'hidden-mirror' : cache.registration.class;
        const candidates = [...this.caches.values()].filter(cache => cache.registration.pool === pool &&
            evictionClass(cache) !== 'critical' && cache.bytes > 0 &&
            (evictionClass(cache) !== 'hidden-mirror' || cache.activity.hiddenAt !== null) &&
            (cache.registration.kind !== 'context' || cache.registration.paneId === undefined || cache.activity.hiddenAt !== null))
            .sort((a, b) => order.indexOf(evictionClass(a)) - order.indexOf(evictionClass(b)) ||
                (evictionClass(a) === 'hidden-mirror' ? (a.activity.hiddenAt ?? Infinity) - (b.activity.hiddenAt ?? Infinity) : 0) ||
                a.activity.lastVisibleAt - b.activity.lastVisibleAt || a.activity.lastUsedAt - b.activity.lastUsedAt ||
                b.bytes - a.bytes || stableId(a.registration.id, b.registration.id));
        this.trimming = true;
        try {
            for (const cache of candidates) {
                const excess = this.charged[pool] - target;
                if (excess <= 0) break;
                // The owner protects its last visible coverage provider and capture/live-input pins.
                cache.registration.evict(excess);
            }
        } finally { this.trimming = false; this.plan(); }
    }

    private kindBytes(kind: MemoryKind): number {
        let bytes = 0;
        for (const cache of this.caches.values()) if (cache.registration.kind === kind) bytes += cache.bytes;
        return bytes;
    }

    private degrade(): void {
        this.state = 'degraded';
        this.belowRecoverySince = null;
        this.qualityLimit = Math.max(POLICY.minInteractiveQualityScale, this.qualityLimit * POLICY.qualityReductionFactor);
        this.plan();
    }

    private minimumProgressBytes(): number {
        const edge = POLICY.tileInteriorPixels + 2 * POLICY.tileGutterTexels;
        return POLICY.minPaneTileCredits * edge * edge * POLICY.decodedRgbaBytesPerPixel + POLICY.liveVectorScratchBytes;
    }

    private plan(): void {
        const visible = this.panes.filter(pane => pane.visible && pane.requestedPixels > 0);
        const weight = (pane: PaneMemoryDemand) => pane.focused ? POLICY.focusedPaneWeight : POLICY.unfocusedPaneWeight;
        const minimum = this.minimumProgressBytes();
        const overhead = this.kindBytes('context') + this.kindBytes('program');
        let remaining = Math.max(0, this.target.gpu - overhead);
        const supported: PaneMemoryDemand[] = [];
        for (const pane of [...visible].sort((a, b) => weight(b) - weight(a) || stableId(a.paneId, b.paneId))) {
            if (remaining < minimum) continue;
            supported.push(pane);
            remaining -= minimum;
        }
        const surfaceBytes = Math.min(Math.floor(this.target.gpu * POLICY.surfaceMaxGpuGrantFraction), remaining);
        // Denying GL must not deny a 2D drawing buffer (§6.3:641); both paths share this cap.
        const pixels = waterFill(visible.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.floor(pane.requestedPixels * this.qualityLimit * this.qualityLimit) })),
        Math.floor(surfaceBytes / POLICY.surfaceReserveBytesPerPixel));
        const assignedSurface = [...pixels.values()].reduce((sum, value) => sum + value, 0) * POLICY.surfaceReserveBytesPerPixel;
        const cache = waterFill(supported.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.max(0, pane.gpuNeedBytes - minimum) })), Math.max(0, remaining - assignedSurface));
        const cpu = waterFill(visible.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: pane.cpuMandatoryBytes ?? pane.cpuNeedBytes })), this.target.cpu);
        const mandatoryAssigned = [...cpu.values()].reduce((sum, value) => sum + value, 0);
        const optional = waterFill(visible.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: pane.cpuNeedBytes - (pane.cpuMandatoryBytes ?? pane.cpuNeedBytes) })), this.target.cpu - mandatoryAssigned);
        for (const [id, bytes] of optional) cpu.set(id, (cpu.get(id) ?? 0) + bytes);
        this.grants = new Map(this.panes.map(pane => {
            const pixelGrant = pixels.get(pane.paneId) ?? 0;
            const q = pane.requestedPixels ? Math.sqrt(pixelGrant / pane.requestedPixels) : 0;
            const hasCacheCredit = pixelGrant > 0 && supported.includes(pane);
            const gpuEligible = hasCacheCredit && !pane.cpuPinned;
            return [pane.paneId, Object.freeze({
                paneId: pane.paneId, pixelGrant, gpuEligible,
                // Browser-managed 2D scratch needs the same logical G credit even without WebGL (§10).
                gpuCacheBytes: hasCacheCredit ? minimum + (cache.get(pane.paneId) ?? 0) : 0,
                cpuBytes: cpu.get(pane.paneId) ?? 0, qualityScale: q,
                state: pane.cpuPinned ? 'cpu-pinned' as const :
                    pane.visible && pane.requestedPixels > 0 && q < 1 ? 'degraded' as const : this.state,
                qualityNotice: pane.visible && pane.requestedPixels > 0 && q < POLICY.minInteractiveQualityScale,
            })];
        }));
    }
}
