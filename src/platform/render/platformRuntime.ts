import { renderAuditEnabled } from './renderAudit';
import { getTerminalContextActive, subscribeTerminalContext } from '../terminalContext';
import { RENDER_CONSTANTS as POLICY } from './constants';
import { MemoryGovernor } from './memoryGovernor';
import type { PaneMemoryDemand, MemoryTrouble } from './memoryGovernor';
import { PaneLifecycleHost } from './paneLifecycle';
import { defaultUploadAllowance, FrameScheduler } from './scheduler';
import { surfaceBroker } from './surfaceBroker';

export interface RuntimePane {
    demand(): PaneMemoryDemand;
    interacting(): boolean;
    windowVisibility?(visible: boolean): void;
    notice(message: 'memory-pressure' | 'cpu-floor-denied'): void;
    error(error: unknown): void;
}

/** Whether two demand lists plan the same: the same panes in the same order, each with the same fields the governor reads.
 * A NaN field compares unequal, which only ever means one extra plan. */
function sameDemands(a: readonly PaneMemoryDemand[], b: readonly PaneMemoryDemand[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        // Every field the governor plans from (samePaneDemand): a demand that moved only its pinned bytes or its DPR was dropped here.
        if (x.paneId !== y.paneId || x.visible !== y.visible || x.focused !== y.focused || x.requestedPixels !== y.requestedPixels ||
            x.devicePixelRatio !== y.devicePixelRatio || x.gpuPinnedBytes !== y.gpuPinnedBytes || x.gpuNeedBytes !== y.gpuNeedBytes || x.cpuNeedBytes !== y.cpuNeedBytes || x.cpuMandatoryBytes !== y.cpuMandatoryBytes ||
            x.cpuPinned !== y.cpuPinned) return false;
    }
    return true;
}

/** Private app-lifetime services. Creating a session mirror does not start a view or listeners. */
export class PlatformRuntime {
    readonly governor = new MemoryGovernor((navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        () => this.queueMemoryAdvance());
    readonly lifecycles: PaneLifecycleHost;
    readonly scheduler: FrameScheduler;
    private readonly panes = new Map<string, RuntimePane>();
    private bandwidth: number | undefined;
    private started = false;
    private readonly slowGpu = new Set<string>();
    private readonly stalledFence = new Set<string>();
    private readonly capabilityFailures = new Map<string, number>();
    private readonly deniedCpuFloor = new Set<string>();
    private memoryAdvanceQueued = false;
    private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private recoveryAt: number | null = null;
    private motion: MediaQueryList | null = null;
    /** The inputs of the last plan: every pane's demand as it was planned, and the live-gesture flag. Null until the first plan. */
    private planned: { demands: readonly PaneMemoryDemand[]; liveGesture: boolean } | null = null;

    constructor() {
        const context = this.governor.register({
            id: 'platform:native-contexts', pool: 'gpu', kind: 'context', class: 'scene-cache',
            hiddenAt: null, lastVisibleAt: 0, lastUsedAt: 0,
            memory: () => ({ live: surfaceBroker.contextBudget.platform * POLICY.keptContextReserveBytes, retiring: 0 }),
            // Returns the bytes it revoked, not nothing: a void return is counted by the governor as the whole ask, so a trim
            // with no hidden context to revoke claimed 4 MB freed on every pass (36 passes, 149 MB) and never reached the tiles.
            evict: bytes => surfaceBroker.revokeHiddenContexts(Math.ceil(bytes / POLICY.keptContextReserveBytes)) * POLICY.keptContextReserveBytes,
        });
        surfaceBroker.configure({ contextAllocator: context });
        surfaceBroker.setTerminalContextActive(getTerminalContextActive());
        subscribeTerminalContext(active => surfaceBroker.setTerminalContextActive(active));
        this.lifecycles = new PaneLifecycleHost(this.governor, () => {
            const panes = [...this.panes.values()];
            const pane = panes.find(pane => { const demand = pane.demand(); return demand.visible && demand.focused; }) ??
                panes.find(pane => pane.demand().visible) ?? panes[0];
            pane?.notice('memory-pressure');
        });
        this.scheduler = new FrameScheduler({
            reducedMotion: false,
            uploadAllowance: interval => defaultUploadAllowance(interval, this.bandwidth),
            windowVisibility: visible => {
                this.lifecycles.windowVisibility(visible);
                for (const pane of this.panes.values()) pane.windowVisibility?.(visible);
            },
            releaseRetained: reason => this.lifecycles.releaseRetained(reason),
            onPressure: pressure => {
                if (pressure.uploadMeasurementsComplete && pressure.reportedUploadBytes > 0 && pressure.uploadCallMs > 0) {
                    this.bandwidth = pressure.reportedUploadBytes / pressure.uploadCallMs;
                }
                this.advance();
            },
            onError: (paneId, error) => {
                const pane = paneId === null ? undefined : this.panes.get(paneId);
                if (pane) pane.error(error);
                else console.error('Rendering platform:', error);
            },
        });
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.motion = matchMedia('(prefers-reduced-motion: reduce)');
        this.scheduler.setReducedMotion(this.motion.matches);
        this.motion.addEventListener('change', event => this.scheduler.setReducedMotion(event.matches));
        this.scheduler.start();
    }

    add(paneId: string, pane: RuntimePane): () => void {
        if (this.panes.has(paneId)) throw new Error('A platform pane is already attached');
        this.panes.set(paneId, pane);
        try { this.refresh(); }
        catch (error) { this.panes.delete(paneId); throw error; }
        return () => {
            if (this.panes.get(paneId) !== pane) return;
            this.panes.delete(paneId);
            this.slowGpu.delete(paneId);
            this.stalledFence.delete(paneId);
            this.capabilityFailures.delete(paneId);
            this.deniedCpuFloor.delete(paneId);
            this.refresh();
        };
    }

    /** Re-plans only when a plan input changed: the pane set, any pane's demand (visibility, focus, viewport, needs) or whether
     * a live gesture is running. Grants are the plan's output, not an input, so they are not compared. The demands themselves are
     * still read from each pane, because only the pane knows whether they moved; an unchanged refresh then costs no governor
     * plan and no budget pass. Checked by reading: advance's time-based progress runs from its recovery timer, and a live gesture
     * is compared here because it is an input to advancePressure. Not measured (no runs). */
    refresh(): void {
        const demands: PaneMemoryDemand[] = [];
        let liveGesture = false;
        for (const pane of this.panes.values()) {
            demands.push(pane.demand());
            if (!liveGesture && pane.interacting()) liveGesture = true;
        }
        const planned = this.planned;
        const changed = planned === null || planned.liveGesture !== liveGesture || !sameDemands(planned.demands, demands);
        if (changed) {
            this.governor.updatePanes(demands);
            this.planned = { demands, liveGesture };
        }
        for (const demand of demands) {
            const denied = demand.visible && (this.governor.grant(demand.paneId)?.cpuBytes ?? 0) < (demand.cpuMandatoryBytes ?? 0);
            if (denied && !this.deniedCpuFloor.has(demand.paneId)) {
                this.deniedCpuFloor.add(demand.paneId);
                this.panes.get(demand.paneId)?.notice('cpu-floor-denied');
            } else if (!denied) this.deniedCpuFloor.delete(demand.paneId);
        }
        if (changed) this.advance();
    }

    trouble(reason: MemoryTrouble): void {
        this.governor.signalTrouble(reason);
        // Governor eviction chooses actual reclaimable caches. Do not abandon every visible
        // context merely because one allocation failed; that also destroys the retained frame.
        this.advance();
    }

    /** Real GPU timer samples only; disjoint intervals cannot establish either recovery or trouble. */
    observeGpuTiming(paneId: string, p95Ms: number, intervalMs: number, samples: number, disjoint: boolean): void {
        if (disjoint) return;
        if (!Number.isFinite(p95Ms) || p95Ms < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0 ||
            !Number.isSafeInteger(samples) || samples < 0) throw new RangeError('Invalid GPU timing sample');
        if (samples < POLICY.slowGpuSampleCount) return;
        const slow = p95Ms > intervalMs;
        if (slow && !this.slowGpu.has(paneId)) {
            this.slowGpu.add(paneId);
            this.governor.observeGpuTiming(p95Ms, intervalMs, samples, false);
            this.advance();
        } else if (!slow) this.slowGpu.delete(paneId);
    }

    /** One unsupported device is a normal fallback; repeated qualification failures are pressure evidence. */
    observeCapabilityFailure(paneId: string): void {
        if (!this.panes.has(paneId)) return;
        const previous = this.capabilityFailures.get(paneId) ?? 0;
        const failures = Math.min(2, previous + 1);
        this.capabilityFailures.set(paneId, failures);
        if (previous < 2 && failures === 2) this.trouble('capability');
    }

    clearCapabilityFailure(paneId: string): void { this.capabilityFailures.delete(paneId); }

    /** A retired device cannot keep a symptom latched across its replacement generation. */
    clearDeviceTrouble(paneId: string): void {
        this.slowGpu.delete(paneId);
        this.stalledFence.delete(paneId);
    }

    /** Only the backend's oldest genuinely unsignalled fence and host input health qualify. */
    observeFence(paneId: string, oldestPendingMs: number, mainThreadInputHealthy: boolean): void {
        if (!Number.isFinite(oldestPendingMs) || oldestPendingMs < 0) throw new RangeError('Invalid pending fence age');
        const stalled = mainThreadInputHealthy && oldestPendingMs > POLICY.stalledFenceMs;
        if (stalled && !this.stalledFence.has(paneId)) {
            this.stalledFence.add(paneId);
            this.governor.observeFence(oldestPendingMs, true);
            this.advance();
        } else if (!stalled) this.stalledFence.delete(paneId);
    }

    private queueMemoryAdvance(): void {
        if (this.memoryAdvanceQueued) return;
        this.memoryAdvanceQueued = true;
        queueMicrotask(() => {
            this.memoryAdvanceQueued = false;
            this.advance();
        });
    }

    private advance(): void {
        this.lifecycles.advancePressure(performance.now(), [...this.panes.values()].some(pane => pane.interacting()));
        // The governor says when it next needs an advance that no event will bring (a deferred degrade, a recovery's held
        // window). Only that deadline is armed: nothing polls while the memory is idle.
        const at = this.governor.wakeAt();
        if (at === null) {
            if (this.recoveryTimer !== null) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
            this.recoveryAt = null;
        } else if (this.recoveryAt !== at) {
            if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
            this.recoveryAt = at;
            this.recoveryTimer = setTimeout(() => {
                this.recoveryTimer = null;
                this.recoveryAt = null;
                this.advance();
            }, Math.max(0, at - performance.now()));
        }
    }
}

let runtime: PlatformRuntime | null = null;

/** Only lazy engine/pane code calls this. Importing the module does not initialize the platform. */
export function getPlatformRuntime(): PlatformRuntime {
    if (!runtime) {
        runtime = new PlatformRuntime();
        const created = runtime;
        // Audit only: the measured inventory reads memory beside its counters (renderAudit.ts).
        if (renderAuditEnabled() && typeof window !== 'undefined') {
            const audit = (window as unknown as { __bmeRenderAudit?: Record<string, unknown> }).__bmeRenderAudit;
            if (audit) { audit.memory = () => created.governor.readout(); audit.caches = () => created.governor.auditCaches(); audit.degrade = () => created.trouble('slow-gpu'); }
        }
    }
    return runtime;
}
