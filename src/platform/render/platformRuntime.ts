import { getTerminalContextActive, subscribeTerminalContext } from '../../utils/terminalContext';
import { RENDER_CONSTANTS as POLICY } from './constants';
import { MemoryGovernor } from './memoryGovernor';
import type { PaneMemoryDemand, MemoryTrouble } from './memoryGovernor';
import { PaneLifecycleHost } from './paneLifecycle';
import { defaultUploadAllowance, FrameScheduler } from './scheduler';
import { surfaceBroker } from './surfaceBroker';

export interface RuntimePane {
    demand(): PaneMemoryDemand;
    interacting(): boolean;
    notice(message: 'memory-pressure'): void;
    error(error: unknown): void;
}

/** Private app-lifetime services. Creating a session mirror does not start a view or listeners. */
export class PlatformRuntime {
    readonly governor = new MemoryGovernor((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
    readonly lifecycles: PaneLifecycleHost;
    readonly scheduler: FrameScheduler;
    private readonly panes = new Map<string, RuntimePane>();
    private bandwidth: number | undefined;
    private started = false;
    private readonly slowGpu = new Set<string>();
    private readonly stalledFence = new Set<string>();
    private motion: MediaQueryList | null = null;

    constructor() {
        const context = this.governor.register({
            id: 'platform:native-contexts', pool: 'gpu', kind: 'context', class: 'scene-cache',
            hiddenAt: null, lastVisibleAt: 0, lastUsedAt: 0,
            memory: () => ({ live: surfaceBroker.contextBudget.platform * POLICY.keptContextReserveBytes, retiring: 0 }),
            evict: bytes => { surfaceBroker.revokeHiddenContexts(Math.ceil(bytes / POLICY.keptContextReserveBytes)); },
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
            windowVisibility: visible => this.lifecycles.windowVisibility(visible),
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
            this.refresh();
        };
    }

    refresh(): void {
        this.governor.updatePanes([...this.panes.values()].map(pane => pane.demand()));
        this.advance();
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

    private advance(): void {
        this.lifecycles.advancePressure(performance.now(), [...this.panes.values()].some(pane => pane.interacting()));
    }
}

let runtime: PlatformRuntime | null = null;

/** Only lazy engine/pane code calls this. Importing the module does not initialize the platform. */
export function getPlatformRuntime(): PlatformRuntime { return runtime ??= new PlatformRuntime(); }
