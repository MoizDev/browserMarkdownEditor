import { RENDER_CONSTANTS as POLICY } from './constants';
import type { ByteLease } from './gfx/api';
import { auditCount } from './renderAudit';
import type { ArenaMemory } from './resourceArena';
import { layerTroubleOf } from './types';
import { MIN_SURFACE_QUALITY } from './surfaceMetrics';
import type { LayerTrouble, RenderToken } from './types';

export type MemoryPool = 'gpu' | 'cpu';
export type MemoryClass = 'hidden-mirror' | 'obsolete-arrival' | 'offscreen-high' |
    'redundant-level' | 'prefetch' | 'scene-cache' | 'critical';
export type MemoryKind = 'working' | 'canvas-working' | 'program' | 'context' | 'surface' | 'mirror' | 'mirror-retiring' | 'capture' |
    /** A live gesture's working set (wet ink). Bounded by the pool, outside its pane's cache grant: it is released only
     * after the committed layers present the dry frame, so charging it to the grant those layers need was a cycle
     * (measured: 101 wet-tile refusals in one stroke with the pool 57% full, then the stroke's tail never drew). */
    'live-input';
export type MemorySessionOwner = Readonly<Pick<RenderToken, 'vaultEpoch' | 'documentId' | 'session'>>;
export type MemoryPressureState = 'normal' | 'trimming' | 'degraded' | 'cpu-pinned';
export type DeviceMemoryClass = 'low' | 'medium' | 'high';

/** The exact token object crosses the arena boundary; never reconstruct a ByteLease by id. */
export interface MemoryAllocator {
    reserve(bytes: number): ByteLease | null;
    release(lease: ByteLease): void;
    /** One-shot: `wake` runs once after the next lease release or grant change, so a denied owner retries on a real
     * capacity change instead of polling. It only schedules work, so it must not reserve synchronously.
     * With `bytes`, it waits until that much would actually be admitted: waking on every release made a refused
     * 1 MB tile retry each frame while unrelated small leases churned, and the pane never idled (measured: 180
     * presents in 3 s at rest on a ~12k-item board, all from that wake). */
    whenAvailable?(wake: () => void, bytes?: number): void;
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
    /** Eviction request for up to `bytes`; returns the bytes it frees, or 0 when it frees nothing (a touched entry).
     * An owner that returns nothing is counted as having freed its ask, up to its cache's size: see evictCache. */
    readonly evict: (bytes: number) => number | void;
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
    /** The GPU bytes this pane's visible positions at the current scale pin: granted before the surface share and before any
     * other scale or off-view ring, and never trimmed while the pane is visible. Absent: nothing is pinned. */
    readonly gpuPinnedBytes?: number;
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
    /** The last refusal of this cache: the capacity epoch it was refused in, and the size. Until capacity changes, the same
     * or a larger request is refused without a second round of reclaim and trims. */
    refusal: { readonly epoch: number; readonly bytes: number } | null;
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
    constructor(readonly code: 'invalid-input' | 'invalid-lease' | 'foreign-owner' | 'unaccounted', message: string = code) {
        super(message);
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

/** Every field a grant is planned from; a change in any one re-plans. */
function samePaneDemand(a: PaneMemoryDemand, b: PaneMemoryDemand | undefined): boolean {
    return b !== undefined && a.paneId === b.paneId && a.visible === b.visible && a.focused === b.focused &&
        a.requestedPixels === b.requestedPixels && a.gpuNeedBytes === b.gpuNeedBytes && a.cpuNeedBytes === b.cpuNeedBytes &&
        a.gpuPinnedBytes === b.gpuPinnedBytes &&
        a.cpuMandatoryBytes === b.cpuMandatoryBytes && a.cpuPinned === b.cpuPinned;
}

/** Residency a pane grant may reclaim before it refuses a reservation: never critical, hidden, surface or context. */
const RECLAIMABLE: readonly MemoryClass[] = ['redundant-level', 'prefetch', 'scene-cache'];

/** No navigator/DOM/timers: the app passes the coarsened hint once and advances the clock explicitly. */
export class MemoryGovernor {
    readonly deviceClass: DeviceMemoryClass;
    private readonly caches = new Map<string, CacheRecord>();
    // Denied owners waiting for the next capacity change; each wake is one-shot and removed when it runs.
    // Denied owners per cache, each with the bytes it needs (undefined: any release). One entry per owner however often it
    // asks again while denied; a closed cache's entry is dropped when it closes.
    private readonly capacityWaiters = new Map<CacheRecord, Map<() => void, number | undefined>>();
    private readonly leases = new WeakMap<ByteLease, LeaseRecord>();
    private readonly cacheHandles = new WeakMap<MemoryCacheHandle, CacheRecord>();
    private readonly charged = { gpu: 0, cpu: 0 };
    // Bumped whenever a reservation that was refused could now fit: a lease returned, a grant or demand that moved, a cache
    // that became visible or was transferred. A refusal memo is valid only within the epoch it was taken in.
    private capacityEpoch = 0;
    // The smallest refused request still standing, per pool (Infinity when none). A release can admit a refusal only if its pool
    // would then hold that size: fits() checks the pool first. Releases that leave the pool over it do not move the epoch.
    private readonly refusedFloor: Record<MemoryPool, number> = { gpu: Infinity, cpu: Infinity };
    // Panes by id, rebuilt with the demand: fits() and the transfer path look one up per call, and a linear find there
    // ran for every waiter on every release.
    private readonly paneById = new Map<string, PaneMemoryDemand>();
    // Each pane's quality ceiling. It falls the moment a pane's pixel grant falls short of its need, and rises only in a
    // recovery step (sustained cool use with no gesture): a pane never steps back up on the next plan that frees bytes.
    private readonly paneCeiling = new Map<string, number>();
    private readonly target: { gpu: number; cpu: number } = { gpu: POLICY.gpuGrantMinBytes, cpu: POLICY.cpuGrantMinBytes };
    private readonly ceilings: Readonly<{ gpuBytes: number; cpuRasterBytes: number }>;
    private panes: readonly PaneMemoryDemand[] = [];
    private grants = new Map<string, PaneMemoryGrant>();
    private nextLease = 1;
    private trimming = false;
    // A run of refused reservations in one pool is one episode: it degrades the governor once, and its retries only wait.
    private readonly refusing: Record<MemoryPool, boolean> = { gpu: false, cpu: false };
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
            activity: { ...registration }, bytes: 0, leaseCount: 0, closed: false, refusal: null,
            handle: {
                reserve: bytes => this.reserve(cache, bytes),
                release: lease => this.release(lease, cache),
                whenAvailable: (wake, bytes) => {
                    if (cache.closed) return;
                    const waiters = this.capacityWaiters.get(cache) ?? new Map<() => void, number | undefined>();
                    waiters.set(wake, bytes);
                    this.capacityWaiters.set(cache, waiters);
                },
                readout: () => this.cacheReadout(cache),
                updateActivity: activity => {
                    activityValid(activity);
                    if (cache.closed) return;
                    cache.activity = { ...activity };
                    this.bumpCapacity();
                    this.trimHiddenMirrors();
                },
                close: () => {
                    if (cache.closed) return;
                    cache.closed = true;
                    // Its owner is told once, after this call, so it can see the closure; a closed cache keeps no waiters.
                    const waiting = this.capacityWaiters.get(cache);
                    if (waiting) {
                        this.capacityWaiters.delete(cache);
                        queueMicrotask(() => { for (const wake of waiting.keys()) wake(); });
                    }
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
        // The scheduler refreshes every frame (snapshotScene), so demand that did not change re-plans nothing: the grants
        // move only with the demand, with degradation and recovery (which plan themselves) and with context/program charges.
        const changed = this.panes.length !== panes.length || panes.some((pane, i) => !samePaneDemand(pane, this.panes[i]));
        this.panes = panes.map(pane => ({ ...pane }));
        this.paneById.clear();
        for (const pane of this.panes) this.paneById.set(pane.paneId, pane);
        for (const id of this.paneCeiling.keys()) if (!ids.has(id)) this.paneCeiling.delete(id);
        if (changed) {
            this.bumpCapacity();
            this.target.gpu = Math.min(this.ceilings.gpuBytes, Math.max(POLICY.gpuGrantMinBytes,
                POLICY.gpuGrantBaseBytes + POLICY.gpuGrantPerVisiblePaneBytes * visible + POLICY.gpuGrantPerVisiblePixelBytes * pixels));
            this.target.cpu = Math.min(this.ceilings.cpuRasterBytes, Math.max(POLICY.cpuGrantMinBytes,
                POLICY.cpuGrantPerVisiblePaneBytes * visible + POLICY.cpuGrantPerVisiblePixelBytes * pixels));
            this.replan();
        }
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
        this.bumpCapacity();
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
        const pane = paneId === undefined ? undefined : this.paneById.get(paneId);
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
            this.bumpCapacity();
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
        count(total);
        if (ownedBytes) this.workerHeaps.set(worker, ownedBytes);
        else this.workerHeaps.delete(worker);
        // C bounds decoded raster, not PDFium's nonshrinking WASM heap (§6.2).
        // A 64 MiB worker otherwise exhausts a small pane's 32 MiB C before its first tile.
        this.workerHeapBytes = total;
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
        // Quality drops only when the trims cannot bring a pool back to target: a trim that frees what it is asked for
        // is the answer to pressure, and a degradation for pressure it has not yet had the chance to release is premature.
        let unmet = false;
        for (const pool of ['gpu', 'cpu'] as const) {
            if (this.charged[pool] > this.target[pool] * POLICY.memorySoftPressureRatio) {
                this.state = 'trimming';
                unmet = this.trimFailed(pool, Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio)) || unmet;
            } else if (this.charged[pool] > this.target[pool]) {
                this.state = 'trimming';
                unmet = this.trimFailed(pool, this.target[pool]) || unmet;
            }
        }
        if (unmet) this.degrade();
        const cool = this.cool() && !liveGesture;
        if (!cool) this.belowRecoverySince = null;
        else if (this.belowRecoverySince === null) this.belowRecoverySince = now;
        else if (now - this.belowRecoverySince >= POLICY.memoryRecoveryDelayMs) {
            this.qualityLimit = Math.min(1, this.qualityLimit / POLICY.qualityReductionFactor);
            for (const [id, value] of this.paneCeiling) this.paneCeiling.set(id, Math.min(1, value / POLICY.qualityReductionFactor));
            this.state = this.qualityLimit < 1 ? 'degraded' : 'normal';
            if (this.state === 'normal') this.lastTrouble = null;
            this.belowRecoverySince = now;
            this.replan();
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
        // Named by cache: the owner that published bytes its reservation does not cover is the one this error must point at.
        if (live + retiring > cache.bytes) {
            const id = cache.registration.id;
            auditCount('governor', `unaccounted:${id}`);
            throw new MemoryAdmissionError('unaccounted',
                `unaccounted: ${id} live ${live} retiring ${retiring} reserved ${cache.bytes}`);
        }
        return { live, retiring, reservedBytes: cache.bytes, leaseCount: cache.leaseCount, closed: cache.closed };
    }

    /** Render audit only: every cache's charge with its pane, and each pane's grant. */
    auditCaches(): { caches: { id: string; pane: string | null; pool: MemoryPool; kind: MemoryKind; bytes: number; hidden: boolean }[];
        grants: { pane: string; cpuBytes: number; gpuCacheBytes: number }[] } {
        return {
            caches: [...this.caches.values()].filter(cache => cache.bytes > 0).map(cache => ({ id: cache.registration.id,
                pane: cache.registration.paneId ?? null, pool: cache.registration.pool, kind: cache.registration.kind,
                bytes: cache.bytes, hidden: cache.activity.hiddenAt !== null })),
            grants: [...this.grants].map(([pane, grant]) => ({ pane, cpuBytes: grant.cpuBytes, gpuCacheBytes: grant.gpuCacheBytes })),
        };
    }

    private poolReadout(pool: MemoryPool): PoolMemoryReadout {
        let workingBytes = 0;
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
        // A request larger than the whole pool can never fit, so it is no sign of pressure: refusing it must not trim
        // others or degrade the app. Seen: a board's 81 MB direct estimate against the 32 MB CPU target, asked on each
        // return to a 1% overview of ~5,400 items, degraded the governor before the board fell back to dense tiles.
        if (bytes > this.target[pool]) return null;
        // Refused and nothing has moved since: the same request is refused again without the reclaim and trims that made the
        // first refusal. Measured earlier as the evict/realloc loop; an owner that retries each frame must not re-run them.
        if (cache.refusal && cache.refusal.epoch === this.capacityEpoch && bytes >= cache.refusal.bytes) return null;
        const allowed = () => this.fits(cache, bytes);
        if (!allowed()) {
            // Pressure is the pool's, not one pane reaching its own grant: adapters retry a refused grant each frame, and
            // resetting the recovery clock for it kept the governor 'trimming' at quality 0.8 with the GPU pool 57% full.
            if (this.charged[pool] + bytes > this.target[pool]) {
                this.state = 'trimming';
                this.belowRecoverySince = null;
            }
            // A pane grant refuses only its own residency, so that is reclaimed first; the pool's idle residency
            // (redundant levels, idle geometry) goes only when the reclaim did not make room.
            this.reclaimPane(cache, bytes);
            // Only a pool that cannot hold the request is trimmed. A pane at its own grant with the pool at 81% evicted the
            // paper, the board and the device working set of that same pane, and the stroke froze for a second.
            if (!allowed() && this.charged[pool] + bytes > this.target[pool]) this.trimPool(pool, Math.max(0, Math.min(this.target[pool] - bytes,
                Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio))));
            this.trimHiddenMirrors(kind === 'mirror' && cache.activity.hiddenAt !== null ? bytes : 0);
            if (!allowed()) {
                // Only a pool that cannot hold the request is pressure. A refusal at the pane's own grant is that
                // pane's back-pressure: degrading the whole app for it held the GPU quality at 0.51-0.8 for good,
                // so no webgl2 PDF frame was ever sharp and its editing cover never dropped.
                if (this.charged[pool] + bytes > this.target[pool]) this.refuseReservation(pool);
                cache.refusal = { epoch: this.capacityEpoch, bytes };
                this.refusedFloor[pool] = Math.min(this.refusedFloor[pool], bytes);
                return null;
            }
        }
        this.refusing[pool] = false;
        cache.refusal = null;
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
        const pane = paneId === undefined ? undefined : this.paneById.get(paneId);
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (pool === 'gpu' && (cache.activity.hiddenAt !== null || !pane?.visible || !pane.requestedPixels ||
            (pane.cpuPinned && kind !== 'surface' && kind !== 'canvas-working'))) return false;
        if (kind === 'mirror' && cache.activity.hiddenAt !== null &&
            this.hiddenMirrorBytes() + bytes > this.hiddenMirrorLimit()) return false;
        if (paneId === undefined || kind === 'program') return true;
        if (pool === 'gpu' && !grant?.pixelGrant) return false;
        // Bounded by the pool, not the pane grant, but never more than a quarter of it: one stroke's 46 MB of wet tiles held
        // the pool over target and trimmed every other cache each frame.
        if (kind === 'live-input') return this.kindBytes('live-input') + bytes <= this.target[pool] * POLICY.liveInputGpuFraction;
        if (pool === 'cpu' && (cache.activity.hiddenAt !== null || !pane?.visible)) return true;
        if (!grant) return false;
        const limit = kind === 'surface' ? grant.pixelGrant * POLICY.surfaceReserveBytesPerPixel :
            pool === 'gpu' ? grant.gpuCacheBytes : grant.cpuBytes;
        const used = this.paneUsed(paneId, pool, kind);
        if (pool === 'gpu' && kind === 'capture') {
            const captures = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
                other.registration.kind === 'capture' && other.activity.hiddenAt === null).reduce((sum, other) => sum + other.bytes, 0);
            if (captures + bytes > Math.max(0, grant.gpuCacheBytes - this.minimumProgressBytes())) return false;
        }
        return used + bytes <= limit;
    }

    /** The bytes a pane's grant counts against a new cache of this kind: its visible, non-surface residency. */
    private paneUsed(paneId: string, pool: MemoryPool, kind: MemoryKind): number {
        return [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
            other.registration.pool === pool && other.activity.hiddenAt === null && (kind === 'surface' ? other.registration.kind === 'surface' :
                // The 2D compositor's working set and the GPU layer caches are counted apart: a resize bridges through a
                // detached 2D picture while the kept GPU caches stay charged, and one shared limit refused every bridge
                // image forever (measured: 3,484 refusals, no frame after a PDF's quality returned to 1).
                kind === 'canvas-working' ? other.registration.kind === 'canvas-working' :
                !['surface', 'program', 'context', 'live-input', 'canvas-working'].includes(other.registration.kind)))
            .reduce((sum, other) => sum + other.bytes, 0);
    }

    /** A refused CPU reservation inside a pane asks the pane's own owners to give back what they can rebuild: the owner
     * decides what that is (a layer drops session bitmaps its view cannot draw). Borrowed or live residency is never asked. */
    private reclaimPane(cache: CacheRecord, bytes: number): void {
        const { paneId, pool, kind } = cache.registration;
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (paneId === undefined || !grant || this.trimming) return;
        // GPU too: a pane at its own GPU grant with the pool 83% full refused the board's tiles on every frame while the
        // pane's page tiles held 19 MB, and nothing reclaimed (measured: an annotated PDF never presented after a drag).
        // Only the pane's layer caches compete there; its surface, working set and live input are counted apart.
        if (pool === 'gpu' && ['surface', 'program', 'context', 'live-input', 'canvas-working'].includes(kind)) return;
        let excess = this.paneUsed(paneId, pool, kind) + bytes - (pool === 'gpu' ? grant.gpuCacheBytes : grant.cpuBytes);
        if (excess <= 0) return;
        const candidates = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
            other.registration.pool === pool && other.bytes > 0 && other.activity.hiddenAt === null &&
            RECLAIMABLE.includes(other.registration.class) &&
            // A GPU layer evicted whole cannot be the one asking: it would release the residency it is growing.
            (pool === 'cpu' || other !== cache) &&
            !['surface', 'program', 'context', 'mirror', 'mirror-retiring', 'live-input', 'canvas-working'].includes(other.registration.kind))
            .sort((a, b) => RECLAIMABLE.indexOf(a.registration.class) - RECLAIMABLE.indexOf(b.registration.class) ||
                a.activity.lastVisibleAt - b.activity.lastVisibleAt || a.activity.lastUsedAt - b.activity.lastUsedAt ||
                stableId(a.registration.id, b.registration.id));
        this.trimming = true;
        try {
            for (const other of candidates) {
                if (excess <= 0) break;
                const freed = this.evictCache(other, excess, false);
                if (freed > 0) auditCount('governor', `reclaim:${pool}:${other.registration.id}`, 1, { bytes: freed });
                excess -= freed;
            }
        } finally { this.trimming = false; }
    }

    /** Asks one cache for up to `bytes` and returns the bytes it freed. A returned count is believed: an owner that releases
     * asynchronously cannot show its drop yet. An owner that returns nothing is counted by its synchronous drop, or, in a
     * trim, by the ask up to its cache's size: a mirror closes entries whose bytes stay charged until retirement, and
     * counting only the drop asked every candidate (measured earlier: four caches, 45 MB, evicted for a 0.47 MB excess). */
    private evictCache(cache: CacheRecord, bytes: number, unreportedCountsAsk: boolean): number {
        const before = cache.bytes;
        const returned = cache.registration.evict(bytes);
        const reported = typeof returned === 'number' ? (Number.isFinite(returned) ? Math.max(0, returned) : 0) :
            unreportedCountsAsk ? Math.min(before, bytes) : 0;
        return Math.max(before - cache.bytes, reported);
    }

    /** One refusal episode degrades the governor once; the retries of that episode only wait for capacity. */
    private refuseReservation(pool: MemoryPool): void {
        if (this.refusing[pool]) return;
        this.refusing[pool] = true;
        this.lastTrouble = 'allocation';
        this.degrade();
        this.onPressureChange?.();
    }

    /** Re-grants after a demand or quality change. Waiters wake only when some pane's grant rose: a steady demand
     * re-run each frame (the pane refresh runs before every prepare) must not wake the owners it just refused. */
    private replan(): void {
        const before = this.grants;
        this.plan();
        for (const [id, grant] of this.grants) {
            const old = before.get(id);
            if (!old || grant.cpuBytes > old.cpuBytes || grant.gpuCacheBytes > old.gpuCacheBytes || grant.pixelGrant > old.pixelGrant) {
                this.bumpCapacity();
                this.notifyCapacity();
                return;
            }
        }
    }

    /** A sized waiter stays parked until its bytes would be admitted: a closed cache's waiter wakes so its owner sees
     * the closure. Each wake runs once however many of its waiters fired. */
    /** Every refusal memo dies with the epoch, so the floor they were measured against starts over with it. */
    private bumpCapacity(): void {
        this.capacityEpoch++;
        this.refusedFloor.gpu = Infinity;
        this.refusedFloor.cpu = Infinity;
    }

    private notifyCapacity(): void {
        if (!this.capacityWaiters.size) return;
        const woken = new Set<() => void>();
        for (const [cache, waiters] of this.capacityWaiters) {
            for (const [wake, bytes] of waiters) {
                if (bytes !== undefined && !this.fits(cache, bytes)) continue;
                waiters.delete(wake);
                woken.add(wake);
            }
            if (!waiters.size) this.capacityWaiters.delete(cache);
        }
        for (const wake of woken) wake();
    }

    private release(lease: ByteLease, expected?: CacheRecord): void {
        const record = this.leases.get(lease);
        if (!record || (expected && record.cache !== expected)) throw new MemoryAdmissionError('invalid-lease');
        if (record.returned) return;
        record.returned = true;
        const cache = record.cache;
        cache.bytes -= record.bytes;
        cache.leaseCount--;
        const pool = cache.registration.pool;
        this.charged[pool] -= record.bytes;
        // Only a release that leaves room for the smallest standing refusal can change its answer (see refusedFloor).
        if (this.charged[pool] + this.refusedFloor[pool] <= this.target[pool]) this.bumpCapacity();
        this.notifyCapacity();
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

    /** A trim that ran out of candidates while the pool is still over its target: the only pressure a degradation answers. A trim
     * aimed below target (the soft trim) that stops short of its aim, but reached the target, has not failed. */
    private trimFailed(pool: MemoryPool, aim: number): boolean {
        return this.trimPool(pool, aim) > 0 && this.charged[pool] > this.target[pool];
    }

    /** Evicts from the pool's reclaimable caches until its charge is at `target`. Returns the bytes still over target when
     * every candidate has been asked: 0 when the trim met its target, or when another trim is already running. */
    private trimPool(pool: MemoryPool, target: number): number {
        if (this.trimming) return 0;
        const order: readonly MemoryClass[] = ['hidden-mirror', 'obsolete-arrival', 'offscreen-high',
            'redundant-level', 'prefetch', 'scene-cache', 'critical'];
        const evictionClass = (cache: CacheRecord): MemoryClass => cache.registration.kind === 'mirror' && cache.activity.hiddenAt !== null ?
            'hidden-mirror' : cache.registration.class;
        const candidates = [...this.caches.values()].filter(cache => cache.registration.pool === pool &&
            evictionClass(cache) !== 'critical' && cache.bytes > 0 && cache.registration.kind !== 'live-input' &&
            (evictionClass(cache) !== 'hidden-mirror' || cache.activity.hiddenAt !== null) &&
            (cache.registration.kind !== 'context' || cache.registration.paneId === undefined || cache.activity.hiddenAt !== null))
            .sort((a, b) => order.indexOf(evictionClass(a)) - order.indexOf(evictionClass(b)) ||
                (evictionClass(a) === 'hidden-mirror' ? (a.activity.hiddenAt ?? Infinity) - (b.activity.hiddenAt ?? Infinity) : 0) ||
                a.activity.lastVisibleAt - b.activity.lastVisibleAt || a.activity.lastUsedAt - b.activity.lastUsedAt ||
                b.bytes - a.bytes || stableId(a.registration.id, b.registration.id));
        this.trimming = true;
        // Charged falls only when owners release, which is asynchronous: the reported bytes stand in for it inside this loop.
        let excess = this.charged[pool] - target;
        try {
            for (const cache of candidates) {
                if (excess <= 0) break;
                // The owner protects its last visible coverage provider and capture/live-input pins.
                const freed = this.evictCache(cache, excess, true);
                if (freed > 0) auditCount('governor', `trim:${pool}:${cache.registration.id}`, 1, { bytes: freed });
                excess -= freed;
            }
        } finally { this.trimming = false; this.plan(); }
        return Math.max(0, excess);
    }

    private kindBytes(kind: MemoryKind): number {
        let bytes = 0;
        for (const cache of this.caches.values()) if (cache.registration.kind === kind) bytes += cache.bytes;
        return bytes;
    }

    /** Usage low enough to step quality back up. GPU grants are planned up to the trim target, so a pane using its own
     * grant sits there; the CPU's 0.6 ratio applied to the GPU never came once it was degraded (measured: a PDF held at
     * 44 of 64 MB stayed at quality 0.8, so no webgl2 frame was ever sharp). */
    /** What a layer reads through its host: a pure mapping of the state fields, so the read allocates nothing. */
    trouble(): LayerTrouble { return layerTroubleOf(this.state, this.lastTrouble); }

    cool(): boolean {
        return this.charged.gpu < this.target.gpu * POLICY.memoryTrimTargetRatio &&
            this.charged.cpu < this.target.cpu * POLICY.memoryRecoveryRatio;
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

    /** Recomputes grants. Waiters are woken only by a real capacity change (a release or a new pane demand), never by
     * a plan that a refusal caused: that wake re-ran the refused owner each frame and refused it again. */
    private plan(): void {
        const visible = this.panes.filter(pane => pane.visible && pane.requestedPixels > 0);
        const weight = (pane: PaneMemoryDemand) => pane.focused ? POLICY.focusedPaneWeight : POLICY.unfocusedPaneWeight;
        const minimum = this.minimumProgressBytes();
        const overhead = this.kindBytes('context') + this.kindBytes('program');
        // Grants fit under the trim target: the scheduler trims the pool past memorySoftPressureRatio, so a pane granted the
        // whole pool was evicted for using its own grant, released all its GPU work, rebuilt it and was evicted again (measured:
        // a notebook granted 51 MB of a 64 MB pool reached 61 MB and never presented on the GPU).
        let remaining = Math.max(0, Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio) - overhead);
        const supported: PaneMemoryDemand[] = [];
        for (const pane of [...visible].sort((a, b) => weight(b) - weight(a) || stableId(a.paneId, b.paneId))) {
            if (remaining < minimum) continue;
            supported.push(pane);
            remaining -= minimum;
        }
        // Surface floors before the share: every visible pane keeps its picture at MIN_SURFACE_QUALITY, so insufficient memory
        // lowers resolution and never blanks a pane. Arithmetic, 2560×1600 device px: q 1/4 is 640×400 = 256,000 px × 12 B ≈ 3 MB
        // per pane, so five panes need ≈ 15 MB of the 102 MB low-device trim target. A floor the pool cannot hold is not granted.
        const byWeight = [...visible].sort((a, b) => weight(b) - weight(a) || stableId(a.paneId, b.paneId));
        const floorPixels = new Map<string, number>();
        for (const pane of byWeight) {
            const px = Math.floor(pane.requestedPixels * MIN_SURFACE_QUALITY * MIN_SURFACE_QUALITY);
            const bytes = px * POLICY.surfaceReserveBytesPerPixel;
            if (bytes > remaining) continue;
            floorPixels.set(pane.paneId, px);
            remaining -= bytes;
        }
        // Pinned first. Arithmetic, DPR 2, a 1280×800 CSS pane (2560×1600 device px): 5×4 = 20 visible positions; a 514² RGBA
        // tile is 514·514·4 = 1,056,784 B ≈ 1.06 MB, so one band's visible set is ≈ 21 MB. On a low device (128 MB pool) the
        // trim target is 102.4 MB, the surface share is at most 41 MB, leaving ≈ 61 MB of cache for the pool; five such panes
        // pin ≈ 105 MB per band, which does not fit. So the pinned sets are shared by focus weight up to what the pool holds,
        // and a position past its pane's share is refused and composed at a lower level (h1), never trimmed from the screen.
        const pinned = waterFill(supported.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.max(0, Math.min(pane.gpuPinnedBytes ?? 0, pane.gpuNeedBytes - minimum)) })), remaining);
        remaining -= [...pinned.values()].reduce((sum, value) => sum + value, 0);
        const ceilingOf = (pane: PaneMemoryDemand) => Math.min(this.qualityLimit, this.paneCeiling.get(pane.paneId) ?? 1);
        const surfaceBytes = Math.min(Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio * POLICY.surfaceMaxGpuGrantFraction), remaining);
        // Denying GL must not deny a 2D drawing buffer (§6.3:641); both paths share this cap.
        const pixels = waterFill(visible.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.max(0, Math.floor(pane.requestedPixels * ceilingOf(pane) * ceilingOf(pane)) - (floorPixels.get(pane.paneId) ?? 0)) })),
        Math.floor(surfaceBytes / POLICY.surfaceReserveBytesPerPixel));
        const pixelGrantOf = (paneId: string): number => (floorPixels.get(paneId) ?? 0) + (pixels.get(paneId) ?? 0);
        for (const pane of visible) {
            const q = Math.sqrt(pixelGrantOf(pane.paneId) / pane.requestedPixels);
            if (q < (this.paneCeiling.get(pane.paneId) ?? 1)) this.paneCeiling.set(pane.paneId, Math.max(MIN_SURFACE_QUALITY, q));
        }
        const assignedSurface = [...pixels.values()].reduce((sum, value) => sum + value, 0) * POLICY.surfaceReserveBytesPerPixel;
        const cache = waterFill(supported.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.max(0, pane.gpuNeedBytes - minimum - (pinned.get(pane.paneId) ?? 0)) })), Math.max(0, remaining - assignedSurface));
        // Demand is reported from what layers already hold, so a grant of exactly that had no room for the next tile: the
        // committed board layers were refused with the pool half empty and a finished stroke never drew (measured: 1 MB
        // tiles refused at 33 of 64 MB). The plannable remainder is shared by weight; the total stays inside the plan.
        const cacheCapacity = Math.max(0, remaining - assignedSurface);
        const spare = cacheCapacity - [...cache.values()].reduce((sum, value) => sum + value, 0);
        const totalWeight = supported.reduce((sum, pane) => sum + weight(pane), 0);
        if (spare > 0 && totalWeight > 0) {
            for (const pane of supported) cache.set(pane.paneId, (cache.get(pane.paneId) ?? 0) + Math.floor(spare * weight(pane) / totalWeight));
        }
        for (const [id, bytes] of pinned) cache.set(id, (cache.get(id) ?? 0) + bytes);
        // The GPU is offered to the five highest-weighted visible panes only; a sixth keeps its 2D picture and its floor.
        const gpuRanked = new Set(byWeight.slice(0, POLICY.maxVisiblePaneContexts).map(pane => pane.paneId));
        const cpu = waterFill(visible.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: pane.cpuMandatoryBytes ?? pane.cpuNeedBytes })), this.target.cpu);
        const mandatoryAssigned = [...cpu.values()].reduce((sum, value) => sum + value, 0);
        const optional = waterFill(visible.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: pane.cpuNeedBytes - (pane.cpuMandatoryBytes ?? pane.cpuNeedBytes) })), this.target.cpu - mandatoryAssigned);
        for (const [id, bytes] of optional) cpu.set(id, (cpu.get(id) ?? 0) + bytes);
        this.grants = new Map(this.panes.map(pane => {
            const pixelGrant = pixelGrantOf(pane.paneId);
            const q = pane.requestedPixels ? Math.sqrt(pixelGrant / pane.requestedPixels) : 0;
            const hasCacheCredit = pixelGrant > 0 && supported.includes(pane);
            const gpuEligible = gpuRanked.has(pane.paneId) && hasCacheCredit && !pane.cpuPinned;
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
