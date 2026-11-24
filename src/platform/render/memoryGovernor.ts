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
    /** A live gesture's working set (wet ink). Bounded by the pool, outside its pane's cache grant: it is released only
     * after the committed layers present the dry frame, so charging it to the grant those layers need was a cycle
     * (measured: 101 wet-tile refusals in one stroke with the pool 57% full, then the stroke's tail never drew). */
    'live-input';
export type MemorySessionOwner = Readonly<Pick<RenderToken, 'vaultEpoch' | 'documentId' | 'session'>>;
export type MemoryPressureState = 'normal' | 'trimming' | 'degraded' | 'cpu-pinned';
export type DeviceMemoryClass = 'low' | 'medium' | 'high';

/** How a reservation may be admitted. */
export interface ReserveOptions {
    /** Work ahead of need (a tile ring outside the view): admitted only if it fits as the pool and grant stand. A refusal reclaims
     * nothing, trims nothing and is not pressure. Two layers of one notebook pane prefetched rings that reclaimed each other's
     * undrawn tiles, recomposed the next frame: at rest at 332%, 60 presents a second and 985 MB of tiles evicted per second, and the
     * board never left 'Updating'. */
    readonly prefetch?: boolean;
    /** A first ask that the owner can still answer itself: admitted only if it fits as the pool and grant stand, and a refusal
     * reclaims nothing, trims nothing and is not pressure. The owner then frees what it holds and does not need, and asks again
     * without it; only that refusal is pressure. */
    readonly quiet?: boolean;
}
/** What a hidden pane may keep: the broker's context and program reserves (a return reuses them), and session mirrors, which belong
 * to the document session and have their own hidden budget (hiddenMirrorLimit). Everything else a pane holds is asked back at hide. */
const HIDDEN_KEPT_KINDS: ReadonlySet<string> = new Set(['context', 'program', 'mirror', 'mirror-retiring']);
/** The kinds a pane's layer-cache share never counts: each is limited apart (paneUsed). */
const PANE_APART_KINDS: ReadonlySet<string> = new Set(['surface', 'program', 'context', 'live-input', 'canvas-working', 'surface-scratch']);
/** The exact token object crosses the arena boundary; never reconstruct a ByteLease by id. */
export interface MemoryAllocator {
    reserve(bytes: number, options?: ReserveOptions): ByteLease | null;
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
    /** A live layer's cache (a stroke in flight). Its CPU reservations reclaim their own idle geometry before the pane's others. */
    readonly liveInput?: boolean;
    /** A layer's CPU reservations for what its frame shows: admitted while the pool fits, whatever the pane's CPU share. */
    readonly foreground?: boolean;
    readonly owner?: MemorySessionOwner;
    readonly memory: () => ArenaMemory;
    /** Eviction request for up to `bytes`; returns the bytes it frees, or 0 when it frees nothing (a touched entry). An owner
     * whose release is asynchronous returns the bytes it has released (retiring), since its charge falls only later. An owner
     * that returns nothing is counted by the bytes its cache's reservation drops synchronously, and nothing more: see evictCache. */
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
    /** The pane's nominal device pixel ratio (absent: 1). The GPU target's fixed terms were sized for DPR 1 panes (see updatePanes). */
    readonly devicePixelRatio?: number;
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
    /** Models derived from open documents (reportDerivedModel), all owners together. */
    readonly derivedModelBytes: number;
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
    /** Bytes the owner published beyond its leases (an accounting fault, see reconcileUnaccounted). They are charged to the
     * cache and returned with its last lease. */
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

/** One recovery step up. A level within float noise of full is full: a pane's ceiling is the square root of its pixel share
 * (0.7999999 for a 0.8 grant), and divided back up it came to 0.99999998, so the plan granted the request less one pixel, the
 * surface was 1871x1455 for 1872x1456, no frame was ever at quality 1 and a WebGL2 PDF's editing cover, which waits for a sharp
 * frame, never lifted (measured at DPR 2; each retry for the missing pixel needed a full-size bridge that the pool refused, and
 * quality fell back to 0.8). */
function raisedQuality(value: number): number {
    const next = value / POLICY.qualityReductionFactor;
    return next >= 1 - 1e-6 ? 1 : next;
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
        a.requestedPixels === b.requestedPixels && a.devicePixelRatio === b.devicePixelRatio && a.gpuNeedBytes === b.gpuNeedBytes &&
        a.cpuNeedBytes === b.cpuNeedBytes &&
        a.gpuPinnedBytes === b.gpuPinnedBytes &&
        a.cpuMandatoryBytes === b.cpuMandatoryBytes && a.cpuPinned === b.cpuPinned;
}

/** Residency a pane grant may reclaim before it refuses a reservation: never critical, hidden, surface or context. */
const RECLAIMABLE: readonly MemoryClass[] = ['redundant-level', 'prefetch', 'scene-cache'];
/** How long after a slow GPU window the layers keep bounding their per-frame work. Windows come once per POLICY.slowGpuSampleCount
 * timed frames, so a sustained slow GPU keeps the bound on only while the windows keep arriving; one window is held for a second. */
const SLOW_GPU_HOLD_MS = 1000;

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
    /** Panes hidden while a trim ran, whose release waits for it to end (releaseHiddenPane). */
    private readonly hiddenReleaseDeferred = new Set<string>();
    // A run of refused reservations in one pool is one episode: it degrades the governor once, and its retries only wait.
    private readonly refusing: Record<MemoryPool, boolean> = { gpu: false, cpu: false };
    private state: Exclude<MemoryPressureState, 'cpu-pinned'> = 'normal';
    private lastTrouble: MemoryTrouble | null = null;
    private qualityLimit = 1;
    /** The GPU charge at the last recovery trim (advance): asked again only once the charge has changed. */
    private recoveryTrimmedAt = -1;
    /** The governor trimmed since the last step down: a cool window after that is the room it made (memoryMadeRoomRecoveryDelayMs). */
    private madeRoom = false;
    /** When the quality last stepped up: a refusal soon after is that level failing; later, it is a budget step (recordFailedLevel). */
    private raisedAt = Number.NEGATIVE_INFINITY;
    private belowRecoverySince: number | null = null;
    private degradedAt = Number.NEGATIVE_INFINITY;
    /** The governor clock at the last slow GPU window: timing evidence for the layers, never a trim or a quality step. */
    private slowGpuAt = Number.NEGATIVE_INFINITY;
    // The level that last failed under trouble, the earliest time it may be retried, and the current back-off.
    private failedQuality: number | null = null;
    private failedUntil = Number.NEGATIVE_INFINITY;
    private failureBackoffMs: number = POLICY.qualityFailureBackoffMinMs;
    private wake: number | null = null;
    private levelSince = Number.NEGATIVE_INFINITY;
    private pressureHoldUntil = Number.NEGATIVE_INFINITY;
    // The charge each pool held when its last pressure trim ran, or -1 when the pool has been under its soft line since. A trim
    // asks every reclaimable cache for bytes; asked again at the same charge it can only take what the owners rebuilt from the
    // last ask, so it runs again only once the pool has grown past that charge (or its target moved). Measured, canvas2d DPR 2
    // annotated PDF: the CPU pool sat at 30.3 MB over its 30.2 MB line, every tick evicted 3.5 MB of tiles the plan still
    // wanted, the next frame rebuilt them (133 evictions in 4.4 s) and the board's new shapes never presented.
    private readonly trimmedAt: Record<MemoryPool, number> = { gpu: -1, cpu: -1 };
    private now = 0;
    private workerHeapBytes = 0;
    private readonly workerHeaps = new Map<object, number>();
    private readonly legacyWorker = {};
    private sourceBytes = 0;
    private derivedModelBytes = 0;
    private readonly derivedModels = new Map<object, number>();

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
                    // A cache that was hidden or shown changes what a trim may take at the same charge (trimPool asks by visibility).
                    if (activity.hiddenAt !== cache.activity.hiddenAt) { this.trimmedAt.gpu = -1; this.trimmedAt.cpu = -1; }
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
        // The scheduler refreshes every frame (snapshotScene), so demand that did not change re-plans nothing: the grants
        // move only with the demand, with degradation and recovery (which plan themselves) and with context/program charges.
        const changed = this.panes.length !== panes.length || panes.some((pane, i) => !samePaneDemand(pane, this.panes[i]));
        const hiding = changed ? panes.filter(pane => !pane.visible && this.paneById.get(pane.paneId)?.visible).map(pane => pane.paneId) : [];
        this.panes = panes.map(pane => ({ ...pane }));
        this.paneById.clear();
        for (const pane of this.panes) this.paneById.set(pane.paneId, pane);
        for (const id of this.paneCeiling.keys()) if (!ids.has(id)) this.paneCeiling.delete(id);
        if (changed) {
            this.bumpCapacity();
            // The floor, the base and the per-pane share were sized for DPR 1 panes; at DPR 2 every tile, scratch and surface of the same
            // pane holds four times the bytes, so they scale with the square of the largest visible DPR, inside the device's ceiling (a
            // low-memory device stays at its 128 MB). Unscaled, a DPR 2 pane sat at the 64 MB floor: after a saturated zoom the pool
            // held 59.9 MB, the trim found nothing more to give, the surface rebuild was refused every frame and the pane never drew
            // again (measured: doc12 and LARGE=11 at DPR 2, draw-sat and drag-sat 0/91; zoom-sat 52-70 stand-in presents).
            this.target.gpu = Math.min(this.ceilings.gpuBytes, Math.max(POLICY.gpuGrantMinBytes * dprScale,
                (POLICY.gpuGrantBaseBytes + POLICY.gpuGrantPerVisiblePaneBytes * visible) * dprScale + POLICY.gpuGrantPerVisiblePixelBytes * pixels));
            // The CPU target also covers every visible pane's declared floor, inside the device ceiling, with room for the pressure trim:
            // the per-pixel formula (8 MB + 12 B/px) is below a PDF pane's floor (its view's tiles, their cropped mirror and the 2D
            // canvas: ~15-17 B per device pixel), so one PDF alone, nothing else open, was refused its floor at DPR 2. Measured, one
            // visible PDF: 1440x900 (3.49 M device px) floor 50.3-54.5 MB against a 50.2 MB grant; 2560x1440 (11.76 M) 159.7-169.6 MB
            // against 149.6 MB. Divided by the trim line, not the soft line: a trim takes the pool to 80% of the target, and at
            // floor / 0.9 that is under the floor itself, so a trim evicted visible tiles. Floor / 0.8 is 60-68 and 200-212 MB here;
            // a 'high' device's 256 MB ceiling holds both, a smaller device's ceiling still bounds it.
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
     * `floor`: canvas2d's own display, the last rung of the presentation ladder. Its canvas is allocated and its bytes are charged
     * already, and the GPU display it replaces is zeroed, so a refusal frees nothing and leaves the pane with no display: it threw
     * "CPU backing promotion was refused" and the pane ended in an error (measured: 1 in 6 resizes of a board, 2 in 7 after a copy,
     * and both read-only neighbours of a copied middle pane of three). It is granted; a pool it leaves over target is pressure,
     * which trims and steps quality like any other, and the pane's next size follows its grant.
     */
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

    /** What one owner holds of a model derived from its document (a board's stroke geometry): an absolute byte count, 0 when it
     * holds none. It grows with the document, not with pixels, so it is reported beside the worker heaps and never charged to a
     * raster pool: charged as the board's CPU working set, a 10,060-stroke drawing's geometry (122 MB) held the 128 MB pool over
     * its target and the app reduced its rendering quality at rest (measured, WebGL2). */
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

    /** Called by the shared scheduler, not a governor-owned timer (§6.4:653). */
    advance(now: number, liveGesture: boolean): void {
        if (!Number.isFinite(now) || now < this.now) throw new MemoryAdmissionError('invalid-input');
        this.now = now;
        for (const cache of this.caches.values()) this.reconcileUnaccounted(cache);
        this.trimHiddenMirrors();
        // Quality drops only when the trims cannot bring a pool back to target: a trim that frees what it is asked for
        // is the answer to pressure, and a degradation for pressure it has not yet had the chance to release is premature.
        let unmet: MemoryPool | null = null;
        for (const pool of ['gpu', 'cpu'] as const) {
            if (this.charged[pool] > this.target[pool] * POLICY.memorySoftPressureRatio) {
                this.state = 'trimming';
                if (this.pressureTrim(pool, Math.floor(this.target[pool] * POLICY.memoryTrimTargetRatio))) unmet ??= pool;
            } else this.trimmedAt[pool] = -1;
        }
        // Over budget steps down unless a resume holds pressure: the rebuild after a return is charged at once, and stepping on it stacked
        // the quality down (1.0 -> 0.8 -> 0.64), which the recovery window then held for five seconds.
        if (unmet && now >= this.pressureHoldUntil) { auditCount('governor', `degrade:unmet:${unmet}`); this.degrade(); }
        this.trimPanesOverGrant();
        if (!liveGesture) this.recoverRoom();
        const cool = this.cool() && !liveGesture;
        if (!cool) this.belowRecoverySince = null;
        else if (this.belowRecoverySince === null) this.belowRecoverySince = now;
        else if (now - this.belowRecoverySince >= this.recoveryDelay() && !this.raiseRefused(now)) {
            // Only a step that raises something starts a level's trial: at full quality this branch runs every cool window, and
            // counted as a raise it made each refusal at 1 a failed level (measured: the back-off doubled to 60 s within 50 ms).
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
        // Pressure is over once the cool window has held, whether or not the raise is allowed: the label then follows the quality
        // (degraded while it is lowered). Measured: a raise refused at 1.0 left 'trimming' for the whole run at 0.8.
        if (this.state === 'trimming' && cool && this.belowRecoverySince !== null && now - this.belowRecoverySince >= this.recoveryDelay()) {
            this.state = this.qualityLimit < 1 ? 'degraded' : 'normal';
        }
        if (this.failedQuality !== null && now - this.levelSince >= POLICY.qualityFailureResetMs) {
            this.failedQuality = null;
            this.failureBackoffMs = POLICY.qualityFailureBackoffMinMs;
        }
        this.wake = this.nextWake(now, cool, unmet !== null);
    }

    /** The next instant at which advancing again changes something, with no event to wait for: a degrade that a resume hold
     * deferred, and a recovery that has held its cool window (or its failed level's back-off). Null when nothing is pending. */
    private nextWake(now: number, cool: boolean, unmet: boolean): number | null {
        const hold = unmet && now < this.pressureHoldUntil ? this.pressureHoldUntil : null;
        let recovery: number | null = null;
        // A lowered quality over the GPU's cool line with a charge the recovery trim has not asked about is not waited out: no
        // event may come (measured: 46 s at 215.0 MB against a 214.7 MB line with no advance), so one advance is armed to ask.
        if (this.recoveryDue()) recovery = now + POLICY.qualityStepSettleMs;
        // A pane's ceiling lowered under an app quality of 1 leaves the state 'normal': waited on the state alone, no advance came to
        // raise it, and the pane rested at its lowered quality for good (measured, the 5,642-stroke board after a zoom to fit on WebGL2,
        // 1 run in 10: ceiling 0.488, cool, no wake, the 'quality reduced' notice at rest).
        if ((this.state !== 'normal' || this.belowFull()) && cool && this.belowRecoverySince !== null) {
            let due = this.belowRecoverySince + this.recoveryDelay();
            if (this.failedQuality !== null) due = Math.max(due, this.failedUntil);
            recovery = Math.max(due, now);
        }
        if (hold === null) return recovery;
        return recovery === null ? hold : Math.min(hold, recovery);
    }

    /** When the governor next needs an advance with no event to deliver it (see nextWake), or null. */
    wakeAt(): number | null { return this.wake; }

    signalTrouble(reason: MemoryTrouble): void {
        this.lastTrouble = reason;
        this.state = 'trimming';
        this.belowRecoverySince = null;
        // A device limit fails its level whenever it comes; a budget shortage ('allocation') only when it follows a raise to the level.
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

    /** A slow GPU window is a time problem, not memory: it never trims a cache and never steps quality. It is recorded so the
     * layers bound their own work per frame (`trouble()` reports 'slow-gpu' for a hold after it). A quality step answers memory
     * pressure only, through the pool paths. Measured: a trim on the window evicted a notebook's visible-set tiles mid-zoom, and
     * the rebuild was more GPU work in that same zoom. */
    private signalSlowGpu(): void {
        auditCount('governor', 'slow-gpu', 1);
        this.slowGpuAt = this.now;
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
            workerHeapBytes: this.workerHeapBytes, sourceBytes: this.sourceBytes, derivedModelBytes: this.derivedModelBytes,
        };
    }

    /** A read reports what the owner holds and never changes a charge: the charge moves in reconcileUnaccounted, once per
     * frame, so two reads in a frame (the scheduler's and the audit's) cannot disagree about it. */
    private cacheReadout(cache: CacheRecord): MemoryCacheReadout {
        const { live, retiring } = cache.registration.memory();
        count(live);
        count(retiring);
        return { live, retiring, reservedBytes: cache.bytes, leaseCount: cache.leaseCount, closed: cache.closed };
    }

    /** Sets the charge a cache holds for live bytes its leases do not cover, so the pool counts what is on the device. Idempotent:
     * the charge is the owner's current excess over its leases, not a running sum, so a publication that lags its release (a
     * retiring buffer) keeps the charge until the owner's bytes fall, and a read that repeats changes nothing. The charge is
     * the full deficit, not a clamp: a clamp would understate the pool. Logged once per cache, named. */
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

    /** Render audit only: every cache's charge with its pane, and each pane's grant. */
    auditCaches(): { caches: { id: string; pane: string | null; pool: MemoryPool; kind: MemoryKind; bytes: number; hidden: boolean;
        waiters: number; waiting: (number | null)[]; refused: number | null }[];
        grants: { pane: string; cpuBytes: number; gpuCacheBytes: number; pixelGrant: number; qualityScale: number }[]; panes: readonly PaneMemoryDemand[];
        target: { gpu: number; cpu: number }; hiddenPanes: { gpu: number; cpu: number }; recovery: Record<string, unknown> } {
        return {
            caches: [...this.caches.values()].filter(cache => cache.bytes > 0).map(cache => ({ id: cache.registration.id,
                pane: cache.registration.paneId ?? null, pool: cache.registration.pool, kind: cache.registration.kind,
                bytes: cache.bytes, hidden: cache.activity.hiddenAt !== null,
                waiters: this.capacityWaiters.get(cache)?.size ?? 0,
                // Each waiter's size (null: any release wakes it), so a kit can tell a sized wait from a parked unsized one.
                waiting: [...(this.capacityWaiters.get(cache)?.values() ?? [])].map(bytes => bytes ?? null),
                refused: cache.refusal?.bytes ?? null })),
            grants: [...this.grants].map(([pane, grant]) => ({ pane, cpuBytes: grant.cpuBytes, gpuCacheBytes: grant.gpuCacheBytes,
                pixelGrant: grant.pixelGrant, qualityScale: grant.qualityScale })),
            panes: this.panes, target: { ...this.target }, hiddenPanes: this.hiddenPaneBytes(),
            // Why a lowered quality has or has not stepped back up: every input advance() reads for the raise.
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
        // A request larger than the whole pool can never fit, so it is no sign of pressure: refusing it must not trim
        // others or degrade the app. Seen: a board's 81 MB direct estimate against the 32 MB CPU target, asked on each
        // return to a 1% overview of ~5,400 items, degraded the governor before the board fell back to dense tiles.
        if (bytes > this.target[pool]) return null;
        // Refused and nothing has moved since: the same request is refused again without the reclaim and trims that made the
        // first refusal. Measured earlier as the evict/realloc loop; an owner that retries each frame must not re-run them.
        // A foreground request is not memoised: its refusal wakes on the pool's release, and a memo would park it past one.
        if (!cache.registration.foreground && cache.refusal && cache.refusal.epoch === this.capacityEpoch && bytes >= cache.refusal.bytes) return null;
        const allowed = () => this.fits(cache, bytes);
        // A pane with no demand yet holds a zero grant, so its first allocation is refused without being over anything.
        // That is not pressure: nothing is trimmed and no quality is stepped. The refused work waits, and the replan that
        // grants the pane's demand wakes it. Seen: a new arrow's first 64 KB working buffer degraded a near-empty canvas2d pane.
        if (!allowed() && !this.overPool(pool, bytes) && !this.hasDemand(cache)) return null;
        if (options?.quiet && !allowed()) return null;
        // Work ahead of need also stops at the soft-pressure line: the pressure trim takes the pool back below it, so prefetch admitted
        // above it is evicted again. Measured (canvas2d, DPR 2 annotated PDF): prefetch filled the CPU pool to its target, every mirror
        // crop or board buffer after it was refused, its refusal trimmed the pool to 80% (4.3 MB of prefetch), the prefetch was rastered
        // again into the room, 733 times in 30 s, and no shape the board made ever presented.
        // Nor while a cache of the same pane waits for room it needs: the room an eviction gives back is that cache's, and a ring
        // refilled first took it (measured: doc12 with a picture, WebGL2, at rest: the board's ring refilled what its evictions freed and
        // the PDF's visible exact tiles were refused for good, the page on stand-ins).
        // While the quality is down, GPU prefetch stops at the line the step back up needs (cool, under the trim target): admitted to
        // the soft line, a board's ring held the pool between the two and the pane at 0.8 (recoverRoom).
        // CPU prefetch always stops at the trim target, under the CPU's cool line (its soft line, cool()): caches admitted ahead of need
        // up to the soft line parked the pool on it, so it was never cool, the governor stayed 'trimming' at rest (layers read
        // 'pressure') and a lowered quality never stepped back up (measured: an old notebook's node buffer and geometry held the CPU
        // pool at 30.2 of 33.6 MB for good, "Rendering quality was reduced" up for the session).
        const prefetchLine = pool === 'cpu' || this.belowFull() ? POLICY.memoryTrimTargetRatio : POLICY.memorySoftPressureRatio;
        if (options?.prefetch && (!allowed() || this.charged[pool] + bytes > this.target[pool] * prefetchLine ||
            this.paneNeedWaiting(cache, pool))) {
            auditCount('governor', `prefetch-refused:${pool}`, 1, { bytes });
            return null;
        }
        // A pane's GPU surface replaces its 2D picture: the 2D working canvases of the same pane are that picture's scratch, and they
        // are dropped before the pane's new backing is refused for want of room they hold (measured, DPR 2: a 2D fallback held 44 MB of
        // working canvases beside its 33 MB display, so the GPU scratch of the same pane was refused and quality stepped down).
        const paneOf = cache.registration.paneId;
        // The same holds while the pane's GPU surface is staged beside its 2D picture (its surface scratch is charged): any GPU
        // reservation of that pane may take the 2D working canvases, since the outgoing picture is on its own display canvas.
        // Measured (WebGL2, DPR 2 PDF open): 2D display 32.7 + working 43.6 + GPU scratch 32.7 + context 4.2 MB left no room for
        // the first 1.1 MB page tile, its refusal degraded the app to 0.8 at 1.3 s, and every view stayed soft until the 5 s
        // recovery (an annotate toggle then took 3.2 s, canvas2d 0.9 s).
        // Only a request the pool cannot hold looks (the scan below is per reservation otherwise).
        const staging = pool === 'gpu' && paneOf !== undefined && this.charged[pool] > this.target[pool] - bytes &&
            kind !== 'canvas-working' && kind !== 'surface' && kind !== 'context' &&
            (kind === 'surface-scratch' || [...this.caches.values()].some(other => other.registration.paneId === paneOf &&
                other.registration.kind === 'surface-scratch' && other.bytes > 0));
        if (staging) {
            // The 2D working canvases are only worth giving up when that makes the scratch fit: a scratch still refused after their
            // eviction left them rebuilt by the next 2D frame for nothing (review3, gpu-h2). The pool is the only check that they
            // can change: the scratch's own limit counts no canvas.
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
        // Context overhead reduces the next surface/cache plan before any device is created.
        if (kind === 'context' || kind === 'program') this.plan();
        if (this.charged[pool] > this.target[pool] * POLICY.memorySoftPressureRatio) this.onPressureChange?.();
        return lease;
    }

    /** A cache of `cache`'s pane in `pool`, `cache` itself included, waits for need capacity the grant can hold: a refusal of this
     * capacity epoch, or a sized waiter. One the grant can never hold, or a refusal from before capacity last moved, blocks nothing.
     * Counted. The asking cache counts too: a board's ring and its refused visible tile share one cache, and the room a raised grant
     * gave the tile went to the ring first, so the tile stayed on its stand-in for good (measured, a narrow pane of dense ink beside
     * two others after divider drags on WebGL2: its grant raised 1.6 MB, its ring took 1.6 MB, its visible tile waited on). */
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

    /** The pool itself cannot take the bytes: the only refusal that is pressure without a pane's own demand. */
    private overPool(pool: MemoryPool, bytes: number): boolean {
        return this.charged[pool] + bytes > this.target[pool];
    }

    /** A visible, shown pane that asked for pixels. A pane-less cache (the app's own) always has demand. */
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
        // The broker's one app-wide allocator owns all reservations, including lost ones (§3.3:360).
        if (kind === 'context') {
            const held = this.kindBytes('context');
            return held + bytes <= (POLICY.maxAppContexts - POLICY.reservedTerminalContexts) * POLICY.keptContextReserveBytes;
        }
        const pane = paneId === undefined ? undefined : this.paneById.get(paneId);
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (pool === 'gpu' && (cache.activity.hiddenAt !== null || !pane?.visible || !pane.requestedPixels ||
            (pane.cpuPinned && kind !== 'surface' && kind !== 'canvas-working' && kind !== 'surface-scratch'))) return false;
        // A foreground request (what the frame shows) is admitted while the pool fits, whatever its pane's share: the share sized
        // around unowned derived geometry, so the pane was refused with the pool 27-29 MB of 32 MiB (measured: 4.8 MB short over 7
        // refusals in the draw phase). Background work below stays inside the grant. A GPU request passes the demand guard above first:
        // a hidden, invisible, zero-pixel or CPU-pinned pane's GPU work is not what its frame shows (review: gpu-h9).
        if (cache.registration.foreground && (pool === 'cpu' || pool === 'gpu')) return true;
        if (kind === 'mirror' && cache.activity.hiddenAt !== null &&
            this.hiddenMirrorBytes() + bytes > this.hiddenMirrorLimit()) return false;
        if (paneId === undefined || kind === 'program') return true;
        if (pool === 'gpu' && !grant?.pixelGrant) return false;
        // Bounded by the pool, not the pane grant, but never more than a quarter of it: one stroke's 46 MB of wet tiles held
        // the pool over target and trimmed every other cache each frame.
        if (kind === 'live-input') return this.kindBytes('live-input') + bytes <= this.target[pool] * POLICY.liveInputGpuFraction;
        if (pool === 'cpu' && (cache.activity.hiddenAt !== null || !pane?.visible)) return true;
        if (!grant) return false;
        // A surface backing's scratch is sized by the pixel grant, as the display is. Checked against the cache share it was
        // refused at quality 1 (measured, DPR 2 GPU: 32.7 MB requested, 81 MB charged, cache share below the backing), and each
        // refusal stepped the quality down again. Its own kind, so a 2D compositor's working canvas keeps the cache share.
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

    /** The bytes a pane's grant counts against a new cache of this kind: its visible, non-surface residency. */
    private paneUsed(paneId: string, pool: MemoryPool, kind: MemoryKind): number {
        // A loop, not filter/reduce: this runs on every admission check (each tile, route set and uniform slot), and the array it
        // built, with a kind list per cache, was garbage made per reservation.
        let used = 0;
        for (const other of this.caches.values()) {
            const { registration } = other;
            if (registration.paneId !== paneId || registration.pool !== pool || other.activity.hiddenAt !== null) continue;
            const counted = kind === 'surface' ? registration.kind === 'surface'
                : kind === 'surface-scratch' ? registration.kind === 'surface-scratch'
                // The 2D compositor's working set and the GPU layer caches are counted apart: a resize bridges through a
                // detached 2D picture while the kept GPU caches stay charged, and one shared limit refused every bridge
                // image forever (measured: 3,484 refusals, no frame after a PDF's quality returned to 1).
                : kind === 'canvas-working' ? registration.kind === 'canvas-working'
                : !PANE_APART_KINDS.has(registration.kind);
            if (counted) used += other.bytes;
        }
        return used;
    }

    /** A pane's GPU layer caches above its grant give back what they can rebuild, off view first, now: a grant that shrank
     * (or a spare that was never granted) must not wait for a refusal, which the layer's own cache never raises. */
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

    /** A refused CPU reservation inside a pane asks the pane's own owners to give back what they can rebuild: the owner
     * decides what that is (a layer drops session bitmaps its view cannot draw). Borrowed or live residency is never asked. */
    private reclaimPane(cache: CacheRecord, bytes: number): void {
        const { paneId, pool, kind } = cache.registration;
        const grant = paneId === undefined ? undefined : this.grants.get(paneId);
        if (paneId === undefined || !grant || this.trimming) return;
        // GPU too: a pane at its own GPU grant with the pool 83% full refused the board's tiles on every frame while the
        // pane's page tiles held 19 MB, and nothing reclaimed (measured: an annotated PDF never presented after a drag).
        // Only the pane's layer caches compete there; its surface, working set and live input are counted apart.
        if (pool === 'gpu' && ['surface', 'program', 'context', 'live-input', 'canvas-working', 'surface-scratch'].includes(kind)) return;
        let excess = this.paneUsed(paneId, pool, kind) + bytes - (pool === 'gpu' ? grant.gpuCacheBytes : grant.cpuBytes);
        if (excess <= 0) return;
        const candidates = [...this.caches.values()].filter(other => other.registration.paneId === paneId &&
            other.registration.pool === pool && other.bytes > 0 && other.activity.hiddenAt === null &&
            RECLAIMABLE.includes(other.registration.class) &&
            // A GPU layer evicted whole cannot be the one asking: it would release the residency it is growing.
            (pool === 'cpu' || other !== cache) &&
            !['surface', 'program', 'context', 'mirror', 'mirror-retiring', 'live-input', 'canvas-working', 'surface-scratch'].includes(other.registration.kind))
            // A live stroke's CPU request reclaims its own layer's idle geometry first (the route's chunks the stroke no longer
            // draws): that is what a new stroke needs back, and the pane's other caches are only asked for what it leaves.
            .sort((a, b) => (pool === 'cpu' && cache.registration.liveInput ? (a === cache ? 0 : 1) - (b === cache ? 0 : 1) : 0) ||
                RECLAIMABLE.indexOf(a.registration.class) - RECLAIMABLE.indexOf(b.registration.class) ||
                // The pane's largest holder first (t21): a board holding 32.2 of its pane's 41.3 MB was asked after the smaller caches.
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

    /** Asks one cache for up to `bytes` and returns the bytes it freed: the larger of what it reports and what its reservation
     * drops synchronously. A void return is 0, so no ask is ever counted as freed (it was, for a cache that freed nothing: a
     * context revoke with no hidden pane counted 4 MB on every trim and never reached the tiles). An owner whose release is
     * asynchronous reports the bytes it released, as the mirror set does with its retiring entries. */
    private evictCache(cache: CacheRecord, bytes: number): number {
        const before = cache.bytes;
        const returned = cache.registration.evict(bytes);
        // Never assumed: a void return is 0 here, so a trim that asked for bytes is not credited with them. What the owner
        // reports (an asynchronous release) and what its reservation drops now are the only freed bytes.
        const reported = typeof returned === 'number' && Number.isFinite(returned) ? Math.max(0, returned) : 0;
        return Math.max(before - cache.bytes, reported);
    }

    /** One refusal episode degrades the governor once; the retries of that episode only wait for capacity. */
    private refuseReservation(pool: MemoryPool): void {
        if (this.refusing[pool]) return;
        this.refusing[pool] = true;
        this.lastTrouble = 'allocation';
        if (this.levelJustRaised()) this.recordFailedLevel();
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
        // A closed cache's unaccounted charge goes with its last lease. A live one keeps it: the owner may still hold the bytes
        // (a publication that lags its release), and reconcileUnaccounted drops the charge when they fall. Dropping it here made
        // the charge return on every release and come back on the next read, while the owner still held the bytes.
        if (cache.closed && !cache.leaseCount && cache.unaccounted > 0) {
            cache.bytes -= cache.unaccounted;
            this.charged[pool] -= cache.unaccounted;
            cache.unaccounted = 0;
        }
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

    /** A cache of a pane that is not on screen, other than what such a pane may keep (HIDDEN_KEPT_KINDS). The pane's demand says
     * whether it is visible: the platform's own per-pane caches (2D canvases, surfaces, GPU services) carry no hiddenAt of their own. */
    private hiddenPaneCache(cache: CacheRecord): boolean {
        const { paneId, kind } = cache.registration;
        if (paneId === undefined || HIDDEN_KEPT_KINDS.has(kind)) return false;
        const pane = this.paneById.get(paneId);
        return pane ? !pane.visible : cache.activity.hiddenAt !== null;
    }

    /** A pane that leaves the screen gives back everything it holds, at once, in both pools: the platform hides its layers first
     * (each releases its GPU work and, the board, the session tiles it charged), then every cache of the pane is asked for all it has.
     * A hidden pane draws nothing, so nothing it holds is worth a visible pane's floor. Before, hidden boards kept their session tiles:
     * the CPU target counts only visible floors, the owners refused to evict tiles their (hidden) view could draw, and seven hidden tabs
     * held 32.1 of the 33.6 MB CPU pool, so every board shown after them stayed on 'Waiting for memory' at quality 0.5 for good.
     * Counted: what was given back (`hidden-release:<pool>`), and what a CPU cache still holds right after the ask
     * (`hidden-kept:cpu:<id>`): a frame a draw still borrows goes a moment later (measured: a PDF's ink layer kept 128 KiB at hide
     * and held 0 once its frame retired), so the invariant is checked at rest, in caches().hiddenPanes, not by this count. */
    private releaseHiddenPane(paneId: string): void {
        // A hide that comes while a trim runs is deferred, not dropped: dropped, the hidden pane kept its caches until some later
        // pressure reached them. It runs once the trim has returned (a microtask: the trim sections clear the flag in their own
        // finally, a nested one before the outer one is done), and asks only what is still hidden then.
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

    /** Runs the hidden-pane releases deferred by a trim (see releaseHiddenPane); one deferred again is queued again. */
    private releaseDeferredHidden(): void {
        const panes = [...this.hiddenReleaseDeferred];
        this.hiddenReleaseDeferred.clear();
        for (const paneId of panes) this.releaseHiddenPane(paneId);
    }

    /** Render audit only: what panes that are not on screen still hold, per pool (see releaseHiddenPane). */
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
                // Session eviction drops exact pixels, then low levels, without touching model/undo.
                cache.registration.evict(excess);
            }
        } finally { this.trimming = false; }
    }

    /** The trim pressure runs, at most once per growth of the pool (see trimmedAt). Returns whether it failed: it ran out of candidates
     * while the pool is still over its target, the only pressure a degradation answers. A trim aimed below target (the soft trim) that
     * stops short of its aim, but reached the target, has not failed. A skipped trim fails while the pool is over its target: the trim
     * at this charge already found nothing more to give. */
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

    /** Audit only (auditTrimHook): asks every reclaimable cache of the pool to give back all it can, as a pressure trim to zero would.
     * Returns the bytes the caches reported freed; the charge falls as their owners release. */
    trimForAudit(pool: MemoryPool): number {
        const before = this.charged[pool];
        const left = this.trimPool(pool, 0);
        return Math.max(0, before - left);
    }

    /** Evicts from the pool's reclaimable caches until its charge is at `target`. Returns the bytes still over target when
     * every candidate has been asked: 0 when the trim met its target, or when another trim is already running. */
    private trimPool(pool: MemoryPool, target: number): number {
        if (this.trimming) return 0;
        // A hidden pane's caches go first: it draws nothing (releaseHiddenPane asked them for everything at hide; what is left, or was
        // charged since, is taken before any visible pane's residency).
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
                // The owner protects its last visible coverage provider and capture/live-input pins.
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

    /** What a layer reads through its host: a pure mapping of the state fields, so the read allocates nothing. */
    trouble(): LayerTrouble {
        if (this.now - this.slowGpuAt < SLOW_GPU_HOLD_MS) return 'slow-gpu';
        return layerTroubleOf(this.state, this.lastTrouble);
    }

    /** Usage low enough to step quality back up. The GPU is under its trim target: a pane's grant sits there, so a lower ratio
     * never came once degraded (measured: a PDF held at 44 of 64 MB stayed at quality 0.8, so no webgl2 frame was ever sharp).
     * The CPU is under its soft-pressure line, not 0.6: a visible PDF's working set alone is 20-27 MB of the 33.5 MB pool at
     * DPR 2 (measured), so a 0.6 line never came, quality stayed at 0.8, and the editing cover waited for a sharp frame. */
    cool(): boolean {
        return this.charged.gpu < this.target.gpu * POLICY.memoryTrimTargetRatio &&
            this.charged.cpu < this.target.cpu * POLICY.memorySoftPressureRatio;
    }

    /** Whether any quality is below 1: the app's limit or a pane's ceiling. */
    private belowFull(): boolean {
        if (this.qualityLimit < 1) return true;
        for (const value of this.paneCeiling.values()) if (value < 1) return true;
        return false;
    }

    /** At rest with the quality down and the GPU over its cool line, what no frame draws (other scales, rings, prefetch: each owner
     * keeps what its last frame drew) is given back to just under the line, so the quality can rise. Nothing trimmed there before:
     * the pressure trim starts above the soft line, and a pool left a hair over the cool line by it held a WebGL2 PDF with a large
     * picture at 0.8, 'Updating', with no advance for 46 s (measured: 215.0 MB against a 214.7 MB line). Asked once per charge:
     * the releases it causes advance again (onPressureChange), and a charge that does not move asks nothing more. */
    private recoverRoom(): void {
        if (this.trimming || !this.recoveryDue()) return;
        const line = Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio);
        this.recoveryTrimmedAt = this.charged.gpu;
        this.madeRoom = true;
        const before = this.charged.gpu;
        this.trimPool('gpu', line - 1);
        auditCount('governor', 'recovery-trim:gpu', 1, { bytes: Math.max(0, before - this.charged.gpu) });
    }

    /** A recovery trim is owed: quality down, the GPU between its cool and soft lines, at a charge not yet asked about. */
    private recoveryDue(): boolean {
        const charged = this.charged.gpu;
        return this.belowFull() && charged >= Math.floor(this.target.gpu * POLICY.memoryTrimTargetRatio)
            && charged <= this.target.gpu * POLICY.memorySoftPressureRatio && charged !== this.recoveryTrimmedAt;
    }

    /** The cool window a raise waits for: short when the governor made the room itself (see memoryMadeRoomRecoveryDelayMs). */
    private recoveryDelay(): number {
        return this.madeRoom && this.belowFull() ? POLICY.memoryMadeRoomRecoveryDelayMs : POLICY.memoryRecoveryDelayMs;
    }

    /** A shortage soon after the quality rose to this level is the level failing; one at a level long held is a budget step. */
    private levelJustRaised(): boolean {
        return this.now - this.raisedAt < POLICY.qualityFailureResetMs;
    }

    /** The level being left failed under trouble: a raise back to it waits out the back-off, which doubles on repeat failures of
     * the same level. Only trouble records a failure, not a budget step: a budget step is not evidence the level cannot work. */
    private recordFailedLevel(): void {
        if (this.failedQuality === this.qualityLimit) this.failureBackoffMs = Math.min(this.failureBackoffMs * 2, POLICY.qualityFailureBackoffMaxMs);
        else { this.failedQuality = this.qualityLimit; this.failureBackoffMs = POLICY.qualityFailureBackoffMinMs; }
        this.failedUntil = this.now + this.failureBackoffMs;
    }

    /** True while the next level up is the failed one and its back-off has not passed. */
    private raiseRefused(now: number): boolean {
        return this.failedQuality !== null && now < this.failedUntil &&
            Math.min(1, this.qualityLimit / POLICY.qualityReductionFactor) >= this.failedQuality;
    }

    /** A visibility resume rebuilds the presented picture at once; that rebuild's charge is not pressure for a short hold. */
    holdPressure(now: number): void {
        this.pressureHoldUntil = Math.max(this.pressureHoldUntil, now + POLICY.resumePressureHoldMs);
    }

    /** Every pressure signal lands here, so one settle window takes one quality step: each pane of a return can report its own
     * capability failure in the same tick, and a step per report stacked them (measured: two steps, 1.0 -> 0.8 -> 0.64, in one tick). */
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
        // A ceiling falls only when the pool granted less than the pane asked for at its ceiling. The pixels it asks for are rounded
        // down, so the grant of a full ask is a few pixels under the ceiling's square: taken as a shortfall, every plan at 0.8 set the
        // ceiling to 0.79999..., the recovery raised it to 0.99999... (not 1), and the pane stayed "below full" for good. Measured,
        // three dense panes on WebGL2 after divider drags: ceilings 0.9999976/0.9999966/0.9999940 at quality 1, "Rendering quality was
        // reduced" on all three and a recovery trim each time the GPU charge moved (586 per 10 s at rest), each evicting tiles the
        // boards composed again.
        for (const pane of visible) {
            const granted = pixelGrantOf(pane.paneId);
            if (granted >= Math.floor(pane.requestedPixels * ceilingOf(pane) * ceilingOf(pane))) continue;
            const q = Math.sqrt(granted / pane.requestedPixels);
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
