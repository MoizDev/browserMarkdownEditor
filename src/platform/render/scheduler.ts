import { auditCount, auditFrame, auditTape, auditTapeStart, renderAuditEnabled } from './renderAudit';
import type { Camera, Viewport, ViewState } from '../types';
import { cameraAtAnchor, surfaceToWorld } from './camera';
import type { CameraAnchor, CameraController, Point } from './camera';
import { RENDER_CONSTANTS } from './constants';
import { DamageAccumulator } from './damage';
import { forgetPaneMotion, recordPaneMotion } from './paneMotion';
import type { DamageRecord } from './damage';
import type { SurfaceCommit, SurfaceMetricsCommitter } from './surfaceMetrics';
import type { BudgetPhase, FrameBudget, FrameToken, Layer } from './types';
const benchmarkPerf = __BME_BENCH__ ? await import('./renderPerf') : null;

/** Accumulated CSS camera-pan positions, not raw finger positions (design §7.3:706–713). */
export interface TouchPanSample extends Point { readonly time: number }

/** Metadata comes from the compositor, not a second scene graph (design §7.1:685–687). */
export interface ScheduledLayerSnapshot {
    readonly layer: Layer;
    readonly sceneRevision: number;
    readonly critical: boolean;
}

/** One frozen geometry/content snapshot shared by preparation, encoding and overlays (§7.1:683–688). */
export interface ScheduledFrame {
    readonly frameId: number;
    readonly timestamp: number;
    readonly intervalMs: number;
    readonly token: FrameToken;
    readonly view: ViewState;
    readonly layers: readonly ScheduledLayerSnapshot[];
    readonly reasons: readonly string[];
    readonly damage: DamageRecord;
}

/** The revision actually drawn, not merely prepared (contracts.md C4.3:538–542). */
export interface PresentedLayerRevision {
    readonly layer: Layer;
    readonly sceneRevision: number;
}

/** Completion is a nonblocking predicate supplied by the compositor/backend (design:424). */
export interface ScheduledSubmission {
    readonly drawn: readonly PresentedLayerRevision[];
    readonly completed?: () => boolean;
    /** True once the submission can never complete (its context was released, or the compositor was disposed). Its acknowledgement
     * is dropped: the layers are not told it presented, and no frame is kept requested for a submission that is gone. */
    readonly superseded?: () => boolean;
    /** Benchmark observation is committed only after this exact display and its overlays agree. */
    readonly commitObservation?: () => void;
    readonly cancelObservation?: () => void;
}

/** Encoding/submission belong to the compositor; abort cleanup must not publish pixels (§7.1:687–688).
 * A late budget miss may decline with null; its previous picture/DOM transform then remain together.
 */
export interface ScheduledEncoding {
    submit(): ScheduledSubmission | null;
    discard(): void;
}

/** Only visible views register; all callbacks use reported values, never frame-time DOM geometry. */
export interface ScheduledPane {
    /** Stable broker/view identity, never a vault path (contracts.md C7.0:839–845). */
    readonly paneId: string;
    readonly camera: CameraController;
    readonly layers: readonly Layer[];
    readonly metrics: SurfaceMetricsCommitter;
    readonly focused: boolean;
    currentToken(): FrameToken | null;
    commitMetrics(frameId: number): SurfaceCommit | null;
    resizeAnchor?(): CameraAnchor | undefined;
    consumeInput(timestamp: number): void;
    isInteracting(): boolean;
    /** O(1) authoritative snapshot, before prior-frame acknowledgements; never scan/rebuild the scene. */
    snapshotScene(view: ViewState): void;
    sceneRevision(layer: Layer): number;
    /** Immediate critical preparation, not "a worker is pending"; becomes false when that work drains. */
    isCritical(layer: Layer, view: ViewState): boolean;
    /** The audit's name for a layer in `present:needsFrame:<id>`; without it the layer's position in `layers` names it. */
    layerId?(layer: Layer): string;
    /** Platform target/ring admission once per frame, before any layer prepares; never draws. */
    prepareFrame(frame: ScheduledFrame, budget: FrameBudget): void;
    /** The largest single upload one frame's progress grant must admit for this pane (PaneCompositor.progressUploadBytes). */
    progressUploadBytes?(): number;
    finishPrepareFrame?(frame: ScheduledFrame, budget: FrameBudget): void;
    /** `changed`: a layer's preparation reported a change this frame, or could not prove none (drawnChange, a full repaint, or a layer
     * not visited). The scene revisions cannot say that: an adapter can promote a newer picture under the same revision. */
    encode(frame: ScheduledFrame, changed: boolean): ScheduledEncoding | null;
    /** A frame skipped because every layer answered unchanged is presented without encode or submit: the picture on screen is the
     * one it would draw. Returns true when the pane reported that presentation (the same observers and report a present gives);
     * false when the picture cannot be vouched for (token, revision, camera, geometry or backend moved), and the frame is encoded. */
    presentUnchanged(frame: ScheduledFrame): boolean;
    /** The offscreen work of a frame presentUnchanged accepted (see PaneCompositor.encodeOffscreen); null when there is none. */
    encodeOffscreen?(frame: ScheduledFrame): ScheduledEncoding | null;
    writeOverlays(frame: ScheduledFrame): void;
    /** Read-only benchmark snapshot; never queried in production or development. */
    benchmarkMemory?(): { memory: Readonly<Record<string, number>>; grants: Readonly<Record<string, number>> };
    /** Offered an error thrown by this pane's work before the scheduler gives up on the pane. Returns true when the pane
     * handled it (a GPU failure demoted to canvas2d): the frame then goes on without that pane's remaining work. */
    recover?(error: unknown): boolean;
    /** Stop input/speculative work and synchronously checkpoint through the session, never await a frame. */
    suspend(reason: 'unregistered' | 'window-hidden' | 'frozen' | 'geometry-dormant' | 'stopped'): void;
}

/** Bound to one registration, so stale async arrivals/cleanup cannot target a replacement view. */
export interface ScheduledPaneLease {
    invalidate(reason: string, damage?: DamageRecord): void;
    setFocused(focused: boolean): void;
    /** Monotonic performance.now/rAF milliseconds; null cancels only this layer's pending deadline. */
    wakeAt(layer: Layer, deadlineMs: number | null): void;
    startFling(samples: readonly TouchPanSample[]): void;
    animateZoom(targetZ: number, anchor?: Point): void;
    /** A camera glide by a screen-space delta, eased over durationMs; a zero duration or reduced motion jumps. */
    animatePan(delta: Point, durationMs: number): void;
    /** A camera glide to `target`, pan and zoom together, eased over durationMs; a zero duration or reduced motion jumps. */
    glideTo(target: Camera, durationMs: number): void;
    cancelMotion(): void;
    dispose(): void;
}

/** Runtime admission feedback for lowering optional work/quality, not a verification hook (§7.1:677–690). */
export interface FramePressure {
    readonly frameId: number;
    readonly targetMs: number;
    readonly elapsedMs: number;
    readonly prepareOvershootMs: number;
    readonly admittedUploadBytes: number;
    readonly uploadByteAllowance: number;
    readonly uploadByteOvershoot: number;
    readonly reportedUploadBytes: number;
    readonly reportedUploadCalls: number;
    readonly uploadCallMs: number;
    readonly uploadTimeAllowanceMs: number;
    readonly uploadTimeOvershootMs: number;
    readonly uploadMeasurementsComplete: boolean;
}

interface FlingMotion {
    kind: 'fling';
    lastTime: number;
    velocity: Point;
}

interface ZoomMotion {
    kind: 'zoom';
    startedAt: number;
    startZ: number;
    targetZ: number;
    world: Point;
    anchor: Point | null;
    lastViewport: Readonly<Viewport>;
    lastZ: number;
}

interface GlideMotion {
    kind: 'glide';
    startedAt: number;
    durationMs: number;
    from: Camera;
    to: Camera;
}

type Motion = FlingMotion | ZoomMotion | GlideMotion;

function finitePoint(point: Point): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y); }

/** Least-squares release velocity over 80 ms, magnitude cap preserving direction (§7.3:706).
 * Samples remain the input owner's truth; this only fits a camera animation, never ink geometry.
 */
function releaseVelocity(samples: readonly TouchPanSample[]): { velocity: Point; time: number } | null {
    let end = -Infinity;
    for (const sample of samples) {
        if (!finitePoint(sample) || !Number.isFinite(sample.time) || sample.time < 0) {
            throw new RangeError('Pan samples must have finite positions and nonnegative timestamps');
        }
        end = Math.max(end, sample.time);
    }
    const recent = samples.filter(sample => sample.time >= end - 80);
    if (recent.length < 2) return null;
    const base = recent[0];
    let meanTime = 0;
    let meanX = 0;
    let meanY = 0;
    for (const sample of recent) {
        meanTime += (sample.time - end) / 1000;
        meanX += sample.x - base.x;
        meanY += sample.y - base.y;
    }
    meanTime /= recent.length;
    meanX /= recent.length;
    meanY /= recent.length;
    let variance = 0;
    let covarianceX = 0;
    let covarianceY = 0;
    for (const sample of recent) {
        const time = (sample.time - end) / 1000 - meanTime;
        variance += time * time;
        covarianceX += time * (sample.x - base.x - meanX);
        covarianceY += time * (sample.y - base.y - meanY);
    }
    if (variance === 0) return null;
    let velocity = { x: covarianceX / variance, y: covarianceY / variance };
    const speed = Math.hypot(velocity.x, velocity.y);
    if (!Number.isFinite(speed)) throw new RangeError('Pan velocity exceeds finite coordinates');
    if (speed <= 80) return null;
    if (speed > 8000) {
        const factor = 8000 / speed;
        velocity = { x: velocity.x * factor, y: velocity.y * factor };
    }
    return { velocity, time: end };
}

/** Upload policy is injected; the backend supplies measured bandwidth, never a startup benchmark (§5.6). */
export interface FrameSchedulerOptions {
    readonly reducedMotion: boolean;
    uploadAllowance(intervalMs: number): number;
    windowVisibility(visible: boolean, persisted: boolean): void;
    releaseRetained(reason: 'pressure' | 'freeze' | 'hidden-timeout'): void;
    onPressure(pressure: FramePressure): void;
    onError(paneId: string | null, error: unknown): void;
}

// vr-lead: the printed 4.17–33.33ms bounds mean EXACT 240–30Hz, for clamp and classification.
// Do not invent jitter slack; a real vsync sample outside this range is a consumer-run finding.
const minIntervalMs = 1000 / 240;
const maxIntervalMs = 1000 / 30;
const initialIntervalMs = 16.67;
const frameGapMs = 250;
/** Share of the frame target preparation always gets, however long the last presentation took. */
const PREPARE_FLOOR_FRACTION = 0.25;
/** A quiet frame's background window, as a fraction of the interval (see the background pass). */
const QUIET_BACKGROUND_FRACTION = 0.5;
/** Submitted frames of one pane that may still be unfinished on the GPU. A frame past the limit waits (its prepare still ran, its damage
 * stays pending) until the oldest one completes, so the picture on screen is never more than this many frames behind the input.
 * Measured: the GPU ran up to five or six frames behind the CPU on a notebook zoom, and each queued frame is input latency. */
const FRAMES_IN_FLIGHT = 3;
/** Audit only: an input's latency, counted in 17 ms buckets (inputs of the same bucket sum into one counter) with its total. */
function recordInputLatency(stage: 'submit' | 'complete', ms: number): void {
    if (!renderAuditEnabled() || !Number.isFinite(ms)) return;
    auditCount('input', `${stage}:n`);
    auditCount('input', `${stage}:ms-sum`, Math.round(ms));
    auditCount('input', `${stage}:bucket`, 1, { [String(Math.min(12, Math.floor(ms / 17)))]: 1 });
}
const progressTileBytes = (RENDER_CONSTANTS.tileInteriorPixels + 2 * RENDER_CONSTANTS.tileGutterTexels) ** 2 * RENDER_CONSTANTS.decodedRgbaBytesPerPixel;
/** The progress grant admits one real tile per frame, and a layer's gutter may be wider than the platform's one-texel
 * minimum: the board's tiles are 516² (2-texel gutters), 8,240 bytes over the 514² tile, so on the GPU backend every
 * board, paper and wet tile was refused forever and the pane never presented (measured: 284 of 284 claims refused). */
const PROGRESS_GUTTER_TEXELS = 4;
const progressUploadBytes = (RENDER_CONSTANTS.tileInteriorPixels + 2 * PROGRESS_GUTTER_TEXELS) ** 2 * RENDER_CONSTANTS.decodedRgbaBytesPerPixel;
/** Uniform-ring and other small mandatory writes land before optional preparation; 48 such bytes already in a frame
 * must not cancel its one-tile progress guarantee (measured: every refused claim followed 48 admitted bytes). */
const PROGRESS_SMALL_BYTES = 64 * 1024;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Ordinary cap, including the one-tile warmup; oversize progress is accounted separately (§5.6:549–555). */
export function defaultUploadAllowance(intervalMs: number, measuredBytesPerMs?: number): number {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('Frame interval must be finite and positive');
    const mib = 2 ** 20;
    const cap = clamp(240 * mib * intervalMs / 1000, mib, 8 * mib);
    const slice = Math.min(1, 0.12 * intervalMs);
    return Math.floor(Math.min(cap, measuredBytesPerMs !== undefined && Number.isFinite(measuredBytesPerMs) && measuredBytesPerMs > 0
        ? 0.7 * measuredBytesPerMs * slice : progressTileBytes));
}

interface PaneEntry {
    pane: ScheduledPane;
    layers: readonly Layer[];
    reasons: Set<string>;
    wakes: Map<Layer, number>;
    focused: boolean;
    inputPriority: boolean;
    renderable: boolean;
    dormantNotified: boolean;
    optionalBytes: number;
    /** Measured cost of this pane's encode, submit and overlays per frame (EWMA, ms). The frame's preparation budget is the
     * display interval less these, so foreground work never takes the time the pane needs to present. */
    presentMs: number;
    /** Submitted frames the GPU may not have finished; pruned on every frame (completed or superseded ones leave). */
    inflight: { submission: ScheduledSubmission; inputAt: number | null }[];
    /** When the earliest input not yet in a submitted frame arrived (audit only; null when the audit is off). */
    pendingInputAt: number | null;
    motion: Motion | null;
    binding: FrameToken | null;
    damage: DamageAccumulator;
    /** The accumulator the last frame's batch held, reset and returned at the frame's end: detach swaps it in instead of a new one. */
    spareDamage: DamageAccumulator | null;
    fullDamage: boolean;
    /** The frame's two-phase foreground answers (FrameWork.foreground), one map for the pane's life, cleared per frame. */
    foregroundAnswers: Map<Layer, boolean>;
    /** The last frame's layer snapshots: reused while every layer's revision and critical flag are the same (most frames). */
    layerSnapshots: readonly ScheduledLayerSnapshot[] | null;
    /** The last presented frame's token, view and geometry: a later frame that changes none of them repaints only if a layer says so. */
    presented: { token: FrameToken; view: ViewState; geometry: number } | null;
    /** The last frame that detached this pane; the layer-driven pass skips a pane already taken by the reason-driven pass. */
    lastFrame: number;
    /** Last scene revisions and their tag string, so an unchanged pane reuses its string (see revisionKey). */
    revisionValues: number[];
    revisionKey: string;
}

const NO_REASONS: readonly string[] = Object.freeze([]);


interface DamageBatch { entry: PaneEntry; damage: DamageAccumulator; full: boolean; submitted: boolean;
    /** The damage as detached, before the frame marked its own drawing damage (set in the work pass; null: none was recorded). */
    pending?: DamageRecord | null;
    /** The frame was skipped as unchanged (its picture is on screen): only `pending` returns to the pane, not the frame's own marks. */
    skipped?: boolean }
/** Optional on a layer: true while its live work (a stroke's GPU runs in flight) must be prepared before the pane's other critical
 * layers. Declared here, not on Layer, so the layer contract stays as it is; a layer without the hook is ordered as before. */
interface PreparingFirst { prepareFirst?(): boolean }
const firstPreparing = (layer: Layer): boolean => (layer as Layer & PreparingFirst).prepareFirst?.() === true;

interface FrameWork { entry: PaneEntry; frame: ScheduledFrame; batch: DamageBatch; geometry: number; hadInput: boolean; platformPrepared: boolean; platformBudget?: FrameBudget;
    /** A layer's preparation was passed over for lack of time while it did not ask for a frame. */
    skipped: boolean;
    /** A layer's prepare reported (or may have) drawn something different, or the frame was granted an upload. */
    drawnChange: boolean;
    /** Layers settled this frame: prepared to completion (whatever it answered), or passed over while settled (see passedOver). */
    settled: number;
    /** Two-phase layers whose foreground call ran this frame, mapped to whether that call answered unchanged. Their background
     * call runs only for these, and the frame's answer is the background call's (plus a foreground 'changed' marks the frame). */
    foreground: Map<Layer, boolean>;
    /** A full repaint is due (see the damage decision in the work pass): this frame must reach the canvas. */
    repaint: boolean;
    /** The audit's name for what asked for this frame; '' when the render audit is off. */
    cause: string }
/** Audit only: the camera each layer last prepared with, so a prepare that skips a camera change is visible in the counters. */
const lastPreparedCamera = new WeakMap<Layer, { x: number; y: number; z: number }>();
const sameCamera = (a: ViewState, b: ViewState): boolean => a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
    && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.viewport.dpr === b.viewport.dpr;
const cameraMoved = (layer: Layer, view: ViewState): boolean => {
    const last = lastPreparedCamera.get(layer);
    return !last || last.x !== view.camera.x || last.y !== view.camera.y || last.z !== view.camera.z;
};
interface PendingAcknowledgement { entry: PaneEntry; frameId: number; token: FrameToken; submission: ScheduledSubmission }
/** A poll is the owner's persistent work; a throwing poll is kept (the owner's cancel handle stays valid) and backs off in time. */
interface ScheduledPoll { callback: () => void; earliestFrame: number; failures: number; retryAt: number }
interface UploadMeter {
    allowance: number;
    sliceMs: number;
    deadline: number;
    admittedBytes: number;
    reportedBytes: number;
    reportedCalls: number;
    callMs: number;
    progressUsed: boolean;
    /** The critical-class layers not yet prepared this frame (see criticalPending); emptied as each one's prepare runs. */
    criticalToRun?: Set<Layer>;
    byPane?: Map<string, { bytes: number; calls: number; ms: number }>;
}

function sameToken(a: FrameToken, b: FrameToken | null): boolean {
    return b !== null && a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
        a.bytesGeneration === b.bytesGeneration && a.session === b.session &&
        a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}

let schedulerStarted = false;
/** A failed frame holds the loop for this back-off before it runs again: doubling from the minimum, capped at the maximum. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
/** The back-off for failing work: doubling from RETRY_MIN_MS, capped at RETRY_MAX_MS. */
function retryDelay(failures: number): number { return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(failures - 1, 5)); }

/** One app-wide rAF owner, explicitly started; importing it installs no listeners (C4.6:624–628).
 * Sanctioned deadline path: wakeAt coalesces future layer work into one timer that ONLY invalidates,
 * never draws or polls needsFrame; there are no rAF callbacks while nothing is due (vr-lead ruling).
 */
export class FrameScheduler {
    private readonly panes = new Map<string, PaneEntry>();
    private readonly polls = new Set<ScheduledPoll>();
    /** Per-frame scratch, cleared at the point each frame fills it: the critical class still to prepare, and each pane's present cost. */
    private readonly criticalToRun = new Set<Layer>();
    private readonly presentCost = new Map<PaneEntry, number>();
    /** Panes that recovered from an error in the frame in progress: their remaining work this frame is not valid. */
    private readonly demoted = new Set<PaneEntry>();
    private readonly sessionDeadlines = new Set<{ deadline: number; callback: () => void }>();
    private acknowledgements: PendingAcknowledgement[] = [];
    private running = false;
    private suspended = false;
    private inFrame = false;
    private raf: number | null = null;
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    private wakeDeadline: number | null = null;
    private wakeEpoch = 0;
    /** Frames in a row that threw outside every pane's callback; a successful frame resets it. */
    private frameFailures = 0;
    /** The back-off timer after a failed frame: while it runs, no frame is requested. */
    private frameHold: ReturnType<typeof setTimeout> | null = null;
    /** Each layer's last prepare answer and the scene revision it was prepared at (see passedOver). */
    private readonly layerAnswers = new WeakMap<Layer, { revision: number; unchanged: boolean }>();
    private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    private hiddenAt: number | null = null;
    private retainedReleased = false;
    private reducedMotion: boolean;
    private frameId = 0;
    private lastTimestamp: number | null = null;
    private intervalMs = initialIntervalMs;
    private intervals: number[] = [];
    private rejectedIntervals: number[] = [];
    private hasEstimate = false;
    private criticalCursor = 0;
    private optionalCursor = 0;
    private encodeCursor = 0;
    private maintenanceMs = 0;
    private meter: UploadMeter | null = null;
    private declare measuredPane: string | null;

    constructor(private readonly options: FrameSchedulerOptions) { this.reducedMotion = options.reducedMotion; }

    start(): void {
        if (this.running) return;
        if (schedulerStarted) throw new Error('Only one frame scheduler may be started');
        schedulerStarted = true;
        this.running = true;
        this.lastTimestamp = null;
        document.addEventListener('visibilitychange', this.visibilityChanged);
        document.addEventListener('freeze', this.frozen);
        window.addEventListener('pageshow', this.pageShown);
        window.addEventListener('pagehide', this.pageHidden);
        if (document.hidden) this.suspendWindow('window-hidden');
        else this.resumeWindow(false);
    }

    /** Detaches scheduling/listeners, not document sessions. Permanent teardown also disposes the broker. */
    stop(): void {
        if (!this.running) return;
        this.running = false;
        schedulerStarted = false;
        this.cancelFrame();
        if (this.frameHold !== null) { clearTimeout(this.frameHold); this.frameHold = null; }
        this.clearWakeTimer();
        this.clearHiddenTimer();
        document.removeEventListener('visibilitychange', this.visibilityChanged);
        document.removeEventListener('freeze', this.frozen);
        window.removeEventListener('pageshow', this.pageShown);
        window.removeEventListener('pagehide', this.pageHidden);
        for (const entry of [...this.panes.values()]) {
            entry.wakes.clear();
            this.cancelMotion(entry);
            if (!this.suspended) this.call(entry, () => entry.pane.suspend('stopped'));
        }
        this.refreshWakeTimer();
    }

    register(pane: ScheduledPane): ScheduledPaneLease {
        if (this.panes.has(pane.paneId)) throw new Error('A visible pane is already registered');
        const entry: PaneEntry = {
            pane, layers: Object.freeze([...pane.layers]), reasons: new Set(['show']), wakes: new Map(), focused: pane.focused,
            inputPriority: false, renderable: false, dormantNotified: false, optionalBytes: 0, presentMs: 0, inflight: [], pendingInputAt: null, motion: null, binding: null,
            damage: new DamageAccumulator(), spareDamage: null, fullDamage: true, foregroundAnswers: new Map(), layerSnapshots: null, presented: null,
            lastFrame: -1, revisionValues: [], revisionKey: '[]',
        };
        this.panes.set(pane.paneId, entry);
        if (this.running && this.suspended) this.call(entry, () => pane.suspend('window-hidden'));
        this.ensureFrame();
        return Object.freeze({
            invalidate: (reason: string, damage?: DamageRecord) => { if (this.live(entry)) this.invalidate(pane.paneId, reason, damage); },
            // Focus is not visibility: a change of focus alone is a real change (the focus chrome), a repeat of the same value is not.
            setFocused: (focused: boolean) => {
                if (!this.live(entry) || entry.focused === focused) return;
                entry.focused = focused; this.mark(entry, 'focus');
            },
            wakeAt: (layer: Layer, deadlineMs: number | null) => this.wakeAt(entry, layer, deadlineMs),
            startFling: (samples: readonly TouchPanSample[]) => this.startFling(entry, samples),
            animateZoom: (targetZ: number, anchor?: Point) => this.animateZoom(entry, targetZ, anchor),
            animatePan: (delta: Point, durationMs: number) => this.animatePan(entry, delta, durationMs),
            glideTo: (target: Camera, durationMs: number) => this.glideTo(entry, target, durationMs),
            // Settling a camera that is not moving changes nothing; only a motion that was running is a change.
            cancelMotion: () => {
                if (!this.live(entry)) return;
                const moving = entry.motion !== null;
                this.cancelMotion(entry);
                if (moving) this.mark(entry, 'settle');
            },
            dispose: () => this.unregister(entry),
        });
    }

    /** Async producers should use their bound lease, so old arrivals cannot wake a replacement view. */
    invalidate(paneId: string, reason: string, damage?: DamageRecord): void {
        const entry = this.panes.get(paneId);
        if (!entry) return;
        if (reason === 'input') {
            this.cancelMotion(entry); entry.inputPriority = true;
            if (renderAuditEnabled() && entry.pendingInputAt === null) entry.pendingInputAt = performance.now();
        }
        if (damage) this.mergeDamage(entry.damage, damage);
        else entry.fullDamage = true;
        this.mark(entry, reason, true);
    }

    /** Session-owned expiry shares the wakeAt timer and survives pane unregister/window hiding.
     * Its callback releases retained resources; it never draws or requires a frame.
     */
    scheduleDeadline(deadline: number, callback: () => void): () => void {
        if (!Number.isFinite(deadline) || deadline < 0) throw new RangeError('Invalid session deadline');
        const item = { deadline, callback };
        this.sessionDeadlines.add(item);
        this.refreshWakeTimer();
        return () => { this.sessionDeadlines.delete(item); this.refreshWakeTimer(); };
    }

    /** Persistent until cancelled; callbacks added during a frame are not run recursively in it. */
    schedulePoll(callback: () => void): () => void {
        const poll: ScheduledPoll = { callback, earliestFrame: this.frameId + 1, failures: 0, retryAt: 0 };
        this.polls.add(poll);
        this.ensureFrame();
        return () => { this.polls.delete(poll); this.ensureFrame(); };
    }

    /** Backend writeBuffer/writeTexture and implicit-2D callers report actual synchronous call cost.
     * This is admission feedback, not GPU execution time; captures outside a frame keep their own budget.
     */
    recordUpload(bytes: number, elapsedMs: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
            throw new RangeError('Upload measurements must be finite and nonnegative');
        }
        if (this.meter) {
            this.meter.reportedBytes += bytes; this.meter.reportedCalls++; this.meter.callMs += elapsedMs;
            if (__BME_BENCH__ && this.measuredPane && this.meter.byPane) {
                const measured = this.meter.byPane.get(this.measuredPane) ?? { bytes: 0, calls: 0, ms: 0 };
                measured.bytes += bytes; measured.calls++; measured.ms += elapsedMs;
                this.meter.byPane.set(this.measuredPane, measured);
            }
        }
    }

    /** Frame-ring data is mandatory presentation work, packed after optional preparation (C4.3).
     * Account its exact native batch, including alignment gaps; excess remains an honest overshoot
     * that reduces the next optional slice, not an unmeasured upload or a guessed full-ring charge.
     */
    recordUniformUpload(bytes: number, elapsedMs: number): void {
        this.recordUpload(bytes, elapsedMs);
        if (this.meter) this.meter.admittedBytes += bytes;
    }

    setReducedMotion(reduced: boolean): void {
        // The platform reports this at start and on every media-query event; only a change alters any pane.
        if (this.reducedMotion === reduced) return;
        this.reducedMotion = reduced;
        if (!reduced) return;
        for (const entry of this.panes.values()) {
            this.call(entry, () => {
                if (entry.motion?.kind === 'zoom') {
                    const zoom = entry.motion;
                    const z = entry.pane.camera.clampZoom(zoom.targetZ);
                    entry.pane.camera.setCamera(cameraAtAnchor(zoom.world, this.zoomAnchor(entry, zoom), z));
                }
                if (entry.motion?.kind === 'glide') entry.pane.camera.setCamera({ ...entry.motion.to });
                this.cancelMotion(entry);
                this.mark(entry, 'reduced-motion');
            });
        }
    }

    pressure(): void {
        this.releaseRetained('pressure');
        for (const entry of this.panes.values()) this.mark(entry, 'pressure');
    }

    /** The last frame started: the frame in progress during its own preparation, the frame that just ran afterwards. */
    currentFrame(): number { return this.frameId; }

    idleForCapture(): boolean {
        if (!this.running || this.suspended || this.inFrame) return false;
        for (const entry of this.panes.values()) {
            if (!entry.renderable) continue;
            if (entry.inputPriority || entry.motion || entry.reasons.size) return false;
            try { if (entry.pane.isInteracting()) return false; }
            catch { return false; }
        }
        return true;
    }

    private live(entry: PaneEntry): boolean { return this.panes.get(entry.pane.paneId) === entry; }

    /** Takes the pane's reasons, damage and full flag for this frame. Called before any callback of this pane in the frame. */
    private detach(entry: PaneEntry, frameId: number, batches: DamageBatch[], audit: boolean):
        { entry: PaneEntry; batch: DamageBatch; reasons: readonly string[]; cause: string } {
        const batch: DamageBatch = { entry, damage: entry.damage, full: entry.fullDamage, submitted: false };
        const reasons: readonly string[] = entry.reasons.size ? Object.freeze([...entry.reasons]) : NO_REASONS;
        batches.push(batch);
        entry.damage = entry.spareDamage ?? new DamageAccumulator(); entry.spareDamage = null; entry.fullDamage = false; entry.reasons.clear();
        entry.lastFrame = frameId;
        return { entry, batch, reasons, cause: audit ? this.presentCause(entry, reasons) : '' };
    }

    /** The frame's layer snapshots. Every layer's revision and critical flag are read each frame; the frozen list is rebuilt only
     * when one of them changed, so a frame at rest or a camera frame builds none (it built a frozen object per layer, per pane,
     * per frame). Frames keep their list: a reused one is identical, and frozen. */
    private layerSnapshots(entry: PaneEntry, view: ViewState): readonly ScheduledLayerSnapshot[] {
        const last = entry.layerSnapshots, layers = entry.layers;
        let same = last !== null && last.length === layers.length;
        const revisions = this.revisionScratch, criticals = this.criticalScratch;
        revisions.length = 0; criticals.length = 0;
        for (let i = 0; i < layers.length; i++) {
            const revision = entry.pane.sceneRevision(layers[i]), critical = entry.pane.isCritical(layers[i], view);
            revisions.push(revision); criticals.push(critical);
            if (same && (last![i].layer !== layers[i] || last![i].sceneRevision !== revision || last![i].critical !== critical)) same = false;
        }
        if (same) return last!;
        const next = Object.freeze(layers.map((layer, i) => Object.freeze({ layer, sceneRevision: revisions[i], critical: criticals[i] })));
        entry.layerSnapshots = next;
        return next;
    }
    private readonly revisionScratch: number[] = [];
    private readonly criticalScratch: boolean[] = [];

    /** The scene revisions as a damage tag, rebuilt only when one of them moved: a board at rest repeated the JSON per pane per frame. */
    private revisionKey(entry: PaneEntry, layers: readonly ScheduledLayerSnapshot[]): string {
        const values = entry.revisionValues;
        let same = values.length === layers.length;
        for (let i = 0; same && i < layers.length; i++) same = values[i] === layers[i].sceneRevision;
        if (!same) {
            values.length = 0;
            for (const layer of layers) values.push(layer.sceneRevision);
            entry.revisionKey = JSON.stringify(values);
        }
        return entry.revisionKey;
    }

    private mark(entry: PaneEntry, reason: string, preserveDamage = false): void {
        if (!this.live(entry)) return;
        if (!preserveDamage) entry.fullDamage = true;
        entry.reasons.add(reason);
        this.ensureFrame();
    }

    private mergeDamage(target: DamageAccumulator, damage: DamageRecord): void {
        const tags = { reasonBits: damage.reasonBits, cameraEpoch: damage.cameraEpoch, contentRevision: damage.contentRevision };
        if (damage.full) target.markFull(tags);
        else if (!damage.worldBounds.length) target.mark({ x: 0, y: 0, width: 0, height: 0 }, tags);
        else for (const bounds of damage.worldBounds) target.mark(bounds, tags);
    }

    private unregister(entry: PaneEntry): void {
        if (!this.live(entry)) return;
        this.panes.delete(entry.pane.paneId);
        forgetPaneMotion(entry.pane.paneId);
        entry.reasons.clear();
        entry.wakes.clear();
        this.cancelMotion(entry);
        this.acknowledgements = this.acknowledgements.filter(ack => ack.entry !== entry);
        try { entry.pane.suspend('unregistered'); }
        finally { this.refreshWakeTimer(); this.ensureFrame(); }
    }

    private call<T>(entry: PaneEntry, callback: () => T): T | undefined {
        if (!this.live(entry)) return undefined;
        const previous = __BME_BENCH__ ? this.measuredPane : null;
        if (__BME_BENCH__) this.measuredPane = entry.pane.paneId;
        try { return callback(); }
        catch (error) {
            if (this.recovers(entry, error)) return undefined;
            try { this.unregister(entry); }
            finally { this.options.onError(entry.pane.paneId, error); }
            return undefined;
        } finally { if (__BME_BENCH__) this.measuredPane = previous; }
    }

    private token(entry: PaneEntry): FrameToken | null {
        const current = entry.pane.currentToken();
        if (!current) return null;
        const token = Object.freeze({ vaultEpoch: current.vaultEpoch, documentId: current.documentId,
            bytesGeneration: current.bytesGeneration, session: current.session,
            viewLease: current.viewLease, deviceGeneration: current.deviceGeneration });
        const bound = entry.binding;
        if (bound && (bound.vaultEpoch !== token.vaultEpoch || bound.documentId !== token.documentId ||
            bound.session !== token.session || bound.viewLease !== token.viewLease)) {
            // A token change is a rebind: the owner attaches a new pane with the new token (usePlatformPane re-attaches on any
            // session or byte-generation change; a native view's viewLease is fixed per pane). This pane is unregistered and
            // suspended with 'unregistered' because its replacement takes over; nothing re-registers it, by design. Counted so a
            // drop without a rebind would show up: none was found reading the owners (gpu-h11 R7).
            if (renderAuditEnabled()) auditCount('scheduler', 'binding-dropped');
            this.unregister(entry);
            return null;
        }
        entry.binding ??= token;
        return token;
    }

    private valid(entry: PaneEntry, token: FrameToken): boolean {
        return this.running && !this.suspended && this.live(entry) && !this.demoted.has(entry) && sameToken(token, entry.pane.currentToken());
    }

    /** A layer not prepared this frame (the window was exhausted, or the frame's share ran out) settles unchanged only when it
     * has no pending work: its scene revision has not moved since it last prepared, it does not ask for a frame, and its last
     * answer was unchanged. Any other passed-over layer is a change, so the frame presents. */
    private passedOver(item: FrameWork, meta: ScheduledLayerSnapshot): void {
        const last = this.layerAnswers.get(meta.layer);
        const pending = last === undefined || !last.unchanged || last.revision !== meta.sceneRevision || meta.layer.needsFrame();
        if (pending) item.drawnChange = true;
        else item.settled++;
        if (renderAuditEnabled()) auditCount('pane', 'prepare-passed-over:' + (item.entry.pane.layerId?.(meta.layer) ?? 'unnamed'));
    }

    /** Drops the pane's submissions that have completed or can no longer complete (see FRAMES_IN_FLIGHT). A completed one that
     * carried an input records that input's latency to completion, the time the person sees the frame on the GPU. */
    private pruneInFlight(entry: PaneEntry): void {
        if (entry.inflight.length === 0) return;
        entry.inflight = entry.inflight.filter(({ submission, inputAt }) => {
            if (submission.superseded?.() ?? false) return false;
            if (!(submission.completed?.() ?? false)) return true;
            if (inputAt !== null) recordInputLatency('complete', performance.now() - inputAt);
            return false;
        });
    }

    /** True when this frame cannot change the picture, whatever invalidated it: every layer of the pane ran its preparation to
     * completion and none reported a visible change (prepare returned false), and the frame needs no repaint (explicit full damage,
     * a new token, camera, viewport or geometry since the last presented picture). A layer that was passed over, or returns nothing,
     * is a change: nothing was proved about it. The reason does not matter when nothing drawn changed.
     * A pending acknowledgement does not make a frame present: it is delivered by its own poll each frame (deliverAcknowledgements),
     * and a skipped frame adds none and supersedes none. Presenting for it drew the same picture again while the GPU finished the
     * last one (measured: 14 of 15 remaining redundant zoom presents on LARGE=11, present-kept:ack with no layer changed). */
    private unchangedPicture(item: FrameWork): boolean {
        return !item.drawnChange && item.settled === item.frame.layers.length && !item.repaint;
    }

    /** The pane handled its own error (a GPU failure): it stays registered and its work for this frame is skipped. A pane
     * that cannot handle it, or whose handler throws, is unregistered as before. Its encodings for this frame are dropped
     * (valid() is false for a demoted pane, so step 6 discards them unsubmitted). The next frame repaints it in full, under
     * reason 'recover': with no reason recorded, a pane whose failed frame delivered nothing stayed blank after the stroke. */
    private recovers(entry: PaneEntry, error: unknown): boolean {
        let handled = false;
        try { handled = entry.pane.recover?.(error) === true; }
        catch { handled = false; }
        if (!handled || !this.live(entry)) return false;
        this.demoted.add(entry);
        this.mark(entry, 'recover');
        return true;
    }

    /** Names what asked for a presented frame, first match wins: input, camera motion, a layer deadline, an invalidation
     * (the first reason recorded), a layer still needing a frame. `none` is a fault: nothing requested that frame.
     * Measured on an idle board (notebook and annotated PDF 57 presents in 114 ticks), so the cause is named, not guessed. */
    private presentCause(entry: PaneEntry, reasons: readonly string[]): string {
        if (reasons.includes('input')) return 'input';
        if (entry.motion !== null || entry.pane.isInteracting()) return 'camera';
        if (reasons.includes('deadline')) return 'wake';
        if (reasons.length) return `invalidate:${reasons[0]}`;
        const layer = entry.layers.find(candidate => candidate.needsFrame());
        if (layer) return `needsFrame:${entry.pane.layerId?.(layer) ?? entry.layers.indexOf(layer)}`;
        return 'none';
    }

    /** Every true answer names a cause: a pending poll or acknowledgement (frames only, no present), a pane's reason or
     * motion, or a renderable layer that needs a frame. Called on every mark: it scans the pane list and copies nothing. */
    private needsWork(): boolean {
        if (this.polls.size || this.acknowledgements.length) return true;
        for (const entry of this.panes.values()) {
            if (entry.reasons.size || entry.motion) return true;
            if (entry.renderable && this.call(entry, () => entry.layers.some(layer => layer.needsFrame()))) return true;
        }
        return false;
    }

    private cancelFrame(): void { if (this.raf !== null) { cancelAnimationFrame(this.raf); this.raf = null; } }

    /** Requests the back-off after a failed frame: no frame is requested until it runs out, then the loop resumes as needed. */
    private holdFrames(ms: number): void {
        if (this.frameHold !== null) clearTimeout(this.frameHold);
        this.cancelFrame();
        this.frameHold = setTimeout(() => { this.frameHold = null; this.ensureFrame(); }, ms);
    }

    private ensureFrame(): void {
        if (this.inFrame || this.frameHold !== null) return;
        if (!this.running || this.suspended) { this.cancelFrame(); return; }
        // A frame already requested decides for itself when it runs (it re-checks at its end), so a burst of marks does not scan
        // every pane and layer each time (gpu-h11 R11): the scan runs once per frame request, not once per mark.
        if (this.raf !== null) return;
        if (!this.needsWork()) return;
        this.raf = requestAnimationFrame(this.runFrame);
    }

    private readonly runFrame = (timestamp: number): void => {
        this.raf = null;
        if (!this.running || this.suspended) return;
        this.inFrame = true;
        this.demoted.clear();
        const frameId = ++this.frameId;
        auditTapeStart();
        const started = performance.now();
        const encodings: Array<{ work: FrameWork; encoding: ScheduledEncoding; done: boolean; offscreenOnly?: true }> = [];
        const batches: DamageBatch[] = [];
        let prepareOvershootMs = 0;
        let targetMs = 0;
        try {
            const gap = this.lastTimestamp === null ? 0 : timestamp - this.lastTimestamp;
            if (gap > 0) this.observeInterval(gap);
            this.lastTimestamp = timestamp;
            // A gap after idle is not a reason to draw. It used to add a 'frame-gap' reason to EVERY pane, so the first
            // input after rest presented every visible pane under a cause nobody had. Full damage alone is conservative;
            // a pane that presents still validates its geometry in commitMetrics (§7.4:723), and a healthy context is kept.
            if (gap > frameGapMs) {
                for (const entry of this.panes.values()) {
                    if (entry.motion?.kind === 'fling' && timestamp - entry.motion.lastTime > frameGapMs) this.cancelMotion(entry);
                    entry.fullDamage = true;
                }
            }
            targetMs = Math.min(RENDER_CONSTANTS.frameTargetMaxMs, RENDER_CONSTANTS.frameTargetIntervalFraction * this.intervalMs);
            const allowance = this.options.uploadAllowance(this.intervalMs);
            if (!Number.isSafeInteger(allowance) || allowance < 0) throw new RangeError('Upload allowance must be nonnegative safe bytes');
            const meter: UploadMeter = {
                allowance, sliceMs: Math.min(1, 0.12 * this.intervalMs), deadline: Infinity,
                admittedBytes: 0, reportedBytes: 0, reportedCalls: 0, callMs: 0, progressUsed: false,
                ...(__BME_BENCH__ ? { byPane: new Map<string, { bytes: number; calls: number; ms: number }>() } : {}),
            };
            this.meter = meter;
            // 1–2: consume reported geometry/lifecycle first, then input and time-integrated cameras.
            // The cause is read here, where the frame is requested: a camera that stops in advanceMotion, or a layer that
            // stops needing a frame during its own preparation, would otherwise leave a presented frame with no cause.
            // A pane with nothing to do is never detached, so it costs one test and no allocation. Panes with a reason or a
            // camera in motion are detached before any callback runs: cross-pane invalidations during this frame belong to the
            // next frame, whichever candidate is visited first. Layers that need a frame are tested afterwards, so a callback
            // there cannot pull a reason forward; a pane detached here is skipped by that second pass (lastFrame).
            const candidates: Array<{ entry: PaneEntry; batch: DamageBatch; reasons: readonly string[]; cause: string }> = [];
            for (const entry of this.panes.values()) {
                if (entry.reasons.size === 0 && entry.motion === null) continue;
                candidates.push(this.detach(entry, frameId, batches, renderAuditEnabled()));
            }
            for (const entry of this.panes.values()) {
                if (entry.lastFrame === frameId || entry.reasons.size !== 0 || entry.motion !== null || !entry.renderable) continue;
                if (this.call(entry, () => entry.layers.some(layer => layer.needsFrame())) !== true) continue;
                candidates.push(this.detach(entry, frameId, batches, renderAuditEnabled()));
            }
            // A frame with no candidate presents nothing; it exists only because a poll or an unfinished acknowledgement
            // keeps the loop alive. Naming it keeps every requested frame accounted for ('none' would be a fault).
            if (renderAuditEnabled() && candidates.length === 0) {
                auditCount('scheduler', this.polls.size ? 'frame:poll' : this.acknowledgements.length ? 'frame:ack' : 'frame:none');
            }
            const ready: Array<{ entry: PaneEntry; reasons: readonly string[]; batch: DamageBatch; cause: string }> = [];
            for (const { entry, batch, reasons, cause } of candidates) {
                this.call(entry, () => {
                    // Discard stale document/view work BEFORE a callback can resize a surface.
                    if (!this.token(entry)) { entry.renderable = false; this.cancelMotion(entry); return; }
                    // Capture the CURRENT gesture anchor before a target commit can replace
                    // backing/clip state; camera and DOM remain on the old frame if it fails.
                    const reportedAnchor = entry.pane.resizeAnchor?.();
                    const anchor = reportedAnchor ? { world: { ...reportedAnchor.world }, surface: { ...reportedAnchor.surface } } : undefined;
                    const previousGeometry = entry.pane.metrics.current?.tags.geometryGeneration;
                    const result = entry.pane.commitMetrics(frameId);
                    if (result?.kind === 'ready') {
                        entry.pane.camera.setViewport(result.metrics.viewport, anchor, result.tags.geometryGeneration !== previousGeometry,
                            result.metrics.nominalDpr);
                    }
                    const token = this.token(entry);
                    const metrics = entry.pane.metrics.current;
                    entry.renderable = !!token && result?.kind !== 'failed' && metrics?.kind === 'ready' && metrics.tags.deviceGeneration === token.deviceGeneration;
                    if (!entry.renderable || !token || !this.live(entry)) {
                        entry.wakes.clear();
                        this.cancelMotion(entry);
                        // A failed commit is transient (a resize the grant has not reached yet). Non-renderable panes are
                        // not polled for needsFrame, so without a retry the pane stayed parked: a stroke's tail never drew
                        // after a commit failed at its last move, and a PDF board never followed its degraded first frame.
                        if (result?.kind === 'failed' && token && this.live(entry) && entry.layers.some(layer => layer.needsFrame())) {
                            queueMicrotask(() => { if (this.live(entry)) this.mark(entry, 'metrics-retry'); });
                        }
                        if (metrics?.kind === 'dormant' && !entry.dormantNotified) {
                            entry.dormantNotified = true;
                            entry.pane.suspend('geometry-dormant');
                        }
                        return;
                    }
                    entry.dormantNotified = false;
                    ready.push({ entry, reasons, batch, cause });
                });
            }
            // All geometry precedes all input; all cameras advance/freeze before any scene snapshot.
            for (const { entry } of ready) this.call(entry, () => entry.pane.consumeInput(timestamp));
            for (const { entry } of ready) {
                this.call(entry, () => {
                    this.advanceMotion(entry, timestamp);
                    const moving = entry.motion !== null || entry.pane.isInteracting();
                    entry.pane.camera.setMoving(moving);
                    recordPaneMotion(entry.pane.paneId, moving);
                });
            }
            const frozen: Array<{ entry: PaneEntry; reasons: readonly string[]; batch: DamageBatch; cause: string; geometry: number; token: FrameToken; view: ViewState }> = [];
            for (const { entry, reasons, batch, cause } of ready) {
                this.call(entry, () => {
                    const token = this.token(entry);
                    const metrics = entry.pane.metrics.current;
                    if (!token || !this.valid(entry, token) || metrics?.kind !== 'ready' || metrics.tags.deviceGeneration !== token.deviceGeneration) {
                        entry.renderable = false;
                        return;
                    }
                    frozen.push({ entry, reasons, batch, cause, geometry: metrics.tags.geometryGeneration, token, view: entry.pane.camera.beginFrame(frameId) });
                });
            }
            const work: FrameWork[] = [];
            for (const { entry, reasons, batch, cause, geometry, token, view } of frozen) {
                this.call(entry, () => {
                    // 3: freeze authoritative scene/live input before retiring any previously wet revision.
                    entry.pane.snapshotScene(view);
                    const layers = this.layerSnapshots(entry, view);
                    const revision = this.revisionKey(entry, layers);
                    const tags = { reasonBits: 0, contentRevision: revision.length <= 4096 ? revision : '', cameraEpoch: view.epoch };
                    const previous = entry.presented;
                    // No pending damage is not a repaint: a frame that marked nothing (a layer's own needsFrame, a deferred mark) has
                    // no damage record. It is drawn in full when it presents (the markFull below).
                    // The skip needs only a real repaint: a new token, a camera or geometry change, or explicit full damage from a
                    // damage record. An invalidation with no damage record also sets the batch's full flag, but nothing it reports
                    // requires a present if every layer answers unchanged, so that flag draws in full and does not force a present.
                    // The camera and viewport, not the view epoch: the epoch also moves when the moving flag flips at a gesture's start and
                    // end with the camera where it was, and every such frame repainted the same picture (measured: 2 redundant presents per
                    // stroke or drag, repaint:epoch). A layer whose picture depends on the flag (the PDF's motion tiles) answers changed itself.
                    const moved = !previous || !sameToken(token, previous.token) || !sameCamera(previous.view, view) || previous.geometry !== geometry;
                    batch.pending = batch.damage.freeze();
                    const explicitFull = batch.pending?.full === true;
                    if (batch.full || revision.length > 4096 || moved || !batch.pending) batch.damage.markFull(tags);
                    else batch.damage.mark({ x: 0, y: 0, width: 0, height: 0 }, tags);
                    const repaint = moved || explicitFull;
                    if (repaint && renderAuditEnabled()) {
                        auditTape(`repaint:${!previous ? 'first' : !sameToken(token, previous.token) ? 'token' : !sameCamera(previous.view, view) ? 'camera'
                            : previous.geometry !== geometry ? 'geometry' : 'full-damage'}`);
                    }
                    if (renderAuditEnabled()) auditTape(`cause:${cause}`);
                    const damage = batch.damage.freeze()!;
                    const frame = Object.freeze({ frameId, timestamp, intervalMs: this.intervalMs, token, view, layers, reasons, damage });
                    work.push({ entry, frame, batch, geometry, hadInput: entry.inputPriority || reasons.includes('input'), platformPrepared: false, skipped: false, drawnChange: false, settled: 0, foreground: entry.foregroundAnswers, repaint, cause });
                    entry.foregroundAnswers.clear();
                    entry.inputPriority = false;
                });
            }
            this.deliverAcknowledgements(frameId);
            // 4: the frame's preparation budget, from the interval and the visible panes' measured presentation cost.
            const elapsedInput = performance.now() - started;
            // The frame's preparation budget is the display interval less what the visible panes cost to encode, submit and present
            // (their measured EWMA) and less the time already spent this frame. Foreground work decides whether this frame is
            // complete, so it gets that whole budget; the upload window caps only background work (below). A pane that has not
            // presented yet has no measured cost, so its first frame has the whole interval. Prepare keeps its floor: presentation
            // of an uncached board must not take every frame (measured on ~3,600 strokes, the board showed "Updating..." for good).
            let presentReserve = 0;
            for (const item of work) presentReserve += item.entry.presentMs;
            const foregroundStart = performance.now();
            const foregroundMs = Math.max(targetMs * PREPARE_FLOOR_FRACTION, this.intervalMs - presentReserve - elapsedInput - this.maintenanceMs);
            const prepareDeadline = performance.now() + foregroundMs;
            meter.deadline = prepareDeadline;
            const criticalOrder = this.rotate(work, this.criticalCursor++);
            // The critical class of every pane still to prepare this frame (a two-phase layer's foreground call is that class). The
            // one-tile progress grant is held for it until it has run; after that an optional layer may take it. Asking whether a layer
            // IS critical starved optional layers for good: a layer that stays critical after its prepare (it has no use for the
            // grant) held every optional upload past its frame (measured: a PDF's exact tiles refused 510 of 510 claims after a zoom,
            // their textures created and destroyed every frame, the raster stand-in shown and a present per tick, for good).
            const criticalToRun = this.criticalToRun; criticalToRun.clear();
            for (const item of work) for (const meta of item.frame.layers) if (meta.critical || meta.layer.twoPhase === true) criticalToRun.add(meta.layer);
            meter.criticalToRun = criticalToRun;
            const criticalPending = () => criticalToRun.size > 0;
            for (const item of criticalOrder) {
                prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, null, prepareDeadline, true, meter, criticalPending));
                if (!item.platformPrepared && this.valid(item.entry, item.frame.token)) this.mark(item.entry, 'preparation-deferred', true);
            }
            for (const item of criticalOrder) {
                if (!item.platformPrepared) continue;
                // Live work first, critical or not: a layer with ink in flight takes the pane's time and upload allowance before
                // paper, board tiles or any other layer. Measured on notebook draw: a paper layer still building was admitted 570
                // times while the wet layer was refused every frame (its cover incomplete, 121 compositor refusals). A flagged layer is
                // prepared here and skipped below, so each single-phase layer is prepared once per frame.
                const layers = item.frame.layers;
                const flags = this.call(item.entry, () => layers.some(meta => firstPreparing(meta.layer)) ? layers.map(meta => firstPreparing(meta.layer)) : null) ?? null;
                if (flags) {
                    for (let i = 0; i < layers.length; i++) {
                        if (!flags[i]) continue;
                        // A two-phase layer's foreground call is always the critical class: its background call comes later.
                        const twoPhase = layers[i].layer.twoPhase === true;
                        prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, layers[i], prepareDeadline, twoPhase || layers[i].critical,
                            meter, criticalPending, twoPhase ? 'foreground' : 'single'));
                    }
                }
                // Every single-phase layer is foreground: it is what the frame shows, so it takes the foreground budget, not the 1 ms
                // background window. The critical class (its full byte allowance) goes first, the rest after it.
                for (let i = 0; i < layers.length; i++) {
                    if (flags?.[i]) continue;
                    const twoPhase = layers[i].layer.twoPhase === true;
                    if (!twoPhase && !layers[i].critical) continue;
                    prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, layers[i], prepareDeadline, true, meter, criticalPending,
                        twoPhase ? 'foreground' : 'single'));
                }
                for (let i = 0; i < layers.length; i++) {
                    if (flags?.[i] || layers[i].critical || layers[i].layer.twoPhase === true) continue;
                    prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, layers[i], prepareDeadline, false, meter, criticalPending, 'single'));
                }
            }
            // Background runs only in what foreground and the presentation reserve left of this frame's interval, and never longer
            // than the upload window (min(1 ms, 0.12 interval)): the window keeps background work from causing jank.
            // A quiet frame (no input in it, no gesture or camera motion on any pane) has no jank to cause: its background work takes
            // what the frame has left, up to half the interval. Held to the upload window at rest too, a dense board's tiles, which its
            // live picture covers so they are background work, composed in about 1 ms a frame with the main thread 88% idle, and
            // "Updating…" stayed 20-50 s after the first picture (measured, Strokes-3, 5,640 strokes, WebGL2).
            const quiet = work.every(item => !item.hadInput && item.entry.motion === null && !item.entry.pane.isInteracting());
            const backgroundCap = quiet ? this.intervalMs * QUIET_BACKGROUND_FRACTION : meter.sliceMs;
            const backgroundStart = performance.now();
            const backgroundEnd = performance.now() + Math.min(backgroundCap, Math.max(0, started + this.intervalMs - presentReserve - performance.now()));
            meter.deadline = backgroundEnd;
            const optionalOrder = this.focusFirst(this.rotate(work, this.optionalCursor++));
            const optionalMs = Math.max(0, backgroundEnd - performance.now()) / Math.max(1, work.length);
            for (const item of optionalOrder) {
                if (!item.platformPrepared) continue;
                item.entry.optionalBytes = Math.min(Math.max(meter.allowance, progressUploadBytes),
                    item.entry.optionalBytes + meter.allowance / Math.max(1, work.length));
                const deadline = Math.min(backgroundEnd, performance.now() + optionalMs);
                // Only two-phase layers have background work here, and only after their foreground call ran this frame: a layer the
                // foreground pass passed over is not composed.
                for (const meta of item.frame.layers) {
                    if (meta.layer.twoPhase !== true || !item.foreground.has(meta.layer)) continue;
                    prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, meta, deadline, false, meter, criticalPending, 'background'));
                }
            }
            // A layer passed over for time, not asking for a frame, has nothing else to wake it. After a restore that
            // leaves its picture blank for good, so the pass names the work and the next frame prepares it.
            for (const item of work) {
                if (item.skipped && this.valid(item.entry, item.frame.token)) this.mark(item.entry, 'preparation-deferred', true);
            }
            // Layers declare group/mask inventory during prepare; admit it once afterward, without
            // extending the critical preparation or upload deadline. A compositor owns runnable retries.
            for (const item of criticalOrder) {
                if (item.platformPrepared && item.platformBudget && this.valid(item.entry, item.frame.token)) {
                    this.call(item.entry, () => item.entry.pane.finishPrepareFrame?.(item.frame, item.platformBudget!));
                    prepareOvershootMs = Math.max(prepareOvershootMs, performance.now() - prepareDeadline);
                }
            }
            // 5: focus/input first, then rotate neighbours; nobody's mandatory draw is budget-skipped.
            // Each pane's encode, submit and overlay time this frame; it feeds the pane's EWMA, the next frame's presentation reserve.
            const presentCost = this.presentCost; presentCost.clear();
            const presentStart = performance.now();
            if (renderAuditEnabled()) {
                auditCount('scheduler', 'foreground-us', Math.round((backgroundStart - foregroundStart) * 1000));
                auditCount('scheduler', 'background-us', Math.round((presentStart - backgroundStart) * 1000));
            }
            // Audit only, in microseconds: how far past its preparation deadline the presentation started (foreground ran long),
            // and how far the preparation ran past it (the last call's overrun).
            if (renderAuditEnabled()) {
                const late = performance.now() - prepareDeadline;
                if (late > 0) auditCount('scheduler', 'present-late-us', Math.round(late * 1000));
            }
            for (const item of this.focusFirst(this.rotate(work, this.encodeCursor++))) {
                const encodeStarted = performance.now();
                this.call(item.entry, () => {
                    if (!item.platformPrepared || !this.valid(item.entry, item.frame.token)) return;
                    // A frame whose layers all report unchanged shows the picture it would draw: the presented-frame observers run for
                    // it (presentUnchanged), and only the GPU encode and submit are skipped, whatever invalidated the frame. Its damage
                    // stays pending (merged back below, unsubmitted), and any work still outstanding keeps its own mark or needsFrame.
                    // A skipped frame is a presented frame whose GPU work is skipped: the same observers, overlays and presented record
                    // run for it. Acknowledgements are not added: nothing it draws is new, and the earlier ones still arrive on their own.
                    if (this.unchangedPicture(item) && item.entry.pane.presentUnchanged(item.frame)) {
                        if (renderAuditEnabled()) auditCount('pane', 'present-skipped:unchanged');
                        item.batch.skipped = true;
                        item.entry.presented = { token: item.frame.token, view: item.frame.view, geometry: item.geometry };
                        item.entry.pane.writeOverlays(item.frame);
                        // Its layers' offscreen work (tiles composed off the view) is encoded without presenting: no surface pass.
                        const offscreen = item.entry.pane.encodeOffscreen?.(item.frame) ?? null;
                        if (offscreen) {
                            encodings.push({ work: item, encoding: offscreen, done: false, offscreenOnly: true });
                            if (renderAuditEnabled()) auditCount('pane', 'offscreen-only');
                        }
                        return;
                    }
                    if (renderAuditEnabled()) {
                        const kept = item.repaint ? 'repaint' : this.acknowledgements.some(ack => ack.entry === item.entry) ? 'ack'
                            : item.drawnChange ? 'changed' : 'not-called';
                        auditCount('pane', 'present-kept:' + kept);
                    }
                    const changed = item.drawnChange || item.repaint || item.settled !== item.frame.layers.length;
                    // Backpressure: a pane with FRAMES_IN_FLIGHT unfinished submissions waits for its oldest one. The prepare already ran and
                    // the damage stays pending, so the frame is presented by a later one, not dropped.
                    this.pruneInFlight(item.entry);
                    if (item.entry.inflight.length >= FRAMES_IN_FLIGHT) {
                        if (renderAuditEnabled()) auditCount('scheduler', 'inflight:wait');
                        this.mark(item.entry, 'presentation-deferred', true);
                        return;
                    }
                    const encoding = item.entry.pane.encode(item.frame, changed);
                    if (encoding) encodings.push({ work: item, encoding, done: false });
                    else if (item.entry.layers.some(layer => layer.needsFrame())) {
                        // An external wait must wake the pane on arrival; polling it here spins rAF.
                        this.mark(item.entry, 'presentation-deferred', true);
                    }
                });
                presentCost.set(item.entry, (presentCost.get(item.entry) ?? 0) + performance.now() - encodeStarted);
            }
            const submitStart = performance.now();
            if (renderAuditEnabled()) auditCount('scheduler', 'encode-us', Math.round((submitStart - presentStart) * 1000));
            // 6: publish overlays only for the exact snapshot successfully submitted by its compositor.
            for (const item of encodings) {
                const submitStarted = performance.now();
                this.call(item.work.entry, () => {
                    if (!this.valid(item.work.entry, item.work.frame.token)) return;
                    // An offscreen-only encoding presents nothing: the skipped frame already ran its observers, and its damage stays pending.
                    if (item.offscreenOnly) { item.encoding.submit(); item.done = true; return; }
                    const submission = item.encoding.submit();
                    item.done = true;
                    if (!submission) { this.mark(item.work.entry, 'presentation-deferred', true); return; }
                    if (submission.completed) {
                        item.work.entry.inflight.push({ submission, inputAt: item.work.entry.pendingInputAt });
                    }
                    if (item.work.entry.pendingInputAt !== null) {
                        // Submit is the earliest the frame can be shown; the GPU completion is recorded by pruneInFlight.
                        recordInputLatency('submit', performance.now() - item.work.entry.pendingInputAt);
                        item.work.entry.pendingInputAt = null;
                    }
                    if (renderAuditEnabled()) auditCount('scheduler', `inflight-at-submit:${Math.min(item.work.entry.inflight.length, 4)}`);
                    if (!this.valid(item.work.entry, item.work.frame.token)) {
                        if (__BME_BENCH__) submission.cancelObservation?.();
                        return;
                    }
                    item.work.batch.submitted = true; item.work.batch.damage.reset();
                    if (renderAuditEnabled()) {
                        auditCount('pane', 'present:' + item.work.cause);
                        // Every reason the frame carried, not only the first: the cause names the first match, and a camera
                        // cause hides the invalidations behind it while the pane is interacting.
                        for (const reason of item.work.frame.reasons) auditCount('pane', 'present-reason:' + reason);
                    }
                    item.work.entry.presented = { token: item.work.frame.token, view: item.work.frame.view, geometry: item.work.geometry };
                    const drawn = Object.freeze(submission.drawn.filter(revision => revision.layer.onFramePresented !== undefined)
                        .map(revision => Object.freeze({ layer: revision.layer, sceneRevision: revision.sceneRevision })));
                    // Preserve a class-backed completion predicate's receiver; object spread would drop
                    // prototype methods and could acknowledge an unfinished submission one frame early.
                    const completed = submission.completed?.bind(submission);
                    if (drawn.length) this.acknowledgements.push({ entry: item.work.entry, frameId, token: item.work.frame.token,
                        submission: completed ? { drawn, completed } : { drawn } });
                    item.work.entry.pane.writeOverlays(item.work.frame);
                    if (__BME_BENCH__) submission.commitObservation?.();
                    if (benchmarkPerf) {
                        const frame = item.work.frame;
                        const accounting = item.work.entry.pane.benchmarkMemory?.();
                        const uploads = meter.byPane?.get(item.work.entry.pane.paneId);
                        benchmarkPerf.recordRenderFrame({ frameId, token: frame.token, camera: frame.view.camera,
                            sceneRevision: frame.damage.contentRevision, deviceGeneration: frame.token.deviceGeneration,
                            memory: accounting?.memory ?? {}, grants: accounting?.grants ?? {},
                            uploadedBytes: uploads?.bytes ?? 0, uploadCalls: uploads?.calls ?? 0, uploadMs: uploads?.ms ?? 0 });
                    }
                });
                presentCost.set(item.work.entry, (presentCost.get(item.work.entry) ?? 0) + performance.now() - submitStarted);
                if (!item.done) { this.discard(item.work.entry, item.encoding); item.done = true; }
            }
            // The EWMA of each visible pane's presentation cost (encode, submit, overlays). A pane with no presentation this frame
            // decays toward zero, so a pane that stopped drawing stops reserving its share.
            for (const item of work) item.entry.presentMs = 0.8 * item.entry.presentMs + 0.2 * (presentCost.get(item.entry) ?? 0);
            // 7: bounded retirement/compile/readback polls. They never draw a hidden pane.
            const maintenanceStart = performance.now();
            // Audit only: a frame's completion is seen here too, so the last frame of a gesture is measured, not only ones followed by a frame.
            if (renderAuditEnabled()) for (const entry of this.panes.values()) this.pruneInFlight(entry);
            if (renderAuditEnabled()) auditCount('scheduler', 'submit-us', Math.round((maintenanceStart - submitStart) * 1000));
            this.runPolls(started + targetMs);
            this.maintenanceMs = performance.now() - maintenanceStart;
            if (renderAuditEnabled()) {
                // The whole frame against its interval: a frame past it is late for its display.
                const total = performance.now() - started;
                auditCount('scheduler', 'frame-us', Math.round(total * 1000));
                if (total > this.intervalMs) {
                    // The stage split of over-interval frames only, so the overrun is attributed to the stage that ran long in it.
                    auditCount('scheduler', 'frame-over-interval');
                    const us = (from: number, to: number) => Math.round((to - from) * 1000);
                    auditCount('scheduler', 'over-pre-us', us(started, foregroundStart));
                    auditCount('scheduler', 'over-foreground-us', us(foregroundStart, backgroundStart));
                    auditCount('scheduler', 'over-background-us', us(backgroundStart, presentStart));
                    auditCount('scheduler', 'over-encode-us', us(presentStart, submitStart));
                    auditCount('scheduler', 'over-submit-us', us(submitStart, maintenanceStart));
                    auditCount('scheduler', 'over-poll-us', us(maintenanceStart, performance.now()));
                }
            }
            this.frameFailures = 0;
        } catch (error) {
            // The scheduler never stops for good: a stopped scheduler freezes every pane, healthy ones included, and start() is
            // one-shot. A pane's own callbacks are contained by call(), which names the pane it demotes or unregisters; an error
            // that reaches here escaped every pane, so it names no pane. The loop holds for a back-off (1 s, doubling, to 30 s)
            // and resumes; the first failure of a streak is reported, the rest are counted.
            this.frameFailures++;
            if (this.frameFailures === 1) this.options.onError(null, error);
            else if (renderAuditEnabled()) auditCount('scheduler', 'frame-failed');
            this.holdFrames(retryDelay(this.frameFailures));
        } finally {
            for (const item of encodings) if (!item.done) this.discard(item.work.entry, item.encoding);
            for (const batch of batches) if (!batch.submitted && this.live(batch.entry)) {
                // A skipped frame returns the damage it was given, not the full mark it drew with: merged back, that mark made the next
                // frame an explicit full repaint, so every skip was followed by a present of the same picture (measured: 30 of 30 at rest).
                // A frame that meant to present and did not keeps its marks, so the next one presents what this one prepared.
                const damage = batch.skipped && batch.pending !== undefined ? batch.pending : batch.damage.freeze();
                if (damage) this.mergeDamage(batch.entry.damage, damage);
                batch.entry.fullDamage ||= batch.full;
            }
            // Each batch's accumulator is spent (its damage submitted or merged back above): it is the pane's spare for the next detach.
            for (const batch of batches) if (this.live(batch.entry) && batch.entry.spareDamage === null && batch.damage !== batch.entry.damage) {
                batch.damage.reset(); batch.entry.spareDamage = batch.damage;
            }
            const meter = this.meter;
            this.meter = null;
            this.inFrame = false;
            auditFrame('scheduler', performance.now() - started);
            try {
                if (meter) {
                    const elapsedMs = performance.now() - started;
                    const bytes = Math.max(meter.admittedBytes, meter.reportedBytes);
                    // No observed calls is UNKNOWN, not proof that a missing backend hook cost zero.
                    const complete = meter.reportedCalls > 0 && meter.admittedBytes === meter.reportedBytes;
                    const missingMeasurement = !complete && (meter.admittedBytes > 0 || meter.reportedBytes > 0);
                    if (elapsedMs > targetMs || prepareOvershootMs > 0 || bytes > meter.allowance || meter.callMs > meter.sliceMs || missingMeasurement) {
                        // The pressure report is the owner's code: its throw is reported without leaving the frame's bookkeeping.
                        try {
                            this.options.onPressure(Object.freeze({ frameId, targetMs, elapsedMs, prepareOvershootMs,
                                admittedUploadBytes: meter.admittedBytes, uploadByteAllowance: meter.allowance,
                                uploadByteOvershoot: Math.max(0, bytes - meter.allowance), reportedUploadBytes: meter.reportedBytes,
                                reportedUploadCalls: meter.reportedCalls, uploadCallMs: meter.callMs, uploadTimeAllowanceMs: meter.sliceMs,
                                uploadTimeOvershootMs: Math.max(0, meter.callMs - meter.sliceMs), uploadMeasurementsComplete: complete }));
                        } catch (error) { this.options.onError(null, error); }
                    }
                }
            } finally { this.refreshWakeTimer(); this.ensureFrame(); }
        }
    };

    private prepare(item: FrameWork, meta: ScheduledLayerSnapshot | null, deadline: number, critical: boolean,
        meter: UploadMeter, criticalPending: () => boolean, phase: BudgetPhase = 'single'): number {
        let overshoot = 0;
        this.call(item.entry, () => {
            // A layer that reports needsFrame() must be prepared in THIS frame, or its pump keeps running with nothing
            // advancing. The window is shared with the pane's platform preparation, which can spend all of it before a
            // layer is reached (every layer waits behind it), so a requesting layer past an exhausted window gets one
            // progress slice. A healthy frame keeps the window as it was; the overrun is still reported as overshoot.
            const requesting = meta !== null ? meta.layer.needsFrame() : item.entry.layers.some(layer => layer.needsFrame());
            const exhausted = performance.now() >= deadline;
            // The platform's frame preparation is never skipped on the deadline. A frame that skipped it kept the previous frame
            // id, so the compositors refused its encode and a pane under load presented nothing, not even its stand-ins. It runs
            // with an exhausted budget instead (shouldYield true from the start; only media uploads are granted), so the frame
            // keeps its id and the layers present what they already hold. The deferred work continues on the next frame, through
            // the layers' own needsFrame (no extra mark here: an idle pane must not gain a frame).
            const platform = meta === null;
            if (exhausted && !requesting && !platform) {
                if (renderAuditEnabled() && meta && cameraMoved(meta.layer, item.frame.view)) auditCount('scheduler', 'camera-skipped:' + phase);
                item.skipped = true;
                // Which pass ran out of window: foreground ran out of its budget, background out of what foreground left.
                if (renderAuditEnabled()) auditCount('scheduler', 'skip:' + phase);
                // As below for a yielded background call: its foreground call ran this frame and draws at this camera. Not recorded here,
                // the next frame's calls read the move the layer had drawn and presented the same picture again (round 9 info timing,
                // doc12 pan: invalidate:preparation-deferred after a skipped background call, board-content alone changed).
                if (meta && phase === 'background' && item.foreground.has(meta.layer))
                    lastPreparedCamera.set(meta.layer, { x: item.frame.view.camera.x, y: item.frame.view.camera.y, z: item.frame.view.camera.z });
                if (meta) this.passedOver(item, meta);
                return;
            }
            const limit = exhausted && !platform ? performance.now() + meter.sliceMs : deadline;
            // A two-phase layer's pass is its phase, not the pane's critical class: its foreground call is critical by construction.
            // The class is read once, as the prepare starts: a layer that left its class since the frame's snapshot yields to the other
            // pass, but one whose own prepare changes it is not cut off mid-prepare. The wet layer is critical only while ink is in
            // flight, so admitting the stroke's last runs made it optional halfway: its claims were refused ('yield') and its other band
            // passed over, so the saturated draw's last input frames presented the same picture unanswered (measured: 1 of 91 inputs and
            // 3 of 5 redundant presents on every document; canvas2d 91 of 91 and 2).
            const layerCritical = meta !== null && phase === 'single' ? item.entry.pane.isCritical(meta.layer, item.frame.view) : critical;
            // Only a layer in the critical pass that became optional yields for its class (the optional pass still prepares it). One that
            // became critical after the critical pass ran is prepared here: yielding sent it to a pass already over, so it was passed over
            // and the frame presented its last picture again (measured, doc12 saturated draw: the wet layer, class-now-critical, 1 of 1
            // redundant presents of its kind).
            const classYield = critical && !layerCritical;
            const shouldYield = () => !this.valid(item.entry, item.frame.token) || performance.now() >= limit || classYield;
            // remainingBytes includes the explicit one-tile progress grant, not a disguised larger cap.
            // The nominal cap stays in the frame meter and any use beyond it is reported as an overrun.
            // A canvas2d pane draws a board picture tile whole, larger than a platform tile: its progress grant is that tile, or a
            // picture whose tiles never fit one frame's allowance never draws (the GPU compositor declares nothing more).
            const progressBytes = Math.max(progressUploadBytes, item.entry.pane.progressUploadBytes?.() ?? 0);
            const availableBytes = () => {
                let remaining = Math.max(0, meter.allowance - Math.max(meter.admittedBytes, meter.reportedBytes));
                if (!meter.progressUsed && Math.max(meter.admittedBytes, meter.reportedBytes) < PROGRESS_SMALL_BYTES && (critical || !criticalPending())) {
                    remaining = Math.max(remaining, progressBytes);
                }
                return Math.floor(critical ? remaining : Math.min(remaining, item.entry.optionalBytes));
            };
            const upload = { remainingBytes: availableBytes(), deadline: meter.deadline };
            const budget: FrameBudget = {
                frameId: item.frame.frameId, token: item.frame.token, cameraEpoch: item.frame.view.epoch, damage: item.frame.damage, phase,
                prepareDeadline: limit, upload, shouldYield,
                claimUpload: (bytes: number, kind?: 'media') => {
                    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Upload claim must be nonnegative safe bytes');
                    if (kind === 'media') {
                        // A playing video's frame (8 MB at 1080p) can never fit the general allowance (about 1 MiB at 240 Hz), so it
                        // would never reach the GPU. The copy from a VideoFrame is device-side, so the grant ignores the allowance and
                        // the time slice, is not charged to this frame's upload meter, and is counted with its bytes.
                        // Every media claim is granted: the image route admits at most one upload per video node per presented frame, so
                        // several playing videos each advance, and a second claim from one node is that route's own bookkeeping.
                        if (!this.valid(item.entry, item.frame.token)) return false;
                        auditCount('scheduler', 'media:upload-granted', 1, { bytes });
                        item.drawnChange = true;
                        return true;
                    }
                    // Audit only: a refused claim names its check, so a layer that retries a refused upload every frame is traced.
                    const refused = (why: string): false => {
                        if (renderAuditEnabled()) auditCount('scheduler', `claim-refused:${why}:${meta ? item.entry.pane.layerId?.(meta.layer) ?? 'unnamed' : 'platform'}`);
                        return false;
                    };
                    if (shouldYield()) return refused(!this.valid(item.entry, item.frame.token) ? 'yield-invalid' : classYield ? 'yield-class' : 'yield-time');
                    if (performance.now() >= meter.deadline) return refused('deadline');
                    const remaining = meter.allowance - Math.max(meter.admittedBytes, meter.reportedBytes);
                    if (!critical && bytes > item.entry.optionalBytes) return refused('optional');
                    // §5.6 progress guarantee, vr-lead: optional too after all critical work drains.
                    // At 240Hz ~1MiB is smaller than a 1,056,784-byte tile; DRR alone cannot fix that.
                    const progress = bytes > remaining && !meter.progressUsed && Math.max(meter.admittedBytes, meter.reportedBytes) < PROGRESS_SMALL_BYTES &&
                        bytes <= progressBytes && (critical || !criticalPending());
                    if (bytes > remaining && !progress) return refused(meter.progressUsed ? 'progress-used' : criticalPending() && !critical ? 'critical-pending' : 'remaining');
                    meter.progressUsed ||= progress;
                    meter.admittedBytes += bytes;
                    if (!critical) item.entry.optionalBytes -= bytes;
                    upload.remainingBytes = availableBytes();
                    // An upload is not a visible change by itself: the layer that made it says whether the picture changed (an off-screen
                    // ring tile's upload presented the same picture, measured: 6 of 17 redundant zoom presents on LARGE=11).
                    return true;
                },
            };
            if (platform) {
                if (this.valid(item.entry, item.frame.token)) {
                    if (exhausted) auditCount('scheduler', 'prepare:exhausted', 1);
                    item.platformBudget = budget;
                    item.entry.pane.prepareFrame(item.frame, budget);
                    item.platformPrepared = true;
                }
            } else if (meta && !shouldYield()) {
                // prepare returns false only when a completed prepare left nothing it draws next different (types.ts). A layer
                // that returns nothing leaves the frame's picture open: it is presented.
                // A camera move is a change for every layer: it is what every layer draws from. A layer that answers unchanged on a
                // move is reported changed here, so no skip or passed-over decision rests on a stale answer. The move is compared
                // with the previous frame's last call; a foreground call does not record it (the background call that follows does).
                const moved = cameraMoved(meta.layer, item.frame.view);
                const unchangedAnswer = meta.layer.prepare(item.frame.view, budget) === false;
                const answered = unchangedAnswer && (!moved || meta.layer.idle?.() === true);
                if (phase !== 'foreground') lastPreparedCamera.set(meta.layer, { x: item.frame.view.camera.x, y: item.frame.view.camera.y, z: item.frame.view.camera.z });
                if (renderAuditEnabled() && moved) {
                    const named = phase + ':' + (item.entry.pane.layerId?.(meta.layer) ?? 'unnamed');
                    auditCount('scheduler', 'camera-prepare:' + named);
                    if (unchangedAnswer) auditCount('scheduler', 'camera-unchanged:' + named);
                }
                if (phase === 'foreground') {
                    // Not the frame's answer: the background call settles the layer. A changed answer here still marks the frame.
                    item.foreground.set(meta.layer, answered);
                    if (!answered) {
                        item.drawnChange = true;
                        if (renderAuditEnabled()) auditCount('pane', 'prepare-changed:' + (item.entry.pane.layerId?.(meta.layer) ?? 'unnamed'));
                    }
                } else {
                    // A two-phase layer is unchanged only when both calls answered unchanged (the background call is always after foreground).
                    const unchanged = answered && (phase === 'single' || item.foreground.get(meta.layer) === true);
                    this.layerAnswers.set(meta.layer, { revision: meta.sceneRevision, unchanged });
                    item.settled++;
                    if (!unchanged) {
                        item.drawnChange = true;
                        if (renderAuditEnabled()) auditCount('pane', 'prepare-changed:' + (item.entry.pane.layerId?.(meta.layer) ?? 'unnamed'));
                    }
                }
            } else if (meta) {
                if (renderAuditEnabled() && cameraMoved(meta.layer, item.frame.view)) auditCount('scheduler', 'camera-yielded:' + phase);
                // A two-phase layer whose foreground call ran this frame prepared, and draws, at this camera even when its background call
                // is passed over: the camera is recorded here, as that background call would have. Left at the camera before, the next
                // frame's calls read a move that was already drawn and overrode the layer's own unchanged answer (measured, img8 pan start:
                // the deferred background frame after it, camera-unchanged:foreground and :background, presented the same picture again).
                if (phase === 'background' && item.foreground.has(meta.layer))
                    lastPreparedCamera.set(meta.layer, { x: item.frame.view.camera.x, y: item.frame.view.camera.y, z: item.frame.view.camera.z });
                this.passedOver(item, meta);
            }
            overshoot = Math.max(0, performance.now() - deadline);
            if (overshoot > 0 && renderAuditEnabled()) auditCount('scheduler', 'overshoot-us:' + phase, Math.round(overshoot * 1000));
        });
        // The critical-class call has had its turn at the progress grant this frame, prepared or not (see criticalToRun).
        if (critical && meta) meter.criticalToRun?.delete(meta.layer);
        return overshoot;
    }

    private discard(entry: PaneEntry, encoding: ScheduledEncoding): void {
        // Cleanup must run even after unregister; skipping it would retain unsubmitted frame pins.
        try { encoding.discard(); }
        catch (error) { this.options.onError(entry.pane.paneId, error); }
    }

    private deliverAcknowledgements(frameId: number): void {
        if (!this.acknowledgements.length) return;
        const pending = this.acknowledgements;
        this.acknowledgements = [];
        for (const ack of pending) {
            this.call(ack.entry, () => {
                if (!this.valid(ack.entry, ack.token)) return;
                if (ack.submission.superseded?.()) return;
                if (ack.frameId >= frameId || (ack.submission.completed && !ack.submission.completed())) {
                    this.acknowledgements.push(ack);
                    return;
                }
                for (const revision of ack.submission.drawn) {
                    if (!this.valid(ack.entry, ack.token)) break;
                    if (!ack.entry.layers.includes(revision.layer) || !Number.isSafeInteger(revision.sceneRevision) || revision.sceneRevision < 0) {
                        throw new RangeError('Submission revision does not belong to the registered layers');
                    }
                    revision.layer.onFramePresented?.(revision.sceneRevision, ack.token);
                }
            });
        }
    }

    /** One array per call: the rotation is written straight into it, not sliced and spread. */
    private rotate<T>(items: readonly T[], cursor: number): T[] {
        const ordered: T[] = [];
        if (!items.length) return ordered;
        const split = cursor % items.length;
        for (let i = 0; i < items.length; i++) ordered.push(items[(split + i) % items.length]);
        return ordered;
    }

    private focusFirst(work: readonly FrameWork[]): FrameWork[] {
        const ordered: FrameWork[] = [];
        for (const item of work) if (item.entry.focused || item.hadInput) ordered.push(item);
        for (const item of work) if (!(item.entry.focused || item.hadInput)) ordered.push(item);
        return ordered;
    }

    private runPolls(deadline: number): void {
        if (!this.polls.size) return;
        let ran = false;
        for (const poll of [...this.polls]) {
            if (!this.running || this.suspended) break;
            if (!this.polls.has(poll) || poll.earliestFrame > this.frameId || poll.retryAt > performance.now()) continue;
            if (ran && performance.now() >= deadline) break;
            // Rotate persistent work so a tight frame cannot starve later fences. One gets progress.
            this.polls.delete(poll);
            this.polls.add(poll);
            ran = true;
            try { poll.callback(); poll.failures = 0; }
            catch (error) {
                // Kept, not dropped: the owner cancels through its handle, and a dropped poll left that handle pointing at nothing.
                poll.failures++;
                if (poll.failures === 1) this.options.onError(null, error);
                else if (renderAuditEnabled()) auditCount('scheduler', 'poll-failed');
                poll.retryAt = performance.now() + retryDelay(poll.failures);
            }
        }
    }

    private wakeAt(entry: PaneEntry, layer: Layer, deadlineMs: number | null): void {
        if (!this.running || this.suspended || !this.live(entry)) return;
        if (!entry.layers.includes(layer)) throw new RangeError('Only a registered layer may schedule its deadline');
        if (deadlineMs !== null && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
            throw new RangeError('Layer deadline must be nonnegative monotonic milliseconds');
        }
        if (deadlineMs === null) entry.wakes.delete(layer);
        else entry.wakes.set(layer, deadlineMs);
        this.refreshWakeTimer();
        this.ensureFrame();
    }

    private clearWakeTimer(): void {
        if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
        this.wakeDeadline = null;
        this.wakeEpoch++;
    }

    private refreshWakeTimer(): void {
        if (this.inFrame) return;
        const now = performance.now();
        if (this.sessionDeadlines.size) for (const item of [...this.sessionDeadlines]) {
            if (item.deadline > now || !this.sessionDeadlines.delete(item)) continue;
            try { item.callback(); } catch (error) { this.options.onError(null, error); }
        }
        let earliest = Infinity;
        for (const item of this.sessionDeadlines) earliest = Math.min(earliest, item.deadline);
        if (this.running && !this.suspended) for (const entry of this.panes.values()) {
            for (const [layer, deadline] of entry.wakes) {
                if (deadline <= now) { entry.wakes.delete(layer); entry.reasons.add('deadline'); entry.fullDamage = true; }
                else earliest = Math.min(earliest, deadline);
            }
        }
        if (this.wakeTimer !== null && this.wakeDeadline === earliest) return;
        this.clearWakeTimer();
        if (!Number.isFinite(earliest)) return;
        const epoch = this.wakeEpoch;
        this.wakeDeadline = earliest;
        this.wakeTimer = setTimeout(() => {
            if (epoch !== this.wakeEpoch) return;
            this.wakeTimer = null;
            this.wakeDeadline = null;
            this.refreshWakeTimer();
            this.ensureFrame();
        }, Math.max(0, earliest - performance.now()));
    }

    private observeInterval(interval: number): void {
        if (interval > frameGapMs || (this.hasEstimate && interval > 2 * this.intervalMs)) {
            // vr-lead: a 240→60Hz change would otherwise reject 16.67ms forever. Rebootstrap after
            // eight consecutive supported rejects, never from long-task (>1000/30ms) samples.
            if (interval >= minIntervalMs && interval <= maxIntervalMs) this.rejectedIntervals.push(interval);
            else this.rejectedIntervals = [];
            if (this.rejectedIntervals.length >= 8) { this.intervals = this.rejectedIntervals.slice(-8); this.rejectedIntervals = []; this.updateEstimate(); }
            return;
        }
        this.rejectedIntervals = [];
        this.intervals.push(interval);
        if (this.intervals.length > 120) this.intervals.shift();
        if (this.intervals.length >= 8) this.updateEstimate();
    }

    private updateEstimate(): void {
        const sorted = [...this.intervals].sort((a, b) => a - b);
        this.intervalMs = clamp(sorted[Math.max(0, Math.ceil(sorted.length * 0.2) - 1)], minIntervalMs, maxIntervalMs);
        this.hasEstimate = true;
    }

    private startFling(entry: PaneEntry, samples: readonly TouchPanSample[]): void {
        if (!this.running || this.suspended || !this.live(entry)) return;
        this.cancelMotion(entry);
        const fit = releaseVelocity(samples);
        if (!this.reducedMotion && fit) entry.motion = { kind: 'fling', lastTime: fit.time, velocity: fit.velocity };
        entry.inputPriority = true;
        this.mark(entry, 'animation');
    }

    private animateZoom(entry: PaneEntry, targetZ: number, anchor?: Point): void {
        if (!this.running || this.suspended || !this.live(entry)) return;
        if (!Number.isFinite(targetZ) || targetZ <= 0 || (anchor && !finitePoint(anchor))) throw new RangeError('Zoom target/anchor must be finite and scale positive');
        this.cancelMotion(entry);
        const camera = entry.pane.camera;
        const surface = anchor ?? { x: camera.viewport.width / 2, y: camera.viewport.height / 2 };
        const target = camera.clampZoom(targetZ);
        if (this.reducedMotion || target === camera.camera.z) camera.zoomTo(target, surface);
        else entry.motion = { kind: 'zoom', startedAt: performance.now(), startZ: camera.camera.z, targetZ: target,
            world: surfaceToWorld(surface, camera.camera), anchor: anchor ? { ...anchor } : null,
            lastViewport: camera.viewport, lastZ: camera.camera.z };
        entry.inputPriority = true;
        this.mark(entry, 'animation');
    }

    private animatePan(entry: PaneEntry, delta: Point, durationMs: number): void {
        if (!this.running || this.suspended || !this.live(entry)) return;
        if (!finitePoint(delta)) throw new RangeError('Pan delta must be finite');
        const { x, y, z } = entry.pane.camera.camera;
        this.glideTo(entry, { x: x + delta.x / z, y: y + delta.y / z, z }, durationMs);
    }

    /** One camera glide, pan and zoom together. Reduced motion, a zero duration and a pane that cannot animate all jump:
     * a caller's move (back to content, the minimap) lands even where no frame will run. */
    private glideTo(entry: PaneEntry, target: Camera, durationMs: number): void {
        if (!finitePoint(target) || !(Number.isFinite(target.z) && target.z > 0) || !Number.isFinite(durationMs) || durationMs < 0) {
            throw new RangeError('Glide target must be a finite camera with a positive zoom, and its duration nonnegative');
        }
        this.cancelMotion(entry);
        const camera = entry.pane.camera;
        if (this.reducedMotion || durationMs === 0 || !this.running || this.suspended || !this.live(entry)) camera.setCamera({ ...target });
        else entry.motion = { kind: 'glide', startedAt: performance.now(), durationMs, from: { ...camera.camera }, to: { ...target } };
        entry.inputPriority = true;
        this.mark(entry, 'animation');
    }

    private cancelMotion(entry: PaneEntry): void {
        entry.motion = null; entry.pane.camera.setMoving(false); recordPaneMotion(entry.pane.paneId, false);
    }

    private zoomAnchor(entry: PaneEntry, motion: ZoomMotion): Point {
        return motion.anchor ?? { x: entry.pane.camera.viewport.width / 2, y: entry.pane.camera.viewport.height / 2 };
    }

    private advanceMotion(entry: PaneEntry, timestamp: number): void {
        const motion = entry.motion;
        if (!motion) return;
        const camera = entry.pane.camera;
        if (motion.kind === 'fling') {
            const dt = Math.max(0, timestamp - motion.lastTime) / 1000;
            const decay = Math.exp(-dt / 0.240);
            const delta = { x: motion.velocity.x * 0.240 * (1 - decay), y: motion.velocity.y * 0.240 * (1 - decay) };
            const before = camera.camera;
            camera.panBy(delta);
            motion.velocity.x = camera.camera.x === before.x + delta.x / before.z ? motion.velocity.x * decay : 0;
            motion.velocity.y = camera.camera.y === before.y + delta.y / before.z ? motion.velocity.y * decay : 0;
            motion.lastTime = Math.max(timestamp, motion.lastTime);
            // vr-lead resolves §7.3's conflict: stopping at <0.25px/frame discards ~7.2px at120Hz
            // versus ~1.8px at30Hz. Speed<5 alone keeps the exact integrated tail refresh-independent.
            if (Math.hypot(motion.velocity.x, motion.velocity.y) < 5) entry.motion = null;
        } else if (motion.kind === 'glide') {
            const u = clamp((timestamp - motion.startedAt) / motion.durationMs, 0, 1);
            const eased = 1 - (1 - u) ** 3, at = (from: number, to: number) => from + (to - from) * eased;
            camera.setCamera({ x: at(motion.from.x, motion.to.x), y: at(motion.from.y, motion.to.y), z: at(motion.from.z, motion.to.z) });
            if (u === 1) entry.motion = null;
        } else {
            if (camera.viewport !== motion.lastViewport) {
                const ratio = camera.camera.z / motion.lastZ;
                motion.startZ *= ratio;
                motion.targetZ *= ratio;
                motion.world = surfaceToWorld(this.zoomAnchor(entry, motion), camera.camera);
                motion.lastViewport = camera.viewport;
            }
            const u = clamp((timestamp - motion.startedAt) / 120, 0, 1);
            const eased = 1 - (1 - u) ** 3;
            const z = camera.clampZoom(Math.exp(Math.log(motion.startZ) + (Math.log(motion.targetZ) - Math.log(motion.startZ)) * eased));
            camera.setCamera(cameraAtAnchor(motion.world, this.zoomAnchor(entry, motion), z));
            motion.lastZ = camera.camera.z;
            if (u === 1) entry.motion = null;
        }
    }

    private readonly visibilityChanged = (): void => { if (document.hidden) this.suspendWindow('window-hidden'); else this.resumeWindow(false); };
    private readonly frozen = (): void => { this.suspendWindow('frozen'); this.releaseRetained('freeze'); };
    private readonly pageShown = (event: PageTransitionEvent): void => { if (!document.hidden) this.resumeWindow(event.persisted); };
    private readonly pageHidden = (event: PageTransitionEvent): void => {
        this.suspendWindow('window-hidden');
        if (event.persisted) this.releaseRetained('freeze');
        else this.stop(); // Final App/session/broker disposal remains the owning adapter's responsibility.
    };

    private suspendWindow(reason: 'window-hidden' | 'frozen'): void {
        if (!this.suspended) {
            this.suspended = true;
            this.hiddenAt = performance.now();
            this.retainedReleased = false;
            this.cancelFrame();
            this.clearWakeTimer();
            for (const entry of [...this.panes.values()]) {
                entry.wakes.clear();
                this.cancelMotion(entry);
                this.call(entry, () => entry.pane.suspend(reason));
            }
            this.options.windowVisibility(false, false);
        }
        this.refreshWakeTimer();
        this.armHiddenTimer();
    }

    private resumeWindow(persisted: boolean): void {
        // Enforce elapsed expiry before a throttled timer can permit even one stale reuse (§7.4:721).
        if (this.hiddenAt !== null && performance.now() - this.hiddenAt >= RENDER_CONSTANTS.hiddenWindowRetentionMs) this.releaseRetained('hidden-timeout');
        this.clearHiddenTimer();
        this.suspended = false;
        this.hiddenAt = null;
        this.retainedReleased = false;
        this.lastTimestamp = null;
        this.options.windowVisibility(true, persisted);
        for (const entry of this.panes.values()) { entry.wakes.clear(); entry.reasons.add('resume-geometry'); entry.fullDamage = true; }
        this.refreshWakeTimer();
        this.ensureFrame();
    }

    private clearHiddenTimer(): void { if (this.hiddenTimer !== null) { clearTimeout(this.hiddenTimer); this.hiddenTimer = null; } }

    private armHiddenTimer(): void {
        this.clearHiddenTimer();
        if (!this.running || !this.suspended || this.hiddenAt === null || this.retainedReleased) return;
        const remaining = Math.max(0, RENDER_CONSTANTS.hiddenWindowRetentionMs - (performance.now() - this.hiddenAt));
        this.hiddenTimer = setTimeout(() => {
            this.hiddenTimer = null;
            if (!this.running || !this.suspended || this.hiddenAt === null) return;
            if (performance.now() - this.hiddenAt >= RENDER_CONSTANTS.hiddenWindowRetentionMs) this.releaseRetained('hidden-timeout');
            else this.armHiddenTimer();
        }, remaining);
    }

    private releaseRetained(reason: 'pressure' | 'freeze' | 'hidden-timeout'): void {
        if (this.suspended && this.retainedReleased) return;
        this.clearHiddenTimer();
        this.options.releaseRetained(reason);
        if (this.suspended) this.retainedReleased = true;
    }
}
