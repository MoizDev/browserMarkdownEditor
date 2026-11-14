import type { Viewport, ViewState } from '../types';
import { cameraAtAnchor, surfaceToWorld } from './camera';
import type { CameraAnchor, CameraController, Point } from './camera';
import { RENDER_CONSTANTS } from './constants';
import type { SurfaceCommit, SurfaceMetricsCommitter } from './surfaceMetrics';
import type { FrameBudget, FrameToken, Layer } from './types';

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
    /** Platform target/ring admission once per frame, before any layer prepares; never draws. */
    prepareFrame(view: ViewState, budget: FrameBudget): void;
    encode(frame: ScheduledFrame): ScheduledEncoding | null;
    writeOverlays(frame: ScheduledFrame): void;
    /** Stop input/speculative work and synchronously checkpoint through the session, never await a frame. */
    suspend(reason: 'unregistered' | 'window-hidden' | 'frozen' | 'geometry-dormant' | 'stopped'): void;
}

/** Bound to one registration, so stale async arrivals/cleanup cannot target a replacement view. */
export interface ScheduledPaneLease {
    invalidate(reason: string): void;
    setFocused(focused: boolean): void;
    /** Monotonic performance.now/rAF milliseconds; null cancels only this layer's pending deadline. */
    wakeAt(layer: Layer, deadlineMs: number | null): void;
    startFling(samples: readonly TouchPanSample[]): void;
    animateZoom(targetZ: number, anchor?: Point): void;
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

type Motion = FlingMotion | ZoomMotion;

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
const progressTileBytes = (RENDER_CONSTANTS.tileInteriorPixels + 2 * RENDER_CONSTANTS.tileGutterTexels) ** 2 * RENDER_CONSTANTS.decodedRgbaBytesPerPixel;
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
    motion: Motion | null;
    binding: FrameToken | null;
}

interface FrameWork { entry: PaneEntry; frame: ScheduledFrame; hadInput: boolean }
interface PendingAcknowledgement { entry: PaneEntry; frameId: number; token: FrameToken; submission: ScheduledSubmission }
interface ScheduledPoll { callback: () => void; earliestFrame: number }
interface UploadMeter {
    allowance: number;
    sliceMs: number;
    deadline: number;
    admittedBytes: number;
    reportedBytes: number;
    reportedCalls: number;
    callMs: number;
    progressUsed: boolean;
}

function sameToken(a: FrameToken, b: FrameToken | null): boolean {
    return b !== null && a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
        a.bytesGeneration === b.bytesGeneration && a.session === b.session &&
        a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}

let schedulerStarted = false;

/** One app-wide rAF owner, explicitly started; importing it installs no listeners (C4.6:624–628).
 * Sanctioned deadline path: wakeAt coalesces future layer work into one timer that ONLY invalidates,
 * never draws or polls needsFrame; there are no rAF callbacks while nothing is due (vr-lead ruling).
 */
export class FrameScheduler {
    private readonly panes = new Map<string, PaneEntry>();
    private readonly polls = new Set<ScheduledPoll>();
    private acknowledgements: PendingAcknowledgement[] = [];
    private running = false;
    private suspended = false;
    private inFrame = false;
    private raf: number | null = null;
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    private wakeDeadline: number | null = null;
    private wakeEpoch = 0;
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
    private presentationMs = 0;
    private maintenanceMs = 0;
    private meter: UploadMeter | null = null;

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
    }

    register(pane: ScheduledPane): ScheduledPaneLease {
        if (this.panes.has(pane.paneId)) throw new Error('A visible pane is already registered');
        const entry: PaneEntry = {
            pane, layers: Object.freeze([...pane.layers]), reasons: new Set(['show']), wakes: new Map(), focused: pane.focused,
            inputPriority: false, renderable: false, dormantNotified: false, optionalBytes: 0, motion: null, binding: null,
        };
        this.panes.set(pane.paneId, entry);
        if (this.running && this.suspended) this.call(entry, () => pane.suspend('window-hidden'));
        this.ensureFrame();
        return Object.freeze({
            invalidate: (reason: string) => { if (this.live(entry)) this.invalidate(pane.paneId, reason); },
            setFocused: (focused: boolean) => { if (this.live(entry)) { entry.focused = focused; this.mark(entry, 'focus'); } },
            wakeAt: (layer: Layer, deadlineMs: number | null) => this.wakeAt(entry, layer, deadlineMs),
            startFling: (samples: readonly TouchPanSample[]) => this.startFling(entry, samples),
            animateZoom: (targetZ: number, anchor?: Point) => this.animateZoom(entry, targetZ, anchor),
            cancelMotion: () => { if (this.live(entry)) { this.cancelMotion(entry); this.mark(entry, 'settle'); } },
            dispose: () => this.unregister(entry),
        });
    }

    /** Async producers should use their bound lease, so old arrivals cannot wake a replacement view. */
    invalidate(paneId: string, reason: string): void {
        const entry = this.panes.get(paneId);
        if (!entry) return;
        if (reason === 'input') { this.cancelMotion(entry); entry.inputPriority = true; }
        this.mark(entry, reason);
    }

    /** Persistent until cancelled; callbacks added during a frame are not run recursively in it. */
    schedulePoll(callback: () => void): () => void {
        const poll = { callback, earliestFrame: this.frameId + 1 };
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
        if (this.meter) { this.meter.reportedBytes += bytes; this.meter.reportedCalls++; this.meter.callMs += elapsedMs; }
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
        this.reducedMotion = reduced;
        if (!reduced) return;
        for (const entry of this.panes.values()) {
            this.call(entry, () => {
                if (entry.motion?.kind === 'zoom') {
                    const zoom = entry.motion;
                    const z = entry.pane.camera.clampZoom(zoom.targetZ);
                    entry.pane.camera.setCamera(cameraAtAnchor(zoom.world, this.zoomAnchor(entry, zoom), z));
                }
                this.cancelMotion(entry);
                this.mark(entry, 'reduced-motion');
            });
        }
    }

    pressure(): void {
        this.releaseRetained('pressure');
        for (const entry of this.panes.values()) this.mark(entry, 'pressure');
    }

    private live(entry: PaneEntry): boolean { return this.panes.get(entry.pane.paneId) === entry; }

    private mark(entry: PaneEntry, reason: string): void {
        if (!this.live(entry)) return;
        entry.reasons.add(reason);
        this.ensureFrame();
    }

    private unregister(entry: PaneEntry): void {
        if (!this.live(entry)) return;
        this.panes.delete(entry.pane.paneId);
        entry.reasons.clear();
        entry.wakes.clear();
        this.cancelMotion(entry);
        this.acknowledgements = this.acknowledgements.filter(ack => ack.entry !== entry);
        try { entry.pane.suspend('unregistered'); }
        finally { this.refreshWakeTimer(); this.ensureFrame(); }
    }

    private call<T>(entry: PaneEntry, callback: () => T): T | undefined {
        if (!this.live(entry)) return undefined;
        try { return callback(); }
        catch (error) {
            try { this.unregister(entry); }
            finally { this.options.onError(entry.pane.paneId, error); }
            return undefined;
        }
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
            this.unregister(entry);
            return null;
        }
        entry.binding ??= token;
        return token;
    }

    private valid(entry: PaneEntry, token: FrameToken): boolean {
        return this.running && !this.suspended && this.live(entry) && sameToken(token, entry.pane.currentToken());
    }

    private needsWork(): boolean {
        if (this.polls.size || this.acknowledgements.length) return true;
        for (const entry of [...this.panes.values()]) {
            if (entry.reasons.size || entry.motion) return true;
            if (entry.renderable && this.call(entry, () => entry.layers.some(layer => layer.needsFrame()))) return true;
        }
        return false;
    }

    private cancelFrame(): void { if (this.raf !== null) { cancelAnimationFrame(this.raf); this.raf = null; } }

    private ensureFrame(): void {
        if (this.inFrame) return;
        if (!this.running || this.suspended || !this.needsWork()) { this.cancelFrame(); return; }
        if (this.raf === null) this.raf = requestAnimationFrame(this.runFrame);
    }

    private readonly runFrame = (timestamp: number): void => {
        this.raf = null;
        if (!this.running || this.suspended) return;
        this.inFrame = true;
        const frameId = ++this.frameId;
        const started = performance.now();
        const encodings: Array<{ work: FrameWork; encoding: ScheduledEncoding; done: boolean }> = [];
        let prepareOvershootMs = 0;
        let targetMs = 0;
        try {
            const gap = this.lastTimestamp === null ? 0 : timestamp - this.lastTimestamp;
            if (gap > 0) this.observeInterval(gap);
            this.lastTimestamp = timestamp;
            if (gap > frameGapMs) {
                for (const entry of this.panes.values()) {
                    if (entry.motion?.kind === 'fling' && timestamp - entry.motion.lastTime > frameGapMs) this.cancelMotion(entry);
                    entry.reasons.add('frame-gap'); // Validate geometry, never tear down a healthy context (§7.4:723).
                }
            }
            targetMs = Math.min(RENDER_CONSTANTS.frameTargetMaxMs, RENDER_CONSTANTS.frameTargetIntervalFraction * this.intervalMs);
            const allowance = this.options.uploadAllowance(this.intervalMs);
            if (!Number.isSafeInteger(allowance) || allowance < 0) throw new RangeError('Upload allowance must be nonnegative safe bytes');
            const meter: UploadMeter = {
                allowance, sliceMs: Math.min(1, 0.12 * this.intervalMs), deadline: Infinity,
                admittedBytes: 0, reportedBytes: 0, reportedCalls: 0, callMs: 0, progressUsed: false,
            };
            this.meter = meter;
            // 1–2: consume reported geometry/lifecycle first, then input and time-integrated cameras.
            const candidates = [...this.panes.values()].filter(entry => entry.reasons.size || entry.motion ||
                (entry.renderable && this.call(entry, () => entry.layers.some(layer => layer.needsFrame()))));
            const ready: Array<{ entry: PaneEntry; reasons: readonly string[] }> = [];
            for (const entry of candidates) {
                this.call(entry, () => {
                    const reasons = Object.freeze([...entry.reasons]);
                    entry.reasons.clear();
                    // Discard stale document/view work BEFORE a callback can resize a surface.
                    if (!this.token(entry)) { entry.renderable = false; this.cancelMotion(entry); return; }
                    // Capture the CURRENT gesture anchor before a target commit can replace
                    // backing/clip state; camera and DOM remain on the old frame if it fails.
                    const reportedAnchor = entry.pane.resizeAnchor?.();
                    const anchor = reportedAnchor ? { world: { ...reportedAnchor.world }, surface: { ...reportedAnchor.surface } } : undefined;
                    const previousGeometry = entry.pane.metrics.current?.tags.geometryGeneration;
                    const result = entry.pane.commitMetrics(frameId);
                    if (result?.kind === 'ready') {
                        entry.pane.camera.setViewport(result.metrics.viewport, anchor, result.tags.geometryGeneration !== previousGeometry);
                    }
                    const token = this.token(entry);
                    const metrics = entry.pane.metrics.current;
                    entry.renderable = !!token && result?.kind !== 'failed' && metrics?.kind === 'ready' && metrics.tags.deviceGeneration === token.deviceGeneration;
                    if (!entry.renderable || !token || !this.live(entry)) {
                        entry.wakes.clear();
                        this.cancelMotion(entry);
                        if (metrics?.kind === 'dormant' && !entry.dormantNotified) {
                            entry.dormantNotified = true;
                            entry.pane.suspend('geometry-dormant');
                        }
                        return;
                    }
                    entry.dormantNotified = false;
                    ready.push({ entry, reasons });
                });
            }
            // All geometry precedes all input; all cameras advance/freeze before any scene snapshot.
            for (const { entry } of ready) this.call(entry, () => entry.pane.consumeInput(timestamp));
            for (const { entry } of ready) {
                this.call(entry, () => {
                    this.advanceMotion(entry, timestamp);
                    entry.pane.camera.setMoving(entry.motion !== null || entry.pane.isInteracting());
                });
            }
            const frozen: Array<{ entry: PaneEntry; reasons: readonly string[]; token: FrameToken; view: ViewState }> = [];
            for (const { entry, reasons } of ready) {
                this.call(entry, () => {
                    const token = this.token(entry);
                    const metrics = entry.pane.metrics.current;
                    if (!token || !this.valid(entry, token) || metrics?.kind !== 'ready' || metrics.tags.deviceGeneration !== token.deviceGeneration) {
                        entry.renderable = false;
                        return;
                    }
                    frozen.push({ entry, reasons, token, view: entry.pane.camera.beginFrame(frameId) });
                });
            }
            const work: FrameWork[] = [];
            for (const { entry, reasons, token, view } of frozen) {
                this.call(entry, () => {
                    // 3: freeze authoritative scene/live input before retiring any previously wet revision.
                    entry.pane.snapshotScene(view);
                    const layers = Object.freeze(entry.layers.map(layer => Object.freeze({
                        layer, sceneRevision: entry.pane.sceneRevision(layer), critical: entry.pane.isCritical(layer, view),
                    })));
                    const frame = Object.freeze({ frameId, timestamp, intervalMs: this.intervalMs, token, view, layers, reasons });
                    work.push({ entry, frame, hadInput: entry.inputPriority || reasons.includes('input') });
                    entry.inputPriority = false;
                });
            }
            this.deliverAcknowledgements(frameId);
            // 4: reserve 30% input/DOM + 35% encode/submit; actual mandatory overruns cut optional first.
            const elapsedInput = performance.now() - started;
            // Prior encode/submit/overlay cost is mandatory; overrunning it cannot buy optional work.
            const presentationReserve = Math.max(targetMs * 0.35 + Math.max(0, targetMs * 0.30 - elapsedInput), this.presentationMs);
            const prepareMs = Math.max(0, Math.min(targetMs * 0.35,
                targetMs - elapsedInput - presentationReserve - this.maintenanceMs));
            const prepareDeadline = performance.now() + prepareMs;
            meter.deadline = performance.now() + meter.sliceMs;
            const criticalOrder = this.rotate(work, this.criticalCursor++);
            const criticalPending = () => work.some(item => this.call(item.entry,
                () => item.frame.layers.some(meta => item.entry.pane.isCritical(meta.layer, item.frame.view))) === true);
            for (const item of criticalOrder) {
                prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, null, prepareDeadline, true, meter, criticalPending));
            }
            for (const item of criticalOrder) {
                for (const meta of item.frame.layers) {
                    if (meta.critical) prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, meta, prepareDeadline, true, meter, criticalPending));
                }
            }
            const optionalOrder = this.focusFirst(this.rotate(work, this.optionalCursor++));
            const optionalMs = Math.max(0, prepareDeadline - performance.now()) / Math.max(1, work.length);
            for (const item of optionalOrder) {
                item.entry.optionalBytes = Math.min(Math.max(meter.allowance, progressTileBytes),
                    item.entry.optionalBytes + meter.allowance / Math.max(1, work.length));
                const deadline = Math.min(prepareDeadline, performance.now() + optionalMs);
                for (const meta of item.frame.layers) {
                    if (!meta.critical) prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, meta, deadline, false, meter, criticalPending));
                }
            }
            // 5: focus/input first, then rotate neighbours; nobody's mandatory draw is budget-skipped.
            const presentationStarted = performance.now();
            for (const item of this.focusFirst(this.rotate(work, this.encodeCursor++))) {
                this.call(item.entry, () => {
                    if (!this.valid(item.entry, item.frame.token)) return;
                    const encoding = item.entry.pane.encode(item.frame);
                    if (encoding) encodings.push({ work: item, encoding, done: false });
                });
            }
            // 6: publish overlays only for the exact snapshot successfully submitted by its compositor.
            for (const item of encodings) {
                this.call(item.work.entry, () => {
                    if (!this.valid(item.work.entry, item.work.frame.token)) return;
                    const submission = item.encoding.submit();
                    item.done = true;
                    if (!submission) { this.mark(item.work.entry, 'presentation-deferred'); return; }
                    if (!this.valid(item.work.entry, item.work.frame.token)) return;
                    const drawn = Object.freeze(submission.drawn.filter(revision => revision.layer.onFramePresented !== undefined)
                        .map(revision => Object.freeze({ layer: revision.layer, sceneRevision: revision.sceneRevision })));
                    // Preserve a class-backed completion predicate's receiver; object spread would drop
                    // prototype methods and could acknowledge an unfinished submission one frame early.
                    const completed = submission.completed?.bind(submission);
                    if (drawn.length) this.acknowledgements.push({ entry: item.work.entry, frameId, token: item.work.frame.token,
                        submission: completed ? { drawn, completed } : { drawn } });
                    item.work.entry.pane.writeOverlays(item.work.frame);
                });
                if (!item.done) { this.discard(item.work.entry, item.encoding); item.done = true; }
            }
            if (work.length) this.presentationMs = performance.now() - presentationStarted;
            // 7: bounded retirement/compile/readback polls. They never draw a hidden pane.
            const maintenanceStart = performance.now();
            this.runPolls(started + targetMs);
            this.maintenanceMs = performance.now() - maintenanceStart;
        } catch (error) {
            this.stop();
            this.options.onError(null, error);
        } finally {
            for (const item of encodings) if (!item.done) this.discard(item.work.entry, item.encoding);
            const meter = this.meter;
            this.meter = null;
            this.inFrame = false;
            try {
                if (meter) {
                    const elapsedMs = performance.now() - started;
                    const bytes = Math.max(meter.admittedBytes, meter.reportedBytes);
                    // No observed calls is UNKNOWN, not proof that a missing backend hook cost zero.
                    const complete = meter.reportedCalls > 0 && meter.admittedBytes === meter.reportedBytes;
                    const missingMeasurement = !complete && (meter.admittedBytes > 0 || meter.reportedBytes > 0);
                    if (elapsedMs > targetMs || prepareOvershootMs > 0 || bytes > meter.allowance || meter.callMs > meter.sliceMs || missingMeasurement) {
                        this.options.onPressure(Object.freeze({ frameId, targetMs, elapsedMs, prepareOvershootMs,
                            admittedUploadBytes: meter.admittedBytes, uploadByteAllowance: meter.allowance,
                            uploadByteOvershoot: Math.max(0, bytes - meter.allowance), reportedUploadBytes: meter.reportedBytes,
                            reportedUploadCalls: meter.reportedCalls, uploadCallMs: meter.callMs, uploadTimeAllowanceMs: meter.sliceMs,
                            uploadTimeOvershootMs: Math.max(0, meter.callMs - meter.sliceMs), uploadMeasurementsComplete: complete }));
                    }
                }
            } finally { this.refreshWakeTimer(); this.ensureFrame(); }
        }
    };

    private prepare(item: FrameWork, meta: ScheduledLayerSnapshot | null, deadline: number, critical: boolean,
        meter: UploadMeter, criticalPending: () => boolean): number {
        if (performance.now() >= deadline) return 0;
        let overshoot = 0;
        this.call(item.entry, () => {
            const shouldYield = () => !this.valid(item.entry, item.frame.token) || performance.now() >= deadline ||
                (meta !== null && item.entry.pane.isCritical(meta.layer, item.frame.view) !== critical);
            // remainingBytes includes the explicit one-tile progress grant, not a disguised larger cap.
            // The nominal cap stays in the frame meter and any use beyond it is reported as an overrun.
            const availableBytes = () => {
                let remaining = Math.max(0, meter.allowance - Math.max(meter.admittedBytes, meter.reportedBytes));
                if (!meter.progressUsed && meter.admittedBytes === 0 && meter.reportedBytes === 0 && (critical || !criticalPending())) {
                    remaining = Math.max(remaining, progressTileBytes);
                }
                return Math.floor(critical ? remaining : Math.min(remaining, item.entry.optionalBytes));
            };
            const upload = { remainingBytes: availableBytes(), deadline: meter.deadline };
            const budget: FrameBudget = {
                frameId: item.frame.frameId, token: item.frame.token, cameraEpoch: item.frame.view.epoch,
                prepareDeadline: deadline, upload, shouldYield,
                claimUpload: bytes => {
                    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Upload claim must be nonnegative safe bytes');
                    if (shouldYield() || performance.now() >= meter.deadline) return false;
                    const remaining = meter.allowance - Math.max(meter.admittedBytes, meter.reportedBytes);
                    if (!critical && bytes > item.entry.optionalBytes) return false;
                    // §5.6 progress guarantee, vr-lead: optional too after all critical work drains.
                    // At 240Hz ~1MiB is smaller than a 1,056,784-byte tile; DRR alone cannot fix that.
                    const progress = bytes > remaining && !meter.progressUsed && meter.admittedBytes === 0 && meter.reportedBytes === 0 &&
                        bytes <= progressTileBytes && (critical || !criticalPending());
                    if (bytes > remaining && !progress) return false;
                    meter.progressUsed ||= progress;
                    meter.admittedBytes += bytes;
                    if (!critical) item.entry.optionalBytes -= bytes;
                    upload.remainingBytes = availableBytes();
                    return true;
                },
            };
            if (!shouldYield()) {
                if (meta) meta.layer.prepare(item.frame.view, budget);
                else item.entry.pane.prepareFrame(item.frame.view, budget);
            }
            overshoot = Math.max(0, performance.now() - deadline);
        });
        return overshoot;
    }

    private discard(entry: PaneEntry, encoding: ScheduledEncoding): void {
        // Cleanup must run even after unregister; skipping it would retain unsubmitted frame pins.
        try { encoding.discard(); }
        catch (error) { this.options.onError(entry.pane.paneId, error); }
    }

    private deliverAcknowledgements(frameId: number): void {
        const pending = this.acknowledgements;
        this.acknowledgements = [];
        for (const ack of pending) {
            this.call(ack.entry, () => {
                if (!this.valid(ack.entry, ack.token)) return;
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

    private rotate<T>(items: readonly T[], cursor: number): T[] {
        if (!items.length) return [];
        const split = cursor % items.length;
        return [...items.slice(split), ...items.slice(0, split)];
    }

    private focusFirst(work: readonly FrameWork[]): FrameWork[] {
        return [...work.filter(item => item.entry.focused || item.hadInput), ...work.filter(item => !item.entry.focused && !item.hadInput)];
    }

    private runPolls(deadline: number): void {
        let ran = false;
        for (const poll of [...this.polls]) {
            if (!this.running || this.suspended) break;
            if (!this.polls.has(poll) || poll.earliestFrame > this.frameId) continue;
            if (ran && performance.now() >= deadline) break;
            // Rotate persistent work so a tight frame cannot starve later fences. One gets progress.
            this.polls.delete(poll);
            this.polls.add(poll);
            ran = true;
            try { poll.callback(); }
            catch (error) { this.polls.delete(poll); this.options.onError(null, error); }
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
        if (!this.running || this.suspended) { this.clearWakeTimer(); return; }
        const now = performance.now();
        let earliest = Infinity;
        for (const entry of this.panes.values()) {
            for (const [layer, deadline] of entry.wakes) {
                if (deadline <= now) { entry.wakes.delete(layer); entry.reasons.add('deadline'); }
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

    private cancelMotion(entry: PaneEntry): void { entry.motion = null; entry.pane.camera.setMoving(false); }

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
        for (const entry of this.panes.values()) { entry.wakes.clear(); entry.reasons.add('resume-geometry'); }
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
