import { RENDER_CONSTANTS as POLICY } from './constants';
import type { ByteLease } from './gfx/api';
import { auditCount } from './renderAudit';
import type { ArenaMemory } from './resourceArena';
import { layerTroubleOf } from './types';
import { MIN_SURFACE_QUALITY } from './surfaceMetrics';
import type { LayerTrouble, RenderToken } from './types';

export type MemoryPool = 'gpu' | 'cpu';
export type MemoryClass = 'hidden-pane' | 'hidden-mirror' | 'obsolete-arrival' | 'offscreen-high' |
    'redundant-level' | 'prefetch' | 'scene-cache' | 'critical';
export type MemoryKind = 'working' | 'canvas-working' | 'surface-scratch' | 'program' | 'context' | 'surface' | 'mirror' | 'mirror-retiring' | 'capture' |
    'live-input';
export type MemorySessionOwner = Readonly<Pick<RenderToken, 'vaultEpoch' | 'documentId' | 'session'>>;
export type MemoryPressureState = 'normal' | 'trimming' | 'degraded' | 'cpu-pinned';
export type DeviceMemoryClass = 'low' | 'medium' | 'high';

export interface ReserveOptions {
    readonly prefetch?: boolean;
    readonly quiet?: boolean;
}
const HIDDEN_KEPT_KINDS: ReadonlySet<string> = new Set(['context', 'program', 'mirror', 'mirror-retiring']);
const PANE_APART_KINDS: ReadonlySet<string> = new Set(['surface', 'program', 'context', 'live-input', 'canvas-working', 'surface-scratch']);
/** The exact token object crosses the arena boundary; never reconstruct a ByteLease by id. */
export interface MemoryAllocator {
    reserve(bytes: number, options?: ReserveOptions): ByteLease | null;
    release(lease: ByteLease): void;
    whenAvailable?(wake: () => void, bytes?: number): void;
}

export interface CacheActivity {
    readonly hiddenAt: number | null;
    readonly lastVisibleAt: number;
    readonly lastUsedAt: number;
}

export interface MemoryCacheRegistration extends CacheActivity {
    readonly id: string;
    readonly pool: MemoryPool;
    readonly kind: MemoryKind;
    readonly class: MemoryClass;
    readonly paneId?: string;
    readonly liveInput?: boolean;
    readonly foreground?: boolean;
    readonly owner?: MemorySessionOwner;
    readonly memory: () => ArenaMemory;
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
    readonly devicePixelRatio?: number;
    readonly gpuNeedBytes: number;
    readonly gpuPinnedBytes?: number;
    readonly cpuNeedBytes: number;
    readonly cpuMandatoryBytes?: number;
    readonly cpuPinned: boolean;
}

export interface PaneMemoryGrant {
    readonly paneId: string;
    readonly pixelGrant: number;
    readonly gpuEligible: boolean;
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
    readonly derivedModelBytes: number;
}

export type MemoryTrouble = 'allocation' | 'framebuffer' | 'context-loss' | 'capability' | 'slow-gpu' | 'stalled-fence';

interface CacheRecord {
    readonly registration: MemoryCacheRegistration;
    activity: CacheActivity;
    bytes: number;
    leaseCount: number;
    closed: boolean;
    refusal: { readonly epoch: number; readonly bytes: number } | null;
    unaccounted: number;
    unaccountedReported: boolean;
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

function raisedQuality(value: number): number {
    const next = value / POLICY.qualityReductionFactor;
    return next >= 1 - 1e-6 ? 1 : next;
}

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

function samePaneDemand(a: PaneMemoryDemand, b: PaneMemoryDemand | undefined): boolean {
    return b !== undefined && a.paneId === b.paneId && a.visible === b.visible && a.focused === b.focused &&
        a.requestedPixels === b.requestedPixels && a.devicePixelRatio === b.devicePixelRatio && a.gpuNeedBytes === b.gpuNeedBytes &&
        a.cpuNeedBytes === b.cpuNeedBytes &&
        a.gpuPinnedBytes === b.gpuPinnedBytes &&
        a.cpuMandatoryBytes === b.cpuMandatoryBytes && a.cpuPinned === b.cpuPinned;
}

const RECLAIMABLE: readonly MemoryClass[] = ['redundant-level', 'prefetch', 'scene-cache'];
const SLOW_GPU_HOLD_MS = 1000;

export class MemoryGovernor {
    readonly deviceClass: DeviceMemoryClass;
    private readonly caches = new Map<string, CacheRecord>();
    private readonly capacityWaiters = new Map<CacheRecord, Map<() => void, number | undefined>>();
    private readonly leases = new WeakMap<ByteLease, LeaseRecord>();
    private readonly cacheHandles = new WeakMap<MemoryCacheHandle, CacheRecord>();
    private readonly charged = { gpu: 0, cpu: 0 };
    private capacityEpoch = 0;
    private readonly refusedFloor: Record<MemoryPool, number> = { gpu: Infinity, cpu: Infinity };
    private readonly paneById = new Map<string, PaneMemoryDemand>();
    private readonly paneCeiling = new Map<string, number>();
    private readonly target: { gpu: number; cpu: number } = { gpu: POLICY.gpuGrantMinBytes, cpu: POLICY.cpuGrantMinBytes };
    private readonly ceilings: Readonly<{ gpuBytes: number; cpuRasterBytes: number }>;
    private panes: readonly PaneMemoryDemand[] = [];
    private grants = new Map<string, PaneMemoryGrant>();
    private nextLease = 1;
    private trimming = false;
    private readonly hiddenReleaseDeferred = new Set<string>();
    private readonly refusing: Record<MemoryPool, boolean> = { gpu: false, cpu: false };
    private state: Exclude<MemoryPressureState, 'cpu-pinned'> = 'normal';
    private lastTrouble: MemoryTrouble | null = null;
    private qualityLimit = 1;
    private recoveryTrimmedAt = -1;
    private madeRoom = false;
    private raisedAt = Number.NEGATIVE_INFINITY;
    private belowRecoverySince: number | null = null;
    private degradedAt = Number.NEGATIVE_INFINITY;
    private slowGpuAt = Number.NEGATIVE_INFINITY;
    private failedQuality: number | null = null;
    private failedUntil = Number.NEGATIVE_INFINITY;
    private failureBackoffMs: number = POLICY.qualityFailureBackoffMinMs;
    private wake: number | null = null;
    private levelSince = Number.NEGATIVE_INFINITY;
    private pressureHoldUntil = Number.NEGATIVE_INFINITY;
    private readonly trimmedAt: Record<MemoryPool, number> = { gpu: -1, cpu: -1 };
    private now = 0;
    private workerHeapBytes = 0;
    private readonly workerHeaps = new Map<object, number>();
    private readonly legacyWorker = {};
    private sourceBytes = 0;
    private derivedModelBytes = 0;
    private readonly derivedModels = new Map<object, number>();

    constructor(deviceMemory: unknown, private readonly onPressureChange?: () => void) {
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
            (['program', 'context', 'surface', 'canvas-working', 'surface-scratch'].includes(registration.kind) && registration.pool !== 'gpu') ||
            (registration.pool === 'gpu' && registration.kind !== 'context' && !registration.paneId)) {
            throw new MemoryAdmissionError('invalid-input');
        }
        const cache: CacheRecord = {
            registration: { ...registration, owner: registration.owner ? Object.freeze({ ...registration.owner }) : undefined },
            activity: { ...registration }, bytes: 0, leaseCount: 0, closed: false, refusal: null, unaccounted: 0, unaccountedReported: false,
            handle: {
                reserve: (bytes, options) => this.reserve(cache, bytes, options),
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
                    if (activity.hiddenAt !== cache.activity.hiddenAt) { this.trimmedAt.gpu = -1; this.trimmedAt.cpu = -1; }
                    cache.activity = { ...activity };
                    this.bumpCapacity();
                    this.trimHiddenMirrors();
                },
                close: () => {
                    if (cache.closed) return;
                    cache.closed = true;
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

    updatePanes(panes: readonly PaneMemoryDemand[]): void {
        const ids = new Set<string>();
        let pixels = 0;
        let visible = 0;
        let dprScale = 1;
        let floors = 0;
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
            if (pane.visible && pane.requestedPixels > 0) {
                pixels += pane.requestedPixels; visible++;
                floors += pane.cpuMandatoryBytes ?? 0;
                const dpr = pane.devicePixelRatio ?? 1;
                if (Number.isFinite(dpr) && dpr > 1) dprScale = Math.max(dprScale, Math.min(POLICY.gpuGrantMaxDpr, dpr) ** 2);
            }
        }
        count(pixels);
        const changed = this.panes.length !== panes.length || panes.some((pane, i) => !samePaneDemand(pane, this.panes[i]));
        const hiding = changed ? panes.filter(pane => !pane.visible && this.paneById.get(pane.paneId)?.visible).map(pane => pane.paneId) : [];
        this.panes = panes.map(pane => ({ ...pane }));
        this.paneById.clear();
        for (const pane of this.panes) this.paneById.set(pane.paneId, pane);
        for (const id of this.paneCeiling.keys()) if (!ids.has(id)) this.paneCeiling.delete(id);
        if (changed) {
            this.bumpCapacity();
            this.target.gpu = Math.min(this.ceilings.gpuBytes, Math.max(POLICY.gpuGrantMinBytes * dprScale,
                (POLICY.gpuGrantBaseBytes + POLICY.gpuGrantPerVisiblePaneBytes * visible) * dprScale + POLICY.gpuGrantPerVisiblePixelBytes * pixels));
            this.target.cpu = Math.min(this.ceilings.cpuRasterBytes, Math.max(POLICY.cpuGrantMinBytes,
                POLICY.cpuGrantPerVisiblePaneBytes * visible + POLICY.cpuGrantPerVisiblePixelBytes * pixels,
                Math.ceil(floors / POLICY.memoryTrimTargetRatio)));
            this.trimmedAt.gpu = -1;
            this.trimmedAt.cpu = -1;
            this.replan();
        }
        for (const paneId of hiding) this.releaseHiddenPane(paneId);
        this.trimHiddenMirrors();
        for (const pool of ['gpu', 'cpu'] as const) {
            if (this.charged[pool] > this.target[pool]) this.pressureTrim(pool, this.target[pool]);
        }
    }

    grant(paneId: string): PaneMemoryGrant | null { return this.grants.get(paneId) ?? null; }

    /** Arena close&&zero callback, never arena.release(handle) (§6.1:603; R-B2 lease seam). */
    releaseLease(lease: ByteLease): void { this.release(lease); }

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

    promoteCanvasBacking(leases: readonly ByteLease[], target: MemoryCacheHandle, options?: { readonly floor?: boolean }): boolean {
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
            if (source.pool !== 'gpu' || source.kind !== 'surface-scratch' || source.paneId !== destination.registration.paneId ||
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
        if (!options?.floor && (!pane?.visible || !grant || destination.activity.hiddenAt !== null || this.charged.gpu > this.target.gpu ||
            displayed + bytes > grant.pixelGrant * POLICY.surfaceReserveBytesPerPixel)) return false;
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
        if (options?.floor && this.charged.gpu > this.target.gpu) {
            auditCount('governor', 'promote-floor:over-target', 1, { bytes: this.charged.gpu - this.target.gpu });
            this.refuseReservation('gpu');
        }
        return true;
    }

    reportWorkerMemory(worker: object, ownedBytes: number): void {
        if (typeof worker !== 'object' || worker === null) throw new MemoryAdmissionError('invalid-input');
        count(ownedBytes);
        const previous = this.workerHeaps.get(worker) ?? 0;
        const total = this.workerHeapBytes - previous + ownedBytes;
        count(total);
        if (ownedBytes) this.workerHeaps.set(worker, ownedBytes);
        else this.workerHeaps.delete(worker);
        this.workerHeapBytes = total;
        if (previous !== ownedBytes) this.onPressureChange?.();
    }

    releaseWorkerMemory(worker: object): void { this.reportWorkerMemory(worker, 0); }

    reportDerivedModel(owner: object, bytes: number): void {
        if (typeof owner !== 'object' || owner === null) throw new MemoryAdmissionError('invalid-input');
        count(bytes);
        const total = this.derivedModelBytes - (this.derivedModels.get(owner) ?? 0) + bytes;
        count(total);
        if (bytes) this.derivedModels.set(owner, bytes); else this.derivedModels.delete(owner);
        this.derivedModelBytes = total;
    }

    reportExternalHeaps(workerHeapBytes: number, sourceBytes: number): void {
        count(sourceBytes);
        this.reportWorkerMemory(this.legacyWorker, workerHeapBytes);
        this.sourceBytes = sourceBytes;
    }

    advance(now: number, liveGesture: boolean): void {
        if (!Number.isFinite(now) || now < this.now) throw new MemoryAdmissionError('invalid-input');
        this.now = now;
        for (const cache of this.caches.values()) this.reconcileUnaccounted(cache);
        this.trimHiddenMirrors();
        let unmet: MemoryPool | null = null;
        for (const pool of ['gpu', 'cpu'] as const) {
            if (this.charged[pool] > this.target[pool] * POLICY.memorySoftPressureRatio) {
                this.state = 'trimming';
                if (this.pressureTrim(pool, Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio))) unmet ??= pool;
            } else this.trimmedAt[pool] = -1;
        }
        if (unmet && now >= this.pressureHoldUntil) { auditCount('governor', `degrade:unmet:${unmet}`); this.degrade(); }
        this.trimPanesOverGrant();
        if (!liveGesture) this.recoverRoom();
        const cool = this.cool() && !liveGesture;
        if (!cool) this.belowRecoverySince = null;
        else if (this.belowRecoverySince === null) this.belowRecoverySince = now;
        else if (now - this.belowRecoverySince >= this.recoveryDelay() && !this.raiseRefused(now)) {
            if (this.belowFull()) this.raisedAt = now;
            this.madeRoom = false;
            this.qualityLimit = raisedQuality(this.qualityLimit);
            for (const [id, value] of this.paneCeiling) this.paneCeiling.set(id, raisedQuality(value));
            this.levelSince = now;
            this.state = this.qualityLimit < 1 ? 'degraded' : 'normal';
            if (this.state === 'normal') this.lastTrouble = null;
            this.belowRecoverySince = now;
            this.replan();
        }
        if (this.state === 'trimming' && cool && this.belowRecoverySince !== null && now - this.belowRecoverySince >= this.recoveryDelay()) {
            this.state = this.qualityLimit < 1 ? 'degraded' : 'normal';
        }
        if (this.failedQuality !== null && now - this.levelSince >= POLICY.qualityFailureResetMs) {
            this.failedQuality = null;
            this.failureBackoffMs = POLICY.qualityFailureBackoffMinMs;
        }
        this.wake = this.nextWake(now, cool, unmet !== null);
    }

    private nextWake(now: number, cool: boolean, unmet: boolean): number | null {
        const hold = unmet && now < this.pressureHoldUntil ? this.pressureHoldUntil : null;
        let recovery: number | null = null;
        if (this.recoveryDue()) recovery = now + POLICY.qualityStepSettleMs;
        if ((this.state !== 'normal' || this.belowFull()) && cool && this.belowRecoverySince !== null) {
            let due = this.belowRecoverySince + this.recoveryDelay();
            if (this.failedQuality !== null) due = Math.max(due, this.failedUntil);
            recovery = Math.max(due, now);
        }
        if (hold === null) return recovery;
        return recovery === null ? hold : Math.min(hold, recovery);
    }

    wakeAt(): number | null { return this.wake; }

    signalTrouble(reason: MemoryTrouble): void {
        this.lastTrouble = reason;
        this.state = 'trimming';
        this.belowRecoverySince = null;
        if (reason !== 'allocation' || this.levelJustRaised()) this.recordFailedLevel();
        for (const pool of ['gpu', 'cpu'] as const) {
            this.trimPool(pool, Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio));
        }
        auditCount('governor', `degrade:trouble:${reason}`);
        this.degrade();
    }

    observeGpuTiming(p95Ms: number, frameIntervalMs: number, samples: number, disjoint: boolean): void {
        if (disjoint) return;
        if (!Number.isFinite(p95Ms) || p95Ms < 0 || !Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
            throw new MemoryAdmissionError('invalid-input');
        }
        count(samples);
        if (samples >= POLICY.slowGpuSampleCount && p95Ms > frameIntervalMs) this.signalSlowGpu();
    }

    private signalSlowGpu(): void {
        auditCount('governor', 'slow-gpu', 1);
        this.slowGpuAt = this.now;
    }

    observeFence(oldestPendingMs: number, mainThreadInputHealthy: boolean): void {
        if (!Number.isFinite(oldestPendingMs) || oldestPendingMs < 0) throw new MemoryAdmissionError('invalid-input');
        if (mainThreadInputHealthy && oldestPendingMs > POLICY.stalledFenceMs) this.signalTrouble('stalled-fence');
    }

    readout(): MemoryReadout {
        const gpu = this.poolReadout('gpu');
        const cpu = this.poolReadout('cpu');
        return {
            deviceClass: this.deviceClass, state: this.state, lastTrouble: this.lastTrouble, gpu, cpu,
            hiddenMirrorBytes: this.hiddenMirrorBytes(), borrowedRetiringBytes: this.kindBytes('mirror-retiring'),
            hiddenMirrorLimitBytes: this.hiddenMirrorLimit(),
            workerHeapBytes: this.workerHeapBytes, sourceBytes: this.sourceBytes, derivedModelBytes: this.derivedModelBytes,
        };
    }

    private cacheReadout(cache: CacheRecord): MemoryCacheReadout {
        const { live, retiring } = cache.registration.memory();
        count(live);
        count(retiring);
        return { live, retiring, reservedBytes: cache.bytes, leaseCount: cache.leaseCount, closed: cache.closed };
    }

    private reconcileUnaccounted(cache: CacheRecord): void {
        const { id, pool } = cache.registration;
        const { live, retiring } = cache.registration.memory();
        const leased = cache.bytes - cache.unaccounted;
        const next = Math.max(0, live + retiring - leased);
        const delta = next - cache.unaccounted;
        if (!delta) return;
        cache.bytes += delta;
        cache.unaccounted = next;
        this.charged[pool] += delta;
        if (delta > 0) auditCount('governor', `unaccounted:${id}`, 1, { bytes: delta });
        if (next > 0 && !cache.unaccountedReported) {
            cache.unaccountedReported = true;
            console.error(`GPU accounting: ${id} published ${live + retiring} bytes (live ${live}, retiring ${retiring}) against ` +
                `${leased} reserved; the difference is charged to it until the owner publishes no more than its leases.`);
        }
    }

    auditCaches(): { caches: { id: string; pane: string | null; pool: MemoryPool; kind: MemoryKind; bytes: number; hidden: boolean;
        waiters: number; waiting: (number | null)[]; refused: number | null }[];
        grants: { pane: string; cpuBytes: number; gpuCacheBytes: number; pixelGrant: number; qualityScale: number }[]; panes: readonly PaneMemoryDemand[];
        target: { gpu: number; cpu: number }; hiddenPanes: { gpu: number; cpu: number }; recovery: Record<string, unknown> } {
        return {
            caches: [...this.caches.values()].filter(cache => cache.bytes > 0).map(cache => ({ id: cache.registration.id,
                pane: cache.registration.paneId ?? null, pool: cache.registration.pool, kind: cache.registration.kind,
                bytes: cache.bytes, hidden: cache.activity.hiddenAt !== null,
                waiters: this.capacityWaiters.get(cache)?.size ?? 0,
                waiting: [...(this.capacityWaiters.get(cache)?.values() ?? [])].map(bytes => bytes ?? null),
                refused: cache.refusal?.bytes ?? null })),
            grants: [...this.grants].map(([pane, grant]) => ({ pane, cpuBytes: grant.cpuBytes, gpuCacheBytes: grant.gpuCacheBytes,
                pixelGrant: grant.pixelGrant, qualityScale: grant.qualityScale })),
            panes: this.panes, target: { ...this.target }, hiddenPanes: this.hiddenPaneBytes(),
            recovery: { now: this.now, quality: this.qualityLimit, ceilings: Object.fromEntries(this.paneCeiling), charged: { ...this.charged },
                cool: this.cool(), belowRecoverySince: this.belowRecoverySince, delay: this.recoveryDelay(), failedQuality: this.failedQuality,
                failedUntil: this.failedUntil, wake: this.wake, state: this.state, madeRoom: this.madeRoom },
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

    private reserve(cache: CacheRecord, bytes: number, options?: ReserveOptions): ByteLease | null {
        count(bytes);
        if (cache.closed || this.trimming || cache.registration.kind === 'mirror-retiring' || !this.caches.has(cache.registration.id)) return null;
        const { kind, pool } = cache.registration;
        if (kind === 'context' && bytes !== POLICY.keptContextReserveBytes) throw new MemoryAdmissionError('invalid-input');
        if (kind === 'surface' && bytes % POLICY.surfaceReserveBytesPerPixel !== 0) throw new MemoryAdmissionError('invalid-input');
        if (bytes > this.target[pool]) return null;
        if (!cache.registration.foreground && cache.refusal && cache.refusal.epoch === this.capacityEpoch && bytes >= cache.refusal.bytes) return null;
        const allowed = () => this.fits(cache, bytes);
        if (!allowed() && !this.overPool(pool, bytes) && !this.hasDemand(cache)) return null;
        if (options?.quiet && !allowed()) return null;
        const prefetchLine = pool === 'cpu' || this.belowFull() ? POLICY.memoryTrimTargetRatio : POLICY.memorySoftPressureRatio;
        if (options?.prefetch && (!allowed() || this.charged[pool] + bytes > this.target[pool] * prefetchLine ||
            this.paneNeedWaiting(cache, pool))) {
            auditCount('governor', `prefetch-refused:${pool}`, 1, { bytes });
            return null;
        }
        const paneOf = cache.registration.paneId;
        const staging = pool === 'gpu' && paneOf !== undefined && this.charged[pool] > this.target[pool] - bytes &&
            kind !== 'canvas-working' && kind !== 'surface' && kind !== 'context' &&
            (kind === 'surface-scratch' || [...this.caches.values()].some(other => other.registration.paneId === paneOf &&
                other.registration.kind === 'surface-scratch' && other.bytes > 0));
        if (staging) {
            const working = [...this.caches.values()].filter(other => other.registration.paneId === paneOf &&
                other.registration.kind === 'canvas-working' && other.bytes > 0);
            const freed = working.reduce((sum, other) => sum + other.bytes, 0);
            if (freed > 0 && this.charged[pool] > this.target[pool] - bytes && this.charged[pool] - freed + bytes <= this.target[pool]) {
                this.trimming = true;
                try {
                    for (const other of working) this.evictCache(other, other.bytes);
                } finally { this.trimming = false; }
            }
        }
        if (!allowed()) {
            if (this.charged[pool] + bytes > this.target[pool]) {
                this.state = 'trimming';
                this.belowRecoverySince = null;
            }
            this.reclaimPane(cache, bytes);
            if (!allowed()) this.revokeHiddenContextsFor(cache, bytes);
            if (!allowed() && this.charged[pool] + bytes > this.target[pool]) this.trimPool(pool, Math.max(0, Math.min(this.target[pool] - bytes,
                Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio))));
            this.trimHiddenMirrors(kind === 'mirror' && cache.activity.hiddenAt !== null ? bytes : 0);
            if (!allowed()) {
                if (this.charged[pool] + bytes > this.target[pool]) {
                    auditCount('governor', `degrade:refused:${pool}:${cache.registration.id.split(':')[0]}:${cache.registration.kind}`, 1, { bytes });
                    this.refuseReservation(pool);
                }
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
        if (kind === 'context' || kind === 'program') this.plan();
        if (this.charged[pool] > this.target[pool] * POLICY.memorySoftPressureRatio) this.onPressureChange?.();
        return lease;
    }

    private paneNeedWaiting(cache: CacheRecord, pool: MemoryPool): boolean {
        const paneId = cache.registration.paneId;
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (paneId === undefined || !grant) return false;
        const limit = pool === 'gpu' ? grant.gpuCacheBytes : grant.cpuBytes;
        for (const other of this.caches.values()) {
            if (other.registration.paneId !== paneId || other.registration.pool !== pool) continue;
            let waiting = other.refusal !== null && other.refusal.epoch === this.capacityEpoch && other.refusal.bytes <= limit;
            if (!waiting) for (const bytes of this.capacityWaiters.get(other)?.values() ?? []) if (bytes !== undefined && bytes <= limit) { waiting = true; break; }
            if (waiting) { auditCount('governor', `prefetch-yield:${pool}`); return true; }
        }
        return false;
    }

    private overPool(pool: MemoryPool, bytes: number): boolean {
        return this.charged[pool] + bytes > this.target[pool];
    }

    private hasDemand(cache: CacheRecord): boolean {
        const { paneId } = cache.registration;
        if (paneId === undefined) return true;
        const pane = this.panes.find(item => item.paneId === paneId);
        return !!pane && pane.visible && pane.requestedPixels > 0 && cache.activity.hiddenAt === null;
    }

    private fits(cache: CacheRecord, bytes: number): boolean {
        const { pool, kind, paneId } = cache.registration;
        // Existing leases are grandfathered only for accounting, never for new admission.
        if (this.charged[pool] > this.target[pool] || this.charged[pool] + bytes > this.target[pool]) return false;
        if (kind === 'context') {
            const held = this.kindBytes('context');
            return held + bytes <= (POLICY.maxAppContexts - POLICY.reservedTerminalContexts) * POLICY.keptContextReserveBytes;
        }
        const pane = paneId === undefined ? undefined : this.paneById.get(paneId);
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (pool === 'gpu' && (cache.activity.hiddenAt !== null || !pane?.visible || !pane.requestedPixels ||
            (pane.cpuPinned && kind !== 'surface' && kind !== 'canvas-working' && kind !== 'surface-scratch'))) return false;
        if (cache.registration.foreground && (pool === 'cpu' || pool === 'gpu')) return true;
        if (kind === 'mirror' && cache.activity.hiddenAt !== null &&
            this.hiddenMirrorBytes() + bytes > this.hiddenMirrorLimit()) return false;
        if (paneId === undefined || kind === 'program') return true;
        if (pool === 'gpu' && !grant?.pixelGrant) return false;
        if (kind === 'live-input') return this.kindBytes('live-input') + bytes <= this.target[pool] * POLICY.liveInputGpuFraction;
        if (pool === 'cpu' && (cache.activity.hiddenAt !== null || !pane?.visible)) return true;
        if (!grant) return false;
        const limit = kind === 'surface' || kind === 'surface-scratch' ? grant.pixelGrant * POLICY.surfaceReserveBytesPerPixel :
            pool === 'gpu' ? grant.gpuCacheBytes : grant.cpuBytes;
        const used = this.paneUsed(paneId, pool, kind);
        if (pool === 'gpu' && kind === 'capture') {
            const captures = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
                other.registration.kind === 'capture' && other.activity.hiddenAt === null).reduce((sum, other) => sum + other.bytes, 0);
            if (captures + bytes > Math.max(0, grant.gpuCacheBytes - this.minimumProgressBytes())) return false;
        }
        return used + bytes <= limit;
    }

    private paneUsed(paneId: string, pool: MemoryPool, kind: MemoryKind): number {
        let used = 0;
        for (const other of this.caches.values()) {
            const { registration } = other;
            if (registration.paneId !== paneId || registration.pool !== pool || other.activity.hiddenAt !== null) continue;
            const counted = kind === 'surface' ? registration.kind === 'surface'
                : kind === 'surface-scratch' ? registration.kind === 'surface-scratch'
                : kind === 'canvas-working' ? registration.kind === 'canvas-working'
                : !PANE_APART_KINDS.has(registration.kind);
            if (counted) used += other.bytes;
        }
        return used;
    }

    private trimPanesOverGrant(): void {
        if (this.trimming) return;
        this.trimming = true;
        try {
            for (const [paneId, grant] of this.grants) {
                let excess = this.paneUsed(paneId, 'gpu', 'working') - grant.gpuCacheBytes;
                if (excess <= 0) continue;
                const candidates = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
                    other.registration.pool === 'gpu' && other.bytes > 0 && other.activity.hiddenAt === null &&
                    !['surface', 'program', 'context', 'mirror', 'mirror-retiring', 'live-input', 'canvas-working', 'surface-scratch'].includes(other.registration.kind))
                    .sort((a, b) => a.activity.lastVisibleAt - b.activity.lastVisibleAt || a.activity.lastUsedAt - b.activity.lastUsedAt ||
                        stableId(a.registration.id, b.registration.id));
                for (const other of candidates) {
                    if (excess <= 0) break;
                    const freed = this.evictCache(other, excess);
                    if (freed > 0) auditCount('governor', `grant-trim:gpu:${other.registration.id}`, 1, { bytes: freed });
                    excess -= freed;
                }
            }
        } finally { this.trimming = false; }
    }

    private reclaimPane(cache: CacheRecord, bytes: number): void {
        const { paneId, pool, kind } = cache.registration;
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (paneId === undefined || !grant || this.trimming) return;
        if (pool === 'gpu' && ['surface', 'program', 'context', 'live-input', 'canvas-working', 'surface-scratch'].includes(kind)) return;
        let excess = this.paneUsed(paneId, pool, kind) + bytes - (pool === 'gpu' ? grant.gpuCacheBytes : grant.cpuBytes);
        if (excess <= 0) return;
        const candidates = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
            other.registration.pool === pool && other.bytes > 0 && other.activity.hiddenAt === null &&
            RECLAIMABLE.includes(other.registration.class) &&
            (pool === 'cpu' || other !== cache) &&
            !['surface', 'program', 'context', 'mirror', 'mirror-retiring', 'live-input', 'canvas-working', 'surface-scratch'].includes(other.registration.kind))
            .sort((a, b) => (pool === 'cpu' && cache.registration.liveInput ? (a === cache ? 0 : 1) - (b === cache ? 0 : 1) : 0) ||
                RECLAIMABLE.indexOf(a.registration.class) - RECLAIMABLE.indexOf(b.registration.class) ||
                b.bytes - a.bytes ||
                a.activity.lastVisibleAt - b.activity.lastVisibleAt || a.activity.lastUsedAt - b.activity.lastUsedAt ||
                stableId(a.registration.id, b.registration.id));
        this.trimming = true;
        try {
            for (const other of candidates) {
                if (excess <= 0) break;
                const freed = this.evictCache(other, excess);
                if (freed > 0) auditCount('governor', `reclaim:${pool}:${other.registration.id}`, 1, { bytes: freed });
                excess -= freed;
            }
        } finally { this.trimming = false; }
    }

    private revokeHiddenContextsFor(cache: CacheRecord, bytes: number): void {
        const { paneId, pool, kind } = cache.registration;
        const pane = paneId === undefined ? undefined : this.paneById.get(paneId);
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (pool !== 'gpu' || paneId === undefined || !pane?.visible || !grant || this.trimming || cache.activity.hiddenAt !== null ||
            ['surface', 'program', 'context', 'live-input', 'canvas-working', 'surface-scratch'].includes(kind)) return;
        const excess = this.paneUsed(paneId, pool, kind) + bytes - grant.gpuCacheBytes;
        if (excess <= 0) return;
        let freed = 0;
        this.trimming = true;
        try {
            for (const other of this.caches.values()) {
                if (freed >= excess) break;
                if (other.registration.kind === 'context' && other.registration.pool === pool && other.bytes > 0) freed += this.evictCache(other, excess - freed);
            }
        } finally { this.trimming = false; }
        if (freed <= 0) return;
        auditCount('governor', 'reclaim:gpu:hidden-contexts', 1, { bytes: freed });
        this.replan();
    }

    private evictCache(cache: CacheRecord, bytes: number): number {
        const before = cache.bytes;
        const returned = cache.registration.evict(bytes);
        const reported = typeof returned === 'number' && Number.isFinite(returned) ? Math.max(0, returned) : 0;
        return Math.max(before - cache.bytes, reported);
    }

    private refuseReservation(pool: MemoryPool): void {
        if (this.refusing[pool]) return;
        this.refusing[pool] = true;
        this.lastTrouble = 'allocation';
        if (this.levelJustRaised()) this.recordFailedLevel();
        this.degrade();
        this.onPressureChange?.();
    }

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
        if (cache.closed && !cache.leaseCount && cache.unaccounted > 0) {
            cache.bytes -= cache.unaccounted;
            this.charged[pool] -= cache.unaccounted;
            cache.unaccounted = 0;
        }
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

    private hiddenPaneCache(cache: CacheRecord): boolean {
        const { paneId, kind } = cache.registration;
        if (paneId === undefined || HIDDEN_KEPT_KINDS.has(kind)) return false;
        const pane = this.paneById.get(paneId);
        return pane ? !pane.visible : cache.activity.hiddenAt !== null;
    }

    private releaseHiddenPane(paneId: string): void {
        if (this.trimming) {
            if (!this.hiddenReleaseDeferred.size) queueMicrotask(() => this.releaseDeferredHidden());
            this.hiddenReleaseDeferred.add(paneId);
            auditCount('governor', 'hidden-release:deferred');
            return;
        }
        this.trimming = true;
        try {
            for (const cache of [...this.caches.values()]) {
                if (cache.registration.paneId !== paneId || cache.bytes <= 0 || !this.hiddenPaneCache(cache)) continue;
                const { pool, id } = cache.registration;
                const freed = this.evictCache(cache, cache.bytes);
                if (freed > 0) auditCount('governor', `hidden-release:${pool}`, 1, { bytes: freed });
                if (pool === 'cpu' && cache.bytes > 0) auditCount('governor', `hidden-kept:cpu:${id}`, 1, { bytes: cache.bytes });
            }
        } finally { this.trimming = false; }
    }

    private releaseDeferredHidden(): void {
        const panes = [...this.hiddenReleaseDeferred];
        this.hiddenReleaseDeferred.clear();
        for (const paneId of panes) this.releaseHiddenPane(paneId);
    }

    private hiddenPaneBytes(): { gpu: number; cpu: number } {
        const bytes = { gpu: 0, cpu: 0 };
        for (const cache of this.caches.values()) if (cache.bytes > 0 && this.hiddenPaneCache(cache)) bytes[cache.registration.pool] += cache.bytes;
        return bytes;
    }

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
                cache.registration.evict(excess);
            }
        } finally { this.trimming = false; }
    }

    private pressureTrim(pool: MemoryPool, aim: number): boolean {
        if (this.trimming) return false;
        if (this.trimmedAt[pool] >= 0 && this.charged[pool] <= this.trimmedAt[pool]) {
            auditCount('governor', `trim-skip:${pool}`);
            return this.charged[pool] > this.target[pool];
        }
        this.trimmedAt[pool] = this.charged[pool];
        this.madeRoom = true;
        return this.trimPool(pool, aim) > 0 && this.charged[pool] > this.target[pool];
    }

    trimForAudit(pool: MemoryPool): number {
        const before = this.charged[pool];
        const left = this.trimPool(pool, 0);
        return Math.max(0, before - left);
    }

    private trimPool(pool: MemoryPool, target: number): number {
        if (this.trimming) return 0;
        const order: readonly MemoryClass[] = ['hidden-pane', 'hidden-mirror', 'obsolete-arrival', 'offscreen-high',
            'redundant-level', 'prefetch', 'scene-cache', 'critical'];
        const evictionClass = (cache: CacheRecord): MemoryClass => cache.registration.kind === 'mirror' && cache.activity.hiddenAt !== null ?
            'hidden-mirror' : this.hiddenPaneCache(cache) ? 'hidden-pane' : cache.registration.class;
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
                const freed = this.evictCache(cache, excess);
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

    trouble(): LayerTrouble {
        if (this.now - this.slowGpuAt < SLOW_GPU_HOLD_MS) return 'slow-gpu';
        return layerTroubleOf(this.state, this.lastTrouble);
    }

    cool(): boolean {
        return this.charged.gpu < this.target.gpu * POLICY.memoryTrimTargetRatio &&
            this.charged.cpu < this.target.cpu * POLICY.memorySoftPressureRatio;
    }

    private belowFull(): boolean {
        if (this.qualityLimit < 1) return true;
        for (const value of this.paneCeiling.values()) if (value < 1) return true;
        return false;
    }

    private recoverRoom(): void {
        if (this.trimming || !this.recoveryDue()) return;
        const line = Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio);
        this.recoveryTrimmedAt = this.charged.gpu;
        this.madeRoom = true;
        const before = this.charged.gpu;
        this.trimPool('gpu', line - 1);
        auditCount('governor', 'recovery-trim:gpu', 1, { bytes: Math.max(0, before - this.charged.gpu) });
    }

    private recoveryDue(): boolean {
        const charged = this.charged.gpu;
        return this.belowFull() && charged >= Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio)
            && charged <= this.target.gpu * POLICY.memorySoftPressureRatio && charged !== this.recoveryTrimmedAt;
    }

    private recoveryDelay(): number {
        return this.madeRoom && this.belowFull() ? POLICY.memoryMadeRoomRecoveryDelayMs : POLICY.memoryRecoveryDelayMs;
    }

    private levelJustRaised(): boolean {
        return this.now - this.raisedAt < POLICY.qualityFailureResetMs;
    }

    private recordFailedLevel(): void {
        if (this.failedQuality === this.qualityLimit) this.failureBackoffMs = Math.min(this.failureBackoffMs * 2, POLICY.qualityFailureBackoffMaxMs);
        else { this.failedQuality = this.qualityLimit; this.failureBackoffMs = POLICY.qualityFailureBackoffMinMs; }
        this.failedUntil = this.now + this.failureBackoffMs;
    }

    private raiseRefused(now: number): boolean {
        return this.failedQuality !== null && now < this.failedUntil &&
            Math.min(1, this.qualityLimit / POLICY.qualityReductionFactor) >= this.failedQuality;
    }

    holdPressure(now: number): void {
        this.pressureHoldUntil = Math.max(this.pressureHoldUntil, now + POLICY.resumePressureHoldMs);
    }

    private degrade(): void {
        this.state = 'degraded';
        this.belowRecoverySince = null;
        if (this.now - this.degradedAt >= POLICY.qualityStepSettleMs) {
            this.degradedAt = this.now;
            this.levelSince = this.now;
            this.qualityLimit = Math.max(POLICY.minInteractiveQualityScale, this.qualityLimit * POLICY.qualityReductionFactor);
        }
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
        let remaining = Math.max(0, Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio) - overhead);
        const supported: PaneMemoryDemand[] = [];
        for (const pane of [...visible].sort((a, b) => weight(b) - weight(a) || stableId(a.paneId, b.paneId))) {
            if (remaining < minimum) continue;
            supported.push(pane);
            remaining -= minimum;
        }
        const byWeight = [...visible].sort((a, b) => weight(b) - weight(a) || stableId(a.paneId, b.paneId));
        const floorPixels = new Map<string, number>();
        for (const pane of byWeight) {
            const px = Math.floor(pane.requestedPixels * MIN_SURFACE_QUALITY * MIN_SURFACE_QUALITY);
            const bytes = px * POLICY.surfaceReserveBytesPerPixel;
            if (bytes > remaining) continue;
            floorPixels.set(pane.paneId, px);
            remaining -= bytes;
        }
        const pinned = waterFill(supported.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.max(0, Math.min(pane.gpuPinnedBytes ?? 0, pane.gpuNeedBytes - minimum)) })), remaining);
        remaining -= [...pinned.values()].reduce((sum, value) => sum + value, 0);
        const ceilingOf = (pane: PaneMemoryDemand) => Math.min(this.qualityLimit, this.paneCeiling.get(pane.paneId) ?? 1);
        const surfaceBytes = Math.min(Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio * POLICY.surfaceMaxGpuGrantFraction), remaining);
        const pixels = waterFill(visible.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.max(0, Math.floor(pane.requestedPixels * ceilingOf(pane) * ceilingOf(pane)) - (floorPixels.get(pane.paneId) ?? 0)) })),
        Math.floor(surfaceBytes / POLICY.surfaceReserveBytesPerPixel));
        const pixelGrantOf = (paneId: string): number => (floorPixels.get(paneId) ?? 0) + (pixels.get(paneId) ?? 0);
        for (const pane of visible) {
            const granted = pixelGrantOf(pane.paneId);
            if (granted >= Math.floor(pane.requestedPixels * ceilingOf(pane) * ceilingOf(pane))) continue;
            const q = Math.sqrt(granted / pane.requestedPixels);
            if (q < (this.paneCeiling.get(pane.paneId) ?? 1)) this.paneCeiling.set(pane.paneId, Math.max(MIN_SURFACE_QUALITY, q));
        }
        const assignedSurface = [...pixels.values()].reduce((sum, value) => sum + value, 0) * POLICY.surfaceReserveBytesPerPixel;
        const cache = waterFill(supported.map(pane => ({ id: pane.paneId, weight: weight(pane),
            need: Math.max(0, pane.gpuNeedBytes - minimum - (pinned.get(pane.paneId) ?? 0)) })), Math.max(0, remaining - assignedSurface));
        const cacheCapacity = Math.max(0, remaining - assignedSurface);
        const spare = cacheCapacity - [...cache.values()].reduce((sum, value) => sum + value, 0);
        const totalWeight = supported.reduce((sum, pane) => sum + weight(pane), 0);
        if (spare > 0 && totalWeight > 0) {
            for (const pane of supported) cache.set(pane.paneId, (cache.get(pane.paneId) ?? 0) + Math.floor(spare * weight(pane) / totalWeight));
        }
        for (const [id, bytes] of pinned) cache.set(id, (cache.get(id) ?? 0) + bytes);
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
                gpuCacheBytes: hasCacheCredit ? minimum + (cache.get(pane.paneId) ?? 0) : 0,
                cpuBytes: cpu.get(pane.paneId) ?? 0, qualityScale: q,
                state: pane.cpuPinned ? 'cpu-pinned' as const :
                    pane.visible && pane.requestedPixels > 0 && q < 1 ? 'degraded' as const : this.state,
                qualityNotice: pane.visible && pane.requestedPixels > 0 && q < POLICY.minInteractiveQualityScale,
            })];
        }));
    }
}
