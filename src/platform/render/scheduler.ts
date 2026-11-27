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

export interface TouchPanSample extends Point { readonly time: number }

export interface ScheduledLayerSnapshot {
    readonly layer: Layer;
    readonly sceneRevision: number;
    readonly critical: boolean;
}

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

export interface PresentedLayerRevision {
    readonly layer: Layer;
    readonly sceneRevision: number;
    readonly token?: FrameToken;
}

export interface ScheduledSubmission {
    readonly drawn: readonly PresentedLayerRevision[];
    readonly completed?: () => boolean;
    readonly superseded?: () => boolean;
    readonly commitObservation?: () => void;
    readonly cancelObservation?: () => void;
}

export interface ScheduledEncoding {
    submit(): ScheduledSubmission | null;
    discard(): void;
}

export interface ScheduledPane {
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
    snapshotScene(view: ViewState): void;
    sceneRevision(layer: Layer): number;
    isCritical(layer: Layer, view: ViewState): boolean;
    layerId?(layer: Layer): string;
    prepareFrame(frame: ScheduledFrame, budget: FrameBudget): void;
    progressUploadBytes?(): number;
    finishPrepareFrame?(frame: ScheduledFrame, budget: FrameBudget): void;
    encode(frame: ScheduledFrame, changed: boolean): ScheduledEncoding | null;
    presentUnchanged(frame: ScheduledFrame): boolean;
    encodeOffscreen?(frame: ScheduledFrame): ScheduledEncoding | null;
    writeOverlays(frame: ScheduledFrame): void;
    benchmarkMemory?(): { memory: Readonly<Record<string, number>>; grants: Readonly<Record<string, number>> };
    recover?(error: unknown): boolean;
    /** Stop input/speculative work and synchronously checkpoint through the session, never await a frame. */
    suspend(reason: 'unregistered' | 'window-hidden' | 'frozen' | 'geometry-dormant' | 'stopped'): void;
}

export interface ScheduledPaneLease {
    invalidate(reason: string, damage?: DamageRecord): void;
    setFocused(focused: boolean): void;
    wakeAt(layer: Layer, deadlineMs: number | null): void;
    startFling(samples: readonly TouchPanSample[]): void;
    animateZoom(targetZ: number, anchor?: Point): void;
    animatePan(delta: Point, durationMs: number): void;
    glideTo(target: Camera, durationMs: number): void;
    cancelMotion(): void;
    dispose(): void;
}

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
const PREPARE_FLOOR_FRACTION = 0.25;
const QUIET_BACKGROUND_FRACTION = 0.5;
const FRAMES_IN_FLIGHT = 3;
function recordInputLatency(stage: 'submit' | 'complete', ms: number): void {
    if (!renderAuditEnabled() || !Number.isFinite(ms)) return;
    auditCount('input', `${stage}:n`);
    auditCount('input', `${stage}:ms-sum`, Math.round(ms));
    auditCount('input', `${stage}:bucket`, 1, { [String(Math.min(12, Math.floor(ms / 17)))]: 1 });
}
const progressTileBytes = (RENDER_CONSTANTS.tileInteriorPixels + 2 * RENDER_CONSTANTS.tileGutterTexels) ** 2 * RENDER_CONSTANTS.decodedRgbaBytesPerPixel;
const PROGRESS_GUTTER_TEXELS = 4;
const progressUploadBytes = (RENDER_CONSTANTS.tileInteriorPixels + 2 * PROGRESS_GUTTER_TEXELS) ** 2 * RENDER_CONSTANTS.decodedRgbaBytesPerPixel;
const PROGRESS_SMALL_BYTES = 64 * 1024;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

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
    presentMs: number;
    inflight: { submission: ScheduledSubmission; inputAt: number | null }[];
    pendingInputAt: number | null;
    motion: Motion | null;
    binding: FrameToken | null;
    damage: DamageAccumulator;
    spareDamage: DamageAccumulator | null;
    fullDamage: boolean;
    foregroundAnswers: Map<Layer, boolean>;
    layerSnapshots: readonly ScheduledLayerSnapshot[] | null;
    presented: { token: FrameToken; view: ViewState; geometry: number } | null;
    lastFrame: number;
    revisionValues: number[];
    revisionKey: string;
}

const NO_REASONS: readonly string[] = Object.freeze([]);


interface DamageBatch { entry: PaneEntry; damage: DamageAccumulator; full: boolean; submitted: boolean;
    pending?: DamageRecord | null;
    skipped?: boolean }
interface PreparingFirst { prepareFirst?(): boolean }
const firstPreparing = (layer: Layer): boolean => (layer as Layer & PreparingFirst).prepareFirst?.() === true;

interface FrameWork { entry: PaneEntry; frame: ScheduledFrame; batch: DamageBatch; geometry: number; hadInput: boolean; platformPrepared: boolean; platformBudget?: FrameBudget;
    skipped: boolean;
    drawnChange: boolean;
    settled: number;
    foreground: Map<Layer, boolean>;
    repaint: boolean;
    cause: string }
const lastPreparedCamera = new WeakMap<Layer, { x: number; y: number; z: number }>();
const sameCamera = (a: ViewState, b: ViewState): boolean => a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
    && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.viewport.dpr === b.viewport.dpr;
const cameraMoved = (layer: Layer, view: ViewState): boolean => {
    const last = lastPreparedCamera.get(layer);
    return !last || last.x !== view.camera.x || last.y !== view.camera.y || last.z !== view.camera.z;
};
interface PendingAcknowledgement { entry: PaneEntry; frameId: number; token: FrameToken; submission: ScheduledSubmission }
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
    criticalToRun?: Set<Layer>;
    byPane?: Map<string, { bytes: number; calls: number; ms: number }>;
}

function sameToken(a: FrameToken, b: FrameToken | null): boolean {
    return b !== null && a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
        a.bytesGeneration === b.bytesGeneration && a.session === b.session &&
        a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}

let schedulerStarted = false;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
function retryDelay(failures: number): number { return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(failures - 1, 5)); }

export class FrameScheduler {
    private readonly panes = new Map<string, PaneEntry>();
    private readonly polls = new Set<ScheduledPoll>();
    private readonly criticalToRun = new Set<Layer>();
    private readonly presentCost = new Map<PaneEntry, number>();
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
    private frameFailures = 0;
    private frameHold: ReturnType<typeof setTimeout> | null = null;
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
            setFocused: (focused: boolean) => {
                if (!this.live(entry) || entry.focused === focused) return;
                entry.focused = focused; this.mark(entry, 'focus');
            },
            wakeAt: (layer: Layer, deadlineMs: number | null) => this.wakeAt(entry, layer, deadlineMs),
            startFling: (samples: readonly TouchPanSample[]) => this.startFling(entry, samples),
            animateZoom: (targetZ: number, anchor?: Point) => this.animateZoom(entry, targetZ, anchor),
            animatePan: (delta: Point, durationMs: number) => this.animatePan(entry, delta, durationMs),
            glideTo: (target: Camera, durationMs: number) => this.glideTo(entry, target, durationMs),
            cancelMotion: () => {
                if (!this.live(entry)) return;
                const moving = entry.motion !== null;
                this.cancelMotion(entry);
                if (moving) this.mark(entry, 'settle');
            },
            dispose: () => this.unregister(entry),
        });
    }

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

    scheduleDeadline(deadline: number, callback: () => void): () => void {
        if (!Number.isFinite(deadline) || deadline < 0) throw new RangeError('Invalid session deadline');
        const item = { deadline, callback };
        this.sessionDeadlines.add(item);
        this.refreshWakeTimer();
        return () => { this.sessionDeadlines.delete(item); this.refreshWakeTimer(); };
    }

    schedulePoll(callback: () => void): () => void {
        const poll: ScheduledPoll = { callback, earliestFrame: this.frameId + 1, failures: 0, retryAt: 0 };
        this.polls.add(poll);
        this.ensureFrame();
        return () => { this.polls.delete(poll); this.ensureFrame(); };
    }

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

    recordUniformUpload(bytes: number, elapsedMs: number): void {
        this.recordUpload(bytes, elapsedMs);
        if (this.meter) this.meter.admittedBytes += bytes;
    }

    setReducedMotion(reduced: boolean): void {
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

    private detach(entry: PaneEntry, frameId: number, batches: DamageBatch[], audit: boolean):
        { entry: PaneEntry; batch: DamageBatch; reasons: readonly string[]; cause: string } {
        const batch: DamageBatch = { entry, damage: entry.damage, full: entry.fullDamage, submitted: false };
        const reasons: readonly string[] = entry.reasons.size ? Object.freeze([...entry.reasons]) : NO_REASONS;
        batches.push(batch);
        entry.damage = entry.spareDamage ?? new DamageAccumulator(); entry.spareDamage = null; entry.fullDamage = false; entry.reasons.clear();
        entry.lastFrame = frameId;
        return { entry, batch, reasons, cause: audit ? this.presentCause(entry, reasons) : '' };
    }

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

    private passedOver(item: FrameWork, meta: ScheduledLayerSnapshot): void {
        const last = this.layerAnswers.get(meta.layer);
        const pending = last === undefined || !last.unchanged || last.revision !== meta.sceneRevision || meta.layer.needsFrame();
        if (pending) item.drawnChange = true;
        else item.settled++;
        if (renderAuditEnabled()) auditCount('pane', 'prepare-passed-over:' + (item.entry.pane.layerId?.(meta.layer) ?? 'unnamed'));
    }

    private pruneInFlight(entry: PaneEntry): void {
        if (entry.inflight.length === 0) return;
        entry.inflight = entry.inflight.filter(({ submission, inputAt }) => {
            if (submission.superseded?.() ?? false) return false;
            if (!(submission.completed?.() ?? false)) return true;
            if (inputAt !== null) recordInputLatency('complete', performance.now() - inputAt);
            return false;
        });
    }

    private unchangedPicture(item: FrameWork): boolean {
        return !item.drawnChange && item.settled === item.frame.layers.length && !item.repaint;
    }

    private recovers(entry: PaneEntry, error: unknown): boolean {
        let handled = false;
        try { handled = entry.pane.recover?.(error) === true; }
        catch { handled = false; }
        if (!handled || !this.live(entry)) return false;
        this.demoted.add(entry);
        this.mark(entry, 'recover');
        return true;
    }

    private presentCause(entry: PaneEntry, reasons: readonly string[]): string {
        if (reasons.includes('input')) return 'input';
        if (entry.motion !== null || entry.pane.isInteracting()) return 'camera';
        if (reasons.includes('deadline')) return 'wake';
        if (reasons.length) return `invalidate:${reasons[0]}`;
        const layer = entry.layers.find(candidate => candidate.needsFrame());
        if (layer) return `needsFrame:${entry.pane.layerId?.(layer) ?? entry.layers.indexOf(layer)}`;
        return 'none';
    }

    private needsWork(): boolean {
        if (this.polls.size || this.acknowledgements.length) return true;
        for (const entry of this.panes.values()) {
            if (entry.reasons.size || entry.motion) return true;
            if (entry.renderable && this.call(entry, () => entry.layers.some(layer => layer.needsFrame()))) return true;
        }
        return false;
    }

    private cancelFrame(): void { if (this.raf !== null) { cancelAnimationFrame(this.raf); this.raf = null; } }

    private holdFrames(ms: number): void {
        if (this.frameHold !== null) clearTimeout(this.frameHold);
        this.cancelFrame();
        this.frameHold = setTimeout(() => { this.frameHold = null; this.ensureFrame(); }, ms);
    }

    private ensureFrame(): void {
        if (this.inFrame || this.frameHold !== null) return;
        if (!this.running || this.suspended) { this.cancelFrame(); return; }
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
            if (renderAuditEnabled() && candidates.length === 0) {
                auditCount('scheduler', this.polls.size ? 'frame:poll' : this.acknowledgements.length ? 'frame:ack' : 'frame:none');
            }
            const ready: Array<{ entry: PaneEntry; reasons: readonly string[]; batch: DamageBatch; cause: string }> = [];
            for (const { entry, batch, reasons, cause } of candidates) {
                this.call(entry, () => {
                    // Discard stale document/view work BEFORE a callback can resize a surface.
                    if (!this.token(entry)) { entry.renderable = false; this.cancelMotion(entry); return; }
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
                    entry.pane.snapshotScene(view);
                    const layers = this.layerSnapshots(entry, view);
                    const revision = this.revisionKey(entry, layers);
                    const tags = { reasonBits: 0, contentRevision: revision.length <= 4096 ? revision : '', cameraEpoch: view.epoch };
                    const previous = entry.presented;
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
            const elapsedInput = performance.now() - started;
            let presentReserve = 0;
            for (const item of work) presentReserve += item.entry.presentMs;
            const foregroundStart = performance.now();
            const foregroundMs = Math.max(targetMs * PREPARE_FLOOR_FRACTION, this.intervalMs - presentReserve - elapsedInput - this.maintenanceMs);
            const prepareDeadline = performance.now() + foregroundMs;
            meter.deadline = prepareDeadline;
            const criticalOrder = this.rotate(work, this.criticalCursor++);
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
                const layers = item.frame.layers;
                const flags = this.call(item.entry, () => layers.some(meta => firstPreparing(meta.layer)) ? layers.map(meta => firstPreparing(meta.layer)) : null) ?? null;
                if (flags) {
                    for (let i = 0; i < layers.length; i++) {
                        if (!flags[i]) continue;
                        const twoPhase = layers[i].layer.twoPhase === true;
                        prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, layers[i], prepareDeadline, twoPhase || layers[i].critical,
                            meter, criticalPending, twoPhase ? 'foreground' : 'single'));
                    }
                }
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
            const quiet = work.every(item => !item.hadInput && item.entry.motion === null && !item.entry.pane.isInteracting());
            const backgroundCap = quiet ? this.intervalMs * QUIET_BACKGROUND_FRACTION : meter.sliceMs;
            const backgroundStart = performance.now();
            const backgroundEnd = performance.now() + Math.min(backgroundCap, Math.max(meter.sliceMs, started + this.intervalMs - presentReserve - performance.now()));
            meter.deadline = backgroundEnd;
            const optionalOrder = this.focusFirst(this.rotate(work, this.optionalCursor++));
            const optionalMs = Math.max(0, backgroundEnd - performance.now()) / Math.max(1, work.length);
            for (const item of optionalOrder) {
                if (!item.platformPrepared) continue;
                item.entry.optionalBytes = Math.min(Math.max(meter.allowance, progressUploadBytes),
                    item.entry.optionalBytes + meter.allowance / Math.max(1, work.length));
                const deadline = Math.min(backgroundEnd, performance.now() + optionalMs);
                for (const meta of item.frame.layers) {
                    if (meta.layer.twoPhase !== true || !item.foreground.has(meta.layer)) continue;
                    prepareOvershootMs = Math.max(prepareOvershootMs, this.prepare(item, meta, deadline, false, meter, criticalPending, 'background'));
                }
            }
            for (const item of work) {
                if (item.skipped && this.valid(item.entry, item.frame.token)) this.mark(item.entry, 'preparation-deferred', true);
            }
            for (const item of criticalOrder) {
                if (item.platformPrepared && item.platformBudget && this.valid(item.entry, item.frame.token)) {
                    this.call(item.entry, () => item.entry.pane.finishPrepareFrame?.(item.frame, item.platformBudget!));
                    prepareOvershootMs = Math.max(prepareOvershootMs, performance.now() - prepareDeadline);
                }
            }
            const presentCost = this.presentCost; presentCost.clear();
            const presentStart = performance.now();
            if (renderAuditEnabled()) {
                auditCount('scheduler', 'foreground-us', Math.round((backgroundStart - foregroundStart) * 1000));
                auditCount('scheduler', 'background-us', Math.round((presentStart - backgroundStart) * 1000));
            }
            if (renderAuditEnabled()) {
                const late = performance.now() - prepareDeadline;
                if (late > 0) auditCount('scheduler', 'present-late-us', Math.round(late * 1000));
            }
            for (const item of this.focusFirst(this.rotate(work, this.encodeCursor++))) {
                const encodeStarted = performance.now();
                this.call(item.entry, () => {
                    if (!item.platformPrepared || !this.valid(item.entry, item.frame.token)) return;
                    if (this.unchangedPicture(item) && item.entry.pane.presentUnchanged(item.frame)) {
                        if (renderAuditEnabled()) { auditCount('pane', 'present-skipped:unchanged'); auditCount('pane', 'skipped:' + item.cause); }
                        item.batch.skipped = true;
                        item.entry.presented = { token: item.frame.token, view: item.frame.view, geometry: item.geometry };
                        item.entry.pane.writeOverlays(item.frame);
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
            for (const item of encodings) {
                const submitStarted = performance.now();
                this.call(item.work.entry, () => {
                    if (!this.valid(item.work.entry, item.work.frame.token)) return;
                    if (item.offscreenOnly) { item.encoding.submit(); item.done = true; return; }
                    const submission = item.encoding.submit();
                    item.done = true;
                    if (!submission) { this.mark(item.work.entry, 'presentation-deferred', true); return; }
                    if (submission.completed) {
                        item.work.entry.inflight.push({ submission, inputAt: item.work.entry.pendingInputAt });
                    }
                    if (item.work.entry.pendingInputAt !== null) {
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
                        for (const reason of item.work.frame.reasons) auditCount('pane', 'present-reason:' + reason);
                    }
                    item.work.entry.presented = { token: item.work.frame.token, view: item.work.frame.view, geometry: item.work.geometry };
                    const drawn = Object.freeze(submission.drawn.filter(revision => revision.layer.onFramePresented !== undefined)
                        .map(revision => Object.freeze({ layer: revision.layer, sceneRevision: revision.sceneRevision,
                            ...(revision.token ? { token: revision.token } : {}) })));
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
            for (const item of work) item.entry.presentMs = 0.8 * item.entry.presentMs + 0.2 * (presentCost.get(item.entry) ?? 0);
            const maintenanceStart = performance.now();
            if (renderAuditEnabled()) for (const entry of this.panes.values()) this.pruneInFlight(entry);
            if (renderAuditEnabled()) auditCount('scheduler', 'submit-us', Math.round((maintenanceStart - submitStart) * 1000));
            this.runPolls(started + targetMs);
            this.maintenanceMs = performance.now() - maintenanceStart;
            if (renderAuditEnabled()) {
                const total = performance.now() - started;
                auditCount('scheduler', 'frame-us', Math.round(total * 1000));
                if (total > this.intervalMs) {
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
            this.frameFailures++;
            if (this.frameFailures === 1) this.options.onError(null, error);
            else if (renderAuditEnabled()) auditCount('scheduler', 'frame-failed');
            this.holdFrames(retryDelay(this.frameFailures));
        } finally {
            for (const item of encodings) if (!item.done) this.discard(item.work.entry, item.encoding);
            for (const batch of batches) if (!batch.submitted && this.live(batch.entry)) {
                const damage = batch.skipped && batch.pending !== undefined ? batch.pending : batch.damage.freeze();
                if (damage) this.mergeDamage(batch.entry.damage, damage);
                batch.entry.fullDamage ||= batch.full;
            }
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
            const requesting = meta !== null ? meta.layer.needsFrame() : item.entry.layers.some(layer => layer.needsFrame());
            const exhausted = performance.now() >= deadline;
            const platform = meta === null;
            if (exhausted && !requesting && !platform) {
                if (renderAuditEnabled() && meta && cameraMoved(meta.layer, item.frame.view)) auditCount('scheduler', 'camera-skipped:' + phase);
                if (!(meta && phase === 'background' && item.foreground.has(meta.layer) && meta.layer.backgroundOwed?.(item.frame.frameId) === false)) item.skipped = true;
                if (renderAuditEnabled()) auditCount('scheduler', 'skip:' + phase);
                if (meta && phase === 'background' && item.foreground.has(meta.layer))
                    lastPreparedCamera.set(meta.layer, { x: item.frame.view.camera.x, y: item.frame.view.camera.y, z: item.frame.view.camera.z });
                if (meta) this.passedOver(item, meta);
                return;
            }
            const limit = exhausted && !platform ? performance.now() + meter.sliceMs : deadline;
            const layerCritical = meta !== null && phase === 'single' ? item.entry.pane.isCritical(meta.layer, item.frame.view) : critical;
            const classYield = critical && !layerCritical;
            const shouldYield = () => !this.valid(item.entry, item.frame.token) || performance.now() >= limit || classYield;
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
                        if (!this.valid(item.entry, item.frame.token)) return false;
                        auditCount('scheduler', 'media:upload-granted', 1, { bytes });
                        item.drawnChange = true;
                        return true;
                    }
                    const refused = (why: string): false => {
                        if (renderAuditEnabled()) auditCount('scheduler', `claim-refused:${why}:${meta ? item.entry.pane.layerId?.(meta.layer) ?? 'unnamed' : 'platform'}`);
                        return false;
                    };
                    if (shouldYield()) return refused(!this.valid(item.entry, item.frame.token) ? 'yield-invalid' : classYield ? 'yield-class' : 'yield-time');
                    if (performance.now() >= meter.deadline) return refused('deadline');
                    const remaining = meter.allowance - Math.max(meter.admittedBytes, meter.reportedBytes);
                    if (!critical && bytes > item.entry.optionalBytes) return refused('optional');
                    const progress = bytes > remaining && !meter.progressUsed && Math.max(meter.admittedBytes, meter.reportedBytes) < PROGRESS_SMALL_BYTES &&
                        bytes <= progressBytes && (critical || !criticalPending());
                    if (bytes > remaining && !progress) return refused(meter.progressUsed ? 'progress-used' : criticalPending() && !critical ? 'critical-pending' : 'remaining');
                    meter.progressUsed ||= progress;
                    meter.admittedBytes += bytes;
                    if (!critical) item.entry.optionalBytes -= bytes;
                    upload.remainingBytes = availableBytes();
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
                    item.foreground.set(meta.layer, answered);
                    if (!answered) {
                        item.drawnChange = true;
                        if (renderAuditEnabled()) auditCount('pane', 'prepare-changed:' + (item.entry.pane.layerId?.(meta.layer) ?? 'unnamed'));
                    }
                } else {
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
                if (phase === 'background' && item.foreground.has(meta.layer))
                    lastPreparedCamera.set(meta.layer, { x: item.frame.view.camera.x, y: item.frame.view.camera.y, z: item.frame.view.camera.z });
                this.passedOver(item, meta);
            }
            overshoot = Math.max(0, performance.now() - deadline);
            if (overshoot > 0 && renderAuditEnabled()) auditCount('scheduler', 'overshoot-us:' + phase, Math.round(overshoot * 1000));
        });
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
                    revision.layer.onFramePresented?.(revision.sceneRevision, revision.token ?? ack.token);
                }
            });
        }
    }

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
            this.polls.delete(poll);
            this.polls.add(poll);
            ran = true;
            try { poll.callback(); poll.failures = 0; }
            catch (error) {
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
        else this.stop();
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
