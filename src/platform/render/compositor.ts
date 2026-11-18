import { auditCount, auditDrawnStart, auditDrawnTake, auditPresent, auditStage, renderAuditEnabled } from './renderAudit';
import type { Rect, ViewState } from '../types';
import type {
    CompositorAppearance, CompositorCoverage, CompositorLayer, CompositorPage, IsolationReservation, PaneCompositor, PaneSurfaceHost, TexturedQuadOptions,
    TexturedQuadSpec,
} from './compositor.types';
import { TEXTURED_QUAD_BATCH_SHADER } from './gfx/webgl2Shaders';
import { paintCanvasIsolation } from './canvas2dContext';
import { paintPageScope, paintWorldScope, paneCssTransform, projectPage } from './compositorProjection';
import { TEXTURED_QUAD_SHADER } from './compositorShader';
import { GpuIsolationPlan } from './gpuIsolationPlan';
import { IsolationShortfall } from './gfx/webgl2Isolation';
import type { ClipToken, CoverageOutput, CoverageToken, DrawableImage, FrameEncoder, GpuPass, GroupToken, PipelineDesc, PipelineHandle, RectI, RgbaP, SamplerHandle, ShaderModule, TargetHandle, TargetLease, TextureHandle, UniformSlice } from './gfx/api';
import type { Webgl2Owner } from './gfx/webgl2';
import type { PageStack } from './pageStack';
import { ArenaError } from './resourceArena';
import type { ScheduledEncoding, ScheduledFrame, ScheduledSubmission } from './scheduler';
import type { ReadySurfaceMetrics, SurfaceCommitTarget } from './surfaceMetrics';
import { allocateSurfaceGeneration } from './surfaceGeneration';
import type { FrameBudget, FrameToken, GpuReleaseReason } from './types';

const benchmarkDomain = __BME_BENCH__ ? await import('./benchmarkPaintDomain') : null;

/** The textured-quad pipeline, typed as PipelineDesc so its literal stencil state stays `enabled: false`. */
/** The shared atlas side (Layer.atlas): one rgba8 target of this size, 17 MB, leased once per frame and shelf-packed. */
const ATLAS_SIZE = 2064;
/** The batch buffer's floor, in floats (64 quads of 8). It never shrinks below this. */
const BATCH_FLOOR_FLOATS = 64 * 8;
/** Batches in a row that used under a quarter of the buffer before it shrinks back to what they need. Measured by reading only:
 * a long idle run after one large batch is the case this covers, and a short dip does not reallocate. */
const BATCH_IDLE_LIMIT = 120;

function quadDescriptor(shader: ShaderModule): PipelineDesc {
    return { shader, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1, blend: 'source-over', alphaToCoverage: false,
        colorWrite: [true, true, true, true], stencil: { enabled: false } };
}


export interface GpuCompositorOptions {
    readonly owner: Webgl2Owner;
    readonly canvas: HTMLCanvasElement;
    /** The pane this compositor draws for, reported to the present audit; absent, the audit reports null. */
    readonly paneId?: string;
    /** Runtime's budgeted, generation-checked broker-grant route, NOT raw owner.resizeSurface. */
    readonly target: SurfaceCommitTarget;
    readonly invalidate: (reason: string) => void;
    readonly onError: (error: unknown) => void;
    readonly onDeferred?: () => void;
}

interface Snapshot {
    readonly view: ViewState;
    readonly layers: readonly CompositorLayer[];
    readonly layout: Readonly<PageStack> | null;
    readonly appearance: CompositorAppearance;
    readonly metrics: ReadySurfaceMetrics | null;
}
interface Prepared { readonly frameId: number; readonly token: FrameToken; readonly snapshot: Snapshot }
interface DrawScope { readonly encoder: FrameEncoder; readonly view: ViewState; readonly passes: Set<GpuPass> }

function sameToken(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration &&
        a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function validRect(rect: Rect): boolean {
    return [rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite) &&
        rect.width >= 0 && rect.height >= 0;
}
function envelope(rect: Rect, width: number, height: number): RectI {
    const x = Math.min(width, Math.max(0, Math.floor(rect.x)));
    const y = Math.min(height, Math.max(0, Math.floor(rect.y)));
    return { x, y, width: Math.max(0, Math.min(width, Math.ceil(rect.x + rect.width)) - x),
        height: Math.max(0, Math.min(height, Math.ceil(rect.y + rect.height)) - y) };
}

/** A layer cannot end the compositor's pass or pop another layer's clips/groups (C4.3:544–547).
 * Unbalanced scope rejects the encode instead of silently changing the next layer's picture.
 */
function layerPass(pass: GpuPass): { pass: GpuPass; finish(): void } {
    const scopes: Array<{ kind: 'clip'; token: ClipToken } | { kind: 'group'; token: GroupToken } | { kind: 'coverage' | 'area'; token: CoverageToken }> = [];
    let active = true;
    const check = () => { if (!active) throw new ArenaError('aborted'); };
    const pop = (kind: 'clip' | 'group' | 'coverage' | 'area', token: ClipToken | GroupToken | CoverageToken) => {
        check();
        const top = scopes.at(-1);
        if (!top || top.kind !== kind || top.token !== token) throw new ArenaError('invalid-input');
        scopes.pop();
    };
    return {
        pass: {
            draw: command => { check(); pass.draw(command); },
            acquireTarget: desc => { check(); return pass.acquireTarget(desc); },
            releaseTarget: lease => { check(); pass.releaseTarget(lease); },
            pushClip: clip => { check(); const token = pass.pushClip(clip); scopes.push({ kind: 'clip', token }); return token; },
            popClip: token => { pop('clip', token); pass.popClip(token); },
            beginGroup: (bounds, options) => {
                check(); const token = pass.beginGroup(bounds, options); scopes.push({ kind: 'group', token }); return token;
            },
            endGroup: token => { pop('group', token); pass.endGroup(token); },
            beginCoverage: (target, bounds) => {
                check(); const token = pass.beginCoverage(target, bounds); scopes.push({ kind: 'coverage', token }); return token;
            },
            endCoverage: (token, output) => { pop('coverage', token); pass.endCoverage(token, output); },
            beginArea: (target, bounds) => {
                check(); const token = pass.beginArea(target, bounds); scopes.push({ kind: 'area', token }); return token;
            },
            endArea: (token, output) => { pop('area', token); pass.endArea(token, output); },
            composite: (source, bounds, options) => { check(); pass.composite(source, bounds, options); },
            end: () => { check(); throw new ArenaError('invalid-input'); },
        },
        finish: () => { active = false; if (scopes.length) throw new ArenaError('invalid-input'); },
    };
}

/** Normal frames draw directly to the stencil-less displayed surface (design §4, §10).
 * Lifecycle owns layers, native contexts and surface reservations. This object only borrows layers,
 * freezes their bindings, and owns its helper handles and unsubmitted encoders (C4.1–C4.3).
 */
export class GpuCompositor implements PaneCompositor {
    readonly backend = 'webgl2' as const;
    readonly surface: HTMLCanvasElement;
    readonly target: SurfaceCommitTarget;
    readonly resources: PaneCompositor['resources'];
    readonly #options: GpuCompositorOptions;
    #surfaceGeneration = allocateSurfaceGeneration();
    #host: PaneSurfaceHost | null = null;
    #layers: readonly CompositorLayer[] = [];
    #layout: Readonly<PageStack> | null = null;
    #appearance: CompositorAppearance = { background: [0, 0, 0, 1], inverted: false };
    #metrics: ReadySurfaceMetrics | null = null;
    #snapshot: Snapshot | null = null;
    #prepared: Prepared | null = null;
    #isolationPlan: GpuIsolationPlan | null = null;
    #isolationReadyFrame = -1;
    #shortfalls: IsolationShortfall[] = [];
    #active: DrawScope | null = null;
    #lastSubmissionSerial = 0;
    /** Audit only: the camera scale at this compositor's previous encode, for the present's zooming flag. */
    #lastScale: number | null = null;
    #quad: PipelineHandle | null = null;
    #batchQuad: PipelineHandle | null = null;
    #nearest: SamplerHandle | null = null;
    #linear: SamplerHandle | null = null;
    #compiling: Promise<void> | null = null;
    #epoch = 0;
    #disposed = false;
    #available = true;
    #retryPending = false;
    #report: CompositorCoverage | null = null;
    readonly #encodings = new Set<FrameEncoder>();
    readonly #quadData = new Float32Array(16);
    /** Batched quads: one instance record (dst x0,y0,x1,y1 and src x,y,w,h) per quad, grown to the largest batch so far, and the batch's uniform block. */
    #batchData = new Float32Array(BATCH_FLOOR_FLOATS);
    /** Consecutive batches that used less than a quarter of the buffer; the buffer shrinks after BATCH_IDLE_LIMIT of them. */
    #batchIdle = 0;
    readonly #batchUniforms = new Float32Array(16);
    /** This frame's atlas (Layer.atlas): its lease and shelf cursor, created by the first atlas tile; null until then. */
    #atlas: { lease: TargetLease | null; x: number; y: number; rowH: number } | null = null;
    /** Layer tile texture → its region of the atlas, for the samples that follow in this frame. */
    readonly #atlasRegions = new Map<TextureHandle, { texture: TextureHandle; x: number; y: number }>();

    constructor(options: GpuCompositorOptions) {
        if (options.target.generation !== options.owner.resources.generation || options.target.limits !== options.owner.limits) {
            throw new ArenaError('invalid-input');
        }
        this.#options = options;
        this.surface = options.canvas;
        this.target = options.target;
        const currentDevice = () => !this.#disposed && this.#available ? options.owner.resources : null;
        this.resources = Object.freeze({ owner: this,
            get device() { return currentDevice(); },
            reserveIsolation: (reservation: IsolationReservation) => {
                if (!this.#isolationPlan) throw new ArenaError('invalid-input');
                this.#isolationPlan.declare(reservation);
            },
            paintIsolation: paintCanvasIsolation,
            uniforms: (bytes: ArrayBufferView) => this.uniforms(bytes),
            uniformsInto: (bytes: ArrayBufferView, into: UniformSlice) => this.uniformsInto(bytes, into),
            drawTexturedQuad: this.drawTexturedQuad.bind(this) as PaneCompositor['resources']['drawTexturedQuad'],
            drawTexturedQuads: this.drawTexturedQuads.bind(this) as PaneCompositor['resources']['drawTexturedQuads'] });
    }

    get captureIdle(): boolean {
        if (this.#disposed || !this.#available || this.#active || this.#encodings.size || !this.#lastSubmissionSerial) return false;
        try { return this.#options.owner.resources.completed(this.#lastSubmissionSerial); }
        catch { return false; }
    }

    get surfaceGeneration(): number { return this.#surfaceGeneration; }
    get retryPending(): boolean { return this.#retryPending; }

    attach(host: PaneSurfaceHost): void {
        this.#check();
        if (this.#host && this.#host !== host) this.detach();
        this.#host = host;
        host.attach(this.surface);
    }

    detach(): void {
        const host = this.#host;
        this.#host = null;
        host?.detach(this.surface);
    }

    setLayers(layers: readonly CompositorLayer[]): void {
        this.#check();
        const ids = new Set<string>();
        const objects = new Set<CompositorLayer['layer']>();
        let chrome = false;
        this.#layers = Object.freeze(layers.map(binding => {
            if (!binding.id || ids.has(binding.id) || objects.has(binding.layer) ||
                !['document', 'chrome'].includes(binding.group) || chrome && binding.group === 'document') {
                throw new ArenaError('invalid-input');
            }
            ids.add(binding.id); objects.add(binding.layer); chrome ||= binding.group === 'chrome';
            if (binding.isolation && (!Number.isFinite(binding.isolation.opacity) || binding.isolation.opacity < 0 ||
                binding.isolation.opacity > 1 || !['normal', 'multiply'].includes(binding.isolation.blend))) {
                throw new ArenaError('invalid-input');
            }
            // Keep callback receiver semantics without reading the caller's mutable binding again. `critical` is copied too: the
            // refusal gate reads it, and a copy without it reads every incomplete layer as critical (measured on the large drawing:
            // the board's definition answered no, yet each incomplete band refused the frame, because the copy had dropped it).
            return Object.freeze({ id: binding.id, layer: binding.layer, group: binding.group,
                isolation: binding.isolation ? Object.freeze({ ...binding.isolation }) : undefined,
                coverage: binding.coverage.bind(binding),
                ...(binding.critical ? { critical: binding.critical.bind(binding) } : {}),
                ...(__BME_BENCH__ && binding.benchmarkDomain ? { benchmarkDomain: binding.benchmarkDomain.bind(binding) } : {}) });
        }));
    }

    setLayout(stack: Readonly<PageStack> | null): void {
        this.#check();
        if (!stack) { this.#layout = null; return; }
        if (!Number.isFinite(stack.width) || !Number.isFinite(stack.height) || stack.width < 0 || stack.height < 0 ||
            stack.rects.some(rect => !validRect(rect))) throw new ArenaError('invalid-input');
        this.#layout = Object.freeze({ width: stack.width, height: stack.height,
            rects: Object.freeze(stack.rects.map(rect => Object.freeze({ ...rect }))) as unknown as PageStack['rects'] });
    }

    setAppearance(appearance: CompositorAppearance): void {
        this.#check();
        if (appearance.background.length !== 4 || appearance.background.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
            appearance.background[3] !== 1) throw new ArenaError('invalid-input');
        this.#appearance = Object.freeze({ background: Object.freeze([...appearance.background]) as CompositorAppearance['background'],
            inverted: appearance.inverted });
    }

    setMetrics(metrics: ReadySurfaceMetrics): void {
        this.#check();
        if (metrics.limits !== this.target.limits || metrics.backingWidth !== this.surface.width || metrics.backingHeight !== this.surface.height) {
            throw new ArenaError('invalid-input');
        }
        if (!this.#metrics || this.#metrics.backingWidth !== metrics.backingWidth || this.#metrics.backingHeight !== metrics.backingHeight) {
            this.#surfaceGeneration = allocateSurfaceGeneration();
            this.#report = null;
        }
        this.#metrics = metrics;
        this.#available = true;
    }

    snapshot(view: ViewState): void {
        this.#check();
        this.#snapshot = { view, layers: this.#layers, layout: this.#layout, appearance: this.#appearance, metrics: this.#metrics };
        this.#prepared = null;
    }

    prepareFrame(frame: ScheduledFrame, budget: FrameBudget): void {
        this.#check();
        if (!renderAuditEnabled()) { this.#prepare(frame, budget); return; }
        const started = performance.now();
        try { this.#prepare(frame, budget); }
        finally { auditStage('compositor', 'prepare', performance.now() - started); }
    }

    #prepare(frame: ScheduledFrame, budget: FrameBudget): void {
        const snapshot = this.#snapshot;
        this.#isolationPlan = null;
        this.#isolationReadyFrame = -1;
        if (!snapshot || !snapshot.metrics || snapshot.view !== frame.view || budget.cameraEpoch !== frame.view.epoch ||
            budget.frameId !== frame.frameId || !sameToken(budget.token, frame.token) ||
            budget.token.deviceGeneration !== this.target.generation) { auditCount('compositor', 'refuse:prepare-gate'); return; }
        this.#prepared = { frameId: budget.frameId, token: Object.freeze({ ...budget.token }), snapshot };
        const plan = new GpuIsolationPlan(snapshot.metrics.backingWidth, snapshot.metrics.backingHeight);
        const inverted = snapshot.appearance.inverted;
        if (inverted) plan.own(1, false);
        const full = { x: 0, y: 0, width: snapshot.metrics.backingWidth, height: snapshot.metrics.backingHeight };
        for (const binding of snapshot.layers) {
            if (!binding.isolation) continue;
            plan.own((inverted && binding.group === 'document' ? 1 : 0) + 1,
                binding.isolation.blend === 'multiply', binding.isolation.bounds?.(frame) ?? full);
        }
        // Admitted at prepare, like every other target: the frame borrows the atlas from these slots and never allocates it.
        if (snapshot.layers.some(binding => binding.layer.atlas === true)) {
            const bounds = { x: 0, y: 0, width: ATLAS_SIZE, height: ATLAS_SIZE };
            plan.declare({ depth: 0, maskDepth: 0, bounds, targets: { count: 1, bounds } });
        }
        for (const shortfall of this.#shortfalls) plan.shortfall(shortfall);
        this.#isolationPlan = plan;
        try {
            if (!this.#options.owner.frameResourcesReady && !budget.claimUpload(1)) {
                auditCount('compositor', 'refuse:frame-resources'); this.#options.invalidate('gpu-frame-resources-deferred'); return;
            }
            this.#options.owner.prepareFrameResources(); this.#prepareQuad();
            if (benchmarkDomain) this.#options.owner.prepareCoverageFrame?.({ frameId: frame.frameId, token: frame.token,
                cameraEpoch: frame.view.epoch, sceneRevision: frame.damage.contentRevision },
                benchmarkDomain.benchmarkPaintDomain(snapshot, frame, 'webgl2'), () => this.#options.invalidate('coverage-ready'));
        } catch (error) { this.#failure(error); }
    }

    finishPrepareFrame(frame: ScheduledFrame, budget: FrameBudget): void {
        const plan = this.#isolationPlan;
        this.#isolationPlan = null;
        if (!plan || !this.#prepared || this.#prepared.frameId !== frame.frameId || !sameToken(this.#prepared.token, frame.token) ||
            !this.#options.owner.frameResourcesReady) { auditCount('compositor', 'refuse:finish-gate'); return; }
        // Admission only reserves the frame's isolation targets, and without it no frame can present. Deferring it to a
        // frame whose optional prepare window was left over never came while a live stroke used that window each frame
        // (measured: 49 of 115 refused notebook frames in one stroke).
        try {
            if (!this.#options.owner.admitIsolation(plan.finish())) {
                auditCount('compositor', 'refuse:isolation-budget');
                // A budget refusal defers and retries; reporting it as an error demoted the pane to canvas2d for good.
                this.#failure(new ArenaError('out-of-budget'));
                return;
            }
            this.#isolationReadyFrame = frame.frameId;
        } catch (error) {
            if (error instanceof ArenaError && error.code === 'out-of-budget') auditCount('compositor', 'refuse:isolation-budget');
            this.#failure(error);
        }
    }

    encode(frame: ScheduledFrame): ScheduledEncoding | null {
        this.#check();
        const prepared = this.#prepared;
        const snapshot = this.#snapshot;
        if (!prepared || !snapshot || !this.#quad || !this.#nearest || !this.#linear || !snapshot.metrics ||
            prepared.snapshot !== snapshot || snapshot.view !== frame.view || prepared.frameId !== frame.frameId || this.#isolationReadyFrame !== frame.frameId ||
            !sameToken(prepared.token, frame.token) || !this.#drawable(snapshot, frame)) {
            if (renderAuditEnabled()) auditCount('compositor', `refuse:${!prepared ? 'unprepared' : !this.#quad ? 'quad' : prepared.snapshot !== snapshot ? 'snapshot'
                : snapshot?.view !== frame.view ? 'view' : prepared.frameId !== frame.frameId ? 'frame-id'
                : this.#isolationReadyFrame !== frame.frameId ? 'isolation' : !sameToken(prepared.token, frame.token) ? 'token' : 'drawable'}`);
            return null;
        }
        let encoder: FrameEncoder | null = null;
        // Audit only: `frame` spans encode to presentation, as the pane's own frame timer does; off, no clock is read.
        const timed = renderAuditEnabled();
        const encodeStarted = timed ? performance.now() : 0;
        try {
            const zooming = timed && this.#zoomStep(frame.view.camera.z);
            if (timed) auditDrawnStart();
            const coverage = snapshot.layers.map(binding => binding.coverage(frame, this.backend));
            // Only a critical layer's missing content refuses the frame. A non-critical layer presents with its stand-in (what it
            // drew), so one incomplete layer cannot hold back every other layer on a quiet board (PLAN issue 3, the 0-presents class).
            let refuse = false;
            for (let i = 0; i < coverage.length; i++) {
                if (coverage[i].complete) continue;
                const layer = snapshot.layers[i];
                if (layer.critical?.(frame) === false) { if (renderAuditEnabled()) auditCount(layer.id, 'standin'); continue; }
                refuse = true;
                if (renderAuditEnabled()) auditCount(layer.id, 'incomplete');
            }
            if (refuse) {
                auditCount('compositor', 'refuse:coverage');
                const refused = this.#encodeRefused(snapshot, frame);
                if (timed) {
                    const tally = auditDrawnTake();
                    auditPresent({ pane: this.#options.paneId ?? null, frame: frame.frameId, rawTick: frame.timestamp, backend: this.backend,
                        layersComplete: false, canvas: null, standIns: tally.standIns, standInsRaster: tally.standInsRaster, holes: tally.holes,
                        zooming, refusal: 'coverage' });
                }
                return refused;
            }
            encoder = this.#options.owner.resources.beginFrame();
            this.#encodings.add(encoder);
            const bounds = { x: 0, y: 0, width: snapshot.metrics.backingWidth, height: snapshot.metrics.backingHeight };
            const drawScope: DrawScope = { encoder, view: frame.view, passes: new Set() };
            this.#active = drawScope;
            // Every layer's offscreen passes are recorded before the surface pass; the frame replays independent ones grouped
            // by program and target (webgl2Frame.ts #order), since a layer's own draws are not reordered here.
            let offscreen = 0;
            this.#atlas = null;
            this.#atlasRegions.clear();
            try { offscreen = this.#encodeOffscreen(snapshot, frame, encoder, drawScope); } finally { this.#active = null; }
            auditCount('compositor', 'offscreen-passes', offscreen);
            const pass = encoder.beginPass({ target: 'surface', viewport: bounds,
                load: { kind: 'clear', color: snapshot.appearance.background }, store: 'store' });
            this.#active = drawScope;
            let document: GroupToken | null = null;
            try {
                // Invert the COMPOSITED page+ink once; chrome remains outside (C2.5; design §4.1).
                for (const binding of snapshot.layers) {
                    if (binding.group === 'chrome' && document) { pass.endGroup(document); document = null; }
                    if (binding.group === 'document' && snapshot.appearance.inverted && !document) {
                        document = pass.beginGroup(bounds, { opacity: 1, blend: 'normal', colourEffect: 'page-invert' });
                    }
                    const effect = binding.isolation;
                    const effectBounds = effect?.bounds?.(frame) ?? bounds;
                    if (![effectBounds.x, effectBounds.y, effectBounds.width, effectBounds.height].every(value => Number.isSafeInteger(value) && value >= 0)) {
                        throw new ArenaError('invalid-input');
                    }
                    const isolation = effect ? pass.beginGroup(effectBounds,
                        { opacity: effect.opacity, blend: effect.blend, colourEffect: 'none' }) : null;
                    const scope = layerPass(pass);
                    drawScope.passes.add(scope.pass);
                    const auditId = (binding as { id?: string }).id ?? 'layer';
                    auditCount(auditId, 'gpu-layer');
                    // Audit only: count the layer's own draw calls (quads included; gpu-draw minus gpu-quad is its shader work).
                    const layerTarget = renderAuditEnabled() ? new Proxy(scope.pass, { get(target, key) {
                        const value = Reflect.get(target, key, target) as unknown;
                        if (key === 'draw' && typeof value === 'function') return (cmd: unknown) => { auditCount(auditId, 'gpu-draw'); return (value as (c: unknown) => void).call(target, cmd); };
                        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
                    } }) : scope.pass;
                    // The layer receives the audit view, so the scope must admit that same object: drawTexturedQuad checks identity.
                    drawScope.passes.add(layerTarget);
                    const drawStarted = timed ? performance.now() : 0;
                    try { binding.layer.drawGpu(layerTarget, frame.view); }
                    finally {
                        drawScope.passes.delete(layerTarget); drawScope.passes.delete(scope.pass); scope.finish();
                        if (timed) auditStage(auditId, 'draw', performance.now() - drawStarted);
                    }
                    if (isolation) pass.endGroup(isolation);
                }
                if (document) pass.endGroup(document);
                pass.end();
            } finally { this.#active = null; }
            const tally = timed ? auditDrawnTake() : null;
            const owned = encoder;
            let done = false;
            const epoch = this.#epoch;
            return {
                submit: (): ScheduledSubmission | null => {
                    if (done || this.#disposed || epoch !== this.#epoch || !this.#drawable(snapshot, frame)) {
                        this.#options.owner.discardFrame(owned);
                        this.#encodings.delete(owned);
                        done = true;
                        return null;
                    }
                    try {
                        const submitStarted = timed ? performance.now() : 0;
                        const submitted = owned.submit();
                        auditCount('compositor', 'gl:state', submitted.stateSwitches);
                        if (timed) {
                            const now = performance.now();
                            auditStage('compositor', 'submit', now - submitStarted);
                            auditStage('compositor', 'frame', now - encodeStarted);
                        }
                        this.#lastSubmissionSerial = submitted.serial;
                        // Publish the canonical CSS extent with the completed framebuffer, not
                        // during metrics preparation while the previous picture is still displayed.
                        this.surface.style.width = `${snapshot.metrics!.viewport.width}px`;
                        this.surface.style.height = `${snapshot.metrics!.viewport.height}px`;
                        done = true;
                        this.#encodings.delete(owned);
                        this.#retryPending = false;
                        this.#shortfalls = [];
                        this.#report = Object.freeze({ frameId: frame.frameId, token: Object.freeze({ ...frame.token }), presented: true,
                            complete: true, sharp: snapshot.metrics!.qualityScale === 1 && coverage.every(item => item.sharp && !item.staleVersion),
                            staleVersion: coverage.some(item => item.staleVersion),
                            qualityScale: snapshot.metrics!.qualityScale });
                        if (tally) auditPresent({ pane: this.#options.paneId ?? null, frame: frame.frameId, rawTick: frame.timestamp,
                            backend: this.backend, layersComplete: coverage.every(item => item.complete), canvas: this.surface,
                            standIns: tally.standIns, standInsRaster: tally.standInsRaster, holes: tally.holes, zooming, refusal: null });
                        return { drawn: frame.layers.filter(meta => snapshot.layers.some(binding => binding.layer === meta.layer))
                            .map(meta => ({ layer: meta.layer, sceneRevision: meta.sceneRevision })),
                        completed: () => !this.#disposed && epoch === this.#epoch && this.#options.owner.resources.completed(submitted.serial),
                        superseded: () => this.#disposed || epoch !== this.#epoch,
                        ...(__BME_BENCH__ ? { commitObservation: () => this.#options.owner.commitCoverage?.(submitted.serial),
                            cancelObservation: () => this.#options.owner.cancelCoverage?.(submitted.serial) } : {}) };
                    } catch (error) {
                        done = true;
                        this.#encodings.delete(owned);
                        this.#options.owner.discardFrame(owned);
                        this.#failure(error);
                        throw error;
                    }
                },
                discard: () => {
                    if (done) return;
                    done = true;
                    this.#encodings.delete(owned);
                    this.#options.owner.discardFrame(owned);
                },
            };
        } catch (error) {
            if (encoder) { this.#encodings.delete(encoder); this.#options.owner.discardFrame(encoder); }
            this.#failure(error);
            return null;
        }
    }

    /** Audit only: whether the camera scale moved since the previous encode, then remembers this one. */
    #zoomStep(scale: number): boolean {
        const zooming = this.#lastScale !== null && scale !== this.#lastScale;
        this.#lastScale = scale;
        return zooming;
    }

    /** A refused frame still encodes every layer's offscreen passes and submits them, so the tiles they compose land and a later
     * frame can complete; only the surface pass is skipped. Measured in the notebook pan: 205 refused frames, 1640 tile encodings
     * and no tile completed, because a refused frame encoded nothing. No report is set for this frame, so coverage() answers
     * presented: false and the pane never claims it. */
    #encodeRefused(snapshot: Snapshot, frame: ScheduledFrame): ScheduledEncoding | null {
        let encoder: FrameEncoder | null = null;
        try {
            encoder = this.#options.owner.resources.beginFrame();
            this.#encodings.add(encoder);
            const drawScope: DrawScope = { encoder, view: frame.view, passes: new Set() };
            this.#active = drawScope;
            let offscreen = 0;
            this.#atlas = null;
            this.#atlasRegions.clear();
            try { offscreen = this.#encodeOffscreen(snapshot, frame, encoder, drawScope); } finally { this.#active = null; }
            if (!offscreen) {
                this.#encodings.delete(encoder); this.#options.owner.discardFrame(encoder);
                return null;
            }
            auditCount('compositor', 'offscreen-on-refuse', offscreen);
            const owned = encoder;
            let done = false;
            const epoch = this.#epoch;
            return {
                submit: (): ScheduledSubmission | null => {
                    if (done || this.#disposed || epoch !== this.#epoch || !this.#drawable(snapshot, frame)) {
                        this.#options.owner.discardFrame(owned);
                        this.#encodings.delete(owned);
                        done = true;
                        return null;
                    }
                    try {
                        const submitted = owned.submit();
                        auditCount('compositor', 'gl:state', submitted.stateSwitches);
                        this.#lastSubmissionSerial = submitted.serial;
                        done = true;
                        this.#encodings.delete(owned);
                        return { drawn: [] };
                    } catch (error) {
                        done = true;
                        this.#encodings.delete(owned);
                        this.#options.owner.discardFrame(owned);
                        this.#failure(error);
                        throw error;
                    }
                },
                discard: () => {
                    if (done) return;
                    done = true;
                    this.#encodings.delete(owned);
                    this.#options.owner.discardFrame(owned);
                },
            };
        } catch (error) {
            if (encoder) { this.#encodings.delete(encoder); this.#options.owner.discardFrame(encoder); }
            this.#failure(error);
            return null;
        }
    }

    coverage(frame: ScheduledFrame): CompositorCoverage {
        const report = this.#report;
        if (report && report.frameId === frame.frameId && sameToken(report.token, frame.token)) return report;
        return { frameId: frame.frameId, token: frame.token, presented: false, complete: false, sharp: false,
            qualityScale: this.#snapshot?.metrics?.qualityScale ?? this.#metrics?.qualityScale ?? 1 };
    }

    page(view: ViewState, index: number): CompositorPage | null {
        return projectPage(this.#snapshot?.view === view ? this.#snapshot.layout : this.#layout, view, index);
    }
    paneTransform(view: ViewState, frameId: number) {
        const prepared = this.#prepared;
        if (!prepared || prepared.frameId !== frameId || prepared.snapshot !== this.#snapshot) return null;
        return paneCssTransform(view, prepared.snapshot.view, prepared.snapshot.metrics);
    }
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void { paintWorldScope(ctx, view, paint); }
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void {
        paintPageScope(ctx, this.page(view, index), paint);
    }

    /** Capture uses the same generation/ring and layer-host helpers as an onscreen frame,
     * but never touches its surface or presentation state (C4.5; design §4.6).
     */
    withCapturePass(encoder: FrameEncoder, pass: GpuPass, view: ViewState, paint: (scope: GpuPass) => void): void {
        this.#check();
        if (this.#active || !this.#available || !this.#quad || !this.#linear || !this.#nearest) throw new ArenaError('out-of-budget');
        const scoped = layerPass(pass);
        this.#active = { encoder, view, passes: new Set([scoped.pass]) };
        try { paint(scoped.pass); }
        finally { this.#active = null; scoped.finish(); }
    }

    /** Host methods are scoped capabilities, not retained access to a previous frame's ring (C4.3). */
    uniforms(bytes: ArrayBufferView): UniformSlice {
        if (!this.#active || !this.#active.passes.size) throw new ArenaError('invalid-input');
        return this.#active.encoder.uniforms(bytes);
    }

    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void {
        if (!this.#active || !this.#active.passes.size) throw new ArenaError('invalid-input');
        this.#active.encoder.uniformsInto(bytes, into);
    }

    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: DrawableImage, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(pass: GpuPass | CanvasRenderingContext2D, texture: TextureHandle | DrawableImage,
        sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void {
        if ('drawImage' in pass) {
            if (!validRect(sourceRect) || !validRect(destRect) || !Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1 ||
                !['nearest', 'linear'].includes(options.sampling)) throw new ArenaError('invalid-input');
            if (!sourceRect.width || !sourceRect.height || !destRect.width || !destRect.height || !options.opacity) return;
            pass.save();
            try {
                pass.resetTransform();
                pass.globalAlpha *= options.opacity;
                pass.imageSmoothingEnabled = options.sampling === 'linear';
                pass.drawImage(texture as DrawableImage, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height,
                    destRect.x, destRect.y, destRect.width, destRect.height);
            } finally { pass.restore(); }
            return;
        }
        const gpuTexture = texture as TextureHandle;
        const active = this.#active;
        if (!active || !active.passes.has(pass) || !this.#quad || !this.#linear || !this.#nearest) throw new ArenaError('invalid-input');
        const opacity = options.opacity ?? 1;
        if (!validRect(sourceRect) || !validRect(destRect) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 ||
            options.sampling !== undefined && !['nearest', 'linear'].includes(options.sampling)) throw new ArenaError('invalid-input');
        const info = this.#options.owner.textureInfo(gpuTexture);
        if (info.format !== 'rgba8' || sourceRect.x < info.usedRect.x || sourceRect.y < info.usedRect.y ||
            sourceRect.x + sourceRect.width > info.usedRect.x + info.usedRect.width ||
            sourceRect.y + sourceRect.height > info.usedRect.y + info.usedRect.height) throw new ArenaError('invalid-input');
        if (!sourceRect.width || !sourceRect.height || !destRect.width || !destRect.height || !opacity) return;
        const width = Math.round(active.view.viewport.width * active.view.viewport.dpr);
        const height = Math.round(active.view.viewport.height * active.view.viewport.dpr);
        const scissor = envelope(destRect, width, height);
        if (!scissor.width || !scissor.height) return;
        // A tile drawn into the shared atlas is sampled from its region: the same texels, shifted by the region's origin.
        const region = this.#atlasRegions.get(gpuTexture);
        const sampledTexture = region ? region.texture : gpuTexture;
        const sampled = region ? this.#options.owner.textureInfo(region.texture) : info;
        const sample = region ? { x: sourceRect.x + region.x, y: sourceRect.y + region.y, width: sourceRect.width, height: sourceRect.height } : sourceRect;
        if (region) auditCount('compositor', 'atlas-sample');
        this.#quadData.set([0, 0, width, height, destRect.x, destRect.y, destRect.x + destRect.width, destRect.y + destRect.height,
            sample.x, sample.y, sample.width, sample.height, sampled.width, sampled.height, opacity,
            __BME_BENCH__ ? options.coverage === 'current' ? 3 : options.coverage === 'standin' ? 2 : 0 : 0]);
        const slice = this.uniforms(this.#quadData);
        pass.draw({ pipeline: this.#quad, vertices: [], first: 0, count: 4, instances: 1, scissor,
            ...(__BME_BENCH__ && options.coverage && options.coverage !== 'none' ? {
                coverageClass: options.coverage === 'standin' ? 2 as const : 3 as const,
                ...(options.coverage === 'standin' ? { standInRatio: options.standInRatio ?? Math.min(1,
                    sourceRect.width / destRect.width, sourceRect.height / destRect.height) } : {}),
            } : {}),
            bindings: { uniforms: [{ binding: 0, slice }], textures: [{ binding: 0, texture: sampledTexture,
                sampler: options.sampling === 'nearest' ? this.#nearest : this.#linear }] } });
    }

    /** Several quads of one texture, in one instanced draw. The same options apply to every quad, and each quad is validated
     * and clipped exactly as drawTexturedQuad does. A canvas target loops its drawImage: each quad is one drawImage, as before. */
    drawTexturedQuads(pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    drawTexturedQuads(ctx: CanvasRenderingContext2D, image: DrawableImage, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    drawTexturedQuads(pass: GpuPass | CanvasRenderingContext2D, texture: TextureHandle | DrawableImage,
        quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void {
        if ('drawImage' in pass) {
            for (const quad of quads) this.drawTexturedQuad(pass, texture as DrawableImage, quad.sourceRect, quad.destRect, options);
            return;
        }
        const gpuTexture = texture as TextureHandle;
        const active = this.#active;
        const pipeline = this.#batchQuad;
        if (!active || !active.passes.has(pass) || !pipeline || !this.#linear || !this.#nearest) throw new ArenaError('invalid-input');
        const opacity = options.opacity ?? 1;
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 ||
            options.sampling !== undefined && !['nearest', 'linear'].includes(options.sampling)) throw new ArenaError('invalid-input');
        const info = this.#options.owner.textureInfo(gpuTexture);
        if (info.format !== 'rgba8') throw new ArenaError('invalid-input');
        // An atlas tile's quads sample its region of the shared texture: one texture for the whole batch, shifted per quad.
        const region = this.#atlasRegions.get(gpuTexture);
        const ox = region ? region.x : 0, oy = region ? region.y : 0;
        const sampledTexture = region ? region.texture : gpuTexture;
        const sampledInfo = region ? this.#options.owner.textureInfo(region.texture) : info;
        if (region) auditCount('compositor', 'atlas-sample', quads.length);
        const width = Math.round(active.view.viewport.width * active.view.viewport.dpr);
        const height = Math.round(active.view.viewport.height * active.view.viewport.dpr);
        // Every quad is checked before anything is drawn, so a bad quad refuses the whole batch and draws none of it.
        const batch = this.#batchBuffer(quads.length * 8);
        let count = 0, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const quad of quads) {
            const { sourceRect: src, destRect: dst } = quad;
            if (!validRect(src) || !validRect(dst)) throw new ArenaError('invalid-input');
            if (src.x < info.usedRect.x || src.y < info.usedRect.y ||
                src.x + src.width > info.usedRect.x + info.usedRect.width || src.y + src.height > info.usedRect.y + info.usedRect.height) {
                throw new ArenaError('invalid-input');
            }
            if (!src.width || !src.height || !dst.width || !dst.height) continue;
            const scissor = envelope(dst, width, height);
            if (!scissor.width || !scissor.height) continue;
            const at = count * 8;
            batch[at] = dst.x; batch[at + 1] = dst.y; batch[at + 2] = dst.x + dst.width; batch[at + 3] = dst.y + dst.height;
            batch[at + 4] = src.x + ox; batch[at + 5] = src.y + oy; batch[at + 6] = src.width; batch[at + 7] = src.height;
            count++;
            left = Math.min(left, scissor.x); top = Math.min(top, scissor.y);
            right = Math.max(right, scissor.x + scissor.width); bottom = Math.max(bottom, scissor.y + scissor.height);
        }
        if (!count) return;
        // The block is the single quad's layout: viewport, then texture size with opacity (the coverage class is bench-only).
        this.#batchUniforms.set([0, 0, width, height, 0, 0, 0, 0, 0, 0, 0, 0, sampledInfo.width, sampledInfo.height, opacity,
            __BME_BENCH__ ? options.coverage === 'current' ? 3 : options.coverage === 'standin' ? 2 : 0 : 0]);
        const uniforms = this.uniforms(this.#batchUniforms);
        const vertices = this.uniforms(batch.subarray(0, count * 8));
        pass.draw({ pipeline, vertices: [vertices], first: 0, count: 4, instances: count,
            scissor: { x: left, y: top, width: right - left, height: bottom - top },
            ...(__BME_BENCH__ && options.coverage && options.coverage !== 'none' ? {
                coverageClass: options.coverage === 'standin' ? 2 as const : 3 as const,
                // A batch shares one stand-in ratio; the single path measures it per quad, so this is the declared one.
                ...(options.coverage === 'standin' ? { standInRatio: options.standInRatio ?? 1 } : {}),
            } : {}),
            bindings: { uniforms: [{ binding: 0, slice: uniforms }], textures: [{ binding: 0, texture: sampledTexture,
                sampler: options.sampling === 'nearest' ? this.#nearest! : this.#linear! }] } });
    }

    releaseGpu(reason: GpuReleaseReason): void {
        if (this.#disposed) return;
        this.#epoch++;
        this.#lastSubmissionSerial = 0;
        this.#available = false;
        this.#retryPending = false;
        for (const encoder of this.#encodings) this.#options.owner.discardFrame(encoder);
        this.#encodings.clear();
        this.#active = null; this.#prepared = null; this.#isolationPlan = null; this.#isolationReadyFrame = -1;
        this.#shortfalls = []; this.#snapshot = null; this.#report = null; this.#metrics = null;
        if (reason === 'context-lost') { this.#quad = null; this.#batchQuad = null; this.#linear = null; this.#nearest = null; this.#compiling = null; }
    }

    dispose(): void {
        if (this.#disposed) return;
        this.releaseGpu('hidden');
        this.#disposed = true;
        this.detach();
        this.#layers = [];
        for (const handle of [this.#quad, this.#batchQuad, this.#linear, this.#nearest]) if (handle) this.#options.owner.resources.destroy(handle);
        this.#quad = null; this.#batchQuad = null; this.#linear = null; this.#nearest = null;
    }

    /** Each layer's offscreen passes, in layer order, before the surface pass: one pass open at a time, every scope closed. */
    /** Places one offscreen tile in this frame's shared atlas (Layer.atlas, default off). A tile the atlas cannot take draws its
     * own target as before, counted under fallback:atlas-* by its reason. The atlas is one lease per frame; each tile takes a
     * shelf region with a one-texel margin, and the margin is cleared with the region, so sampling at a tile's edge reads
     * transparent texels, never the neighbour. Only clear passes without stencil use it: a load pass would read stale texels. */
    #atlasRegion(encoder: FrameEncoder, target: TargetHandle, viewport: RectI, options: { clear: RgbaP | null; stencil: boolean }):
        { target: TargetHandle; viewport: RectI; clear: RectI } | null {
        if (!options.clear) { auditCount('compositor', 'fallback:atlas-load'); return null; }
        if (options.stencil) { auditCount('compositor', 'fallback:atlas-stencil'); return null; }
        if (!this.#atlas) {
            this.#atlas = { lease: encoder.acquireTarget({ width: ATLAS_SIZE, height: ATLAS_SIZE, samples: 1, format: 'rgba8', stencil: false, purpose: 'group' }),
                x: 0, y: 0, rowH: 0 };
        }
        const atlas = this.#atlas;
        if (!atlas.lease) { auditCount('compositor', 'fallback:atlas-unavailable'); return null; }
        const pad = 1, w = viewport.width + 2 * pad, h = viewport.height + 2 * pad;
        if (w > ATLAS_SIZE || h > ATLAS_SIZE) { auditCount('compositor', 'fallback:atlas-oversize'); return null; }
        if (atlas.x + w > ATLAS_SIZE) { atlas.x = 0; atlas.y += atlas.rowH; atlas.rowH = 0; }
        if (atlas.y + h > ATLAS_SIZE) { auditCount('compositor', 'fallback:atlas-full'); return null; }
        const origin = { x: atlas.x, y: atlas.y };
        atlas.x += w; atlas.rowH = Math.max(atlas.rowH, h);
        const region = { x: origin.x + pad, y: origin.y + pad, width: viewport.width, height: viewport.height };
        // The layer keeps sampling its own texture; the registry sends those samples to the region for the rest of the frame.
        this.#atlasRegions.set(this.#options.owner.targetTexture(target), { texture: atlas.lease.texture, x: region.x, y: region.y });
        auditCount('compositor', 'atlas-region');
        return { target: atlas.lease.target, viewport: region, clear: { x: origin.x, y: origin.y, width: w, height: h } };
    }

    #encodeOffscreen(snapshot: Snapshot, frame: ScheduledFrame, encoder: FrameEncoder, drawScope: DrawScope): number {
        let passes = 0;
        for (const binding of snapshot.layers) {
            const layer = binding.layer;
            if (!layer.encodeOffscreen) continue;
            const auditId = (binding as { id?: string }).id ?? 'layer';
            let open: { pass: GpuPass; finish(): void; raw: GpuPass; registered: GpuPass[] } | null = null;
            const close = () => {
                if (!open) return;
                const current = open; open = null;
                for (const registered of current.registered) drawScope.passes.delete(registered);
                current.finish(); current.raw.end();
            };
            const timed = renderAuditEnabled();
            const started = timed ? performance.now() : 0;
            try {
                layer.encodeOffscreen({
                    begin: (target, viewport, options) => {
                        if (open) throw new ArenaError('invalid-input');
                        const atlas = layer.atlas === true ? this.#atlasRegion(encoder, target, viewport, options) : null;
                        const raw = encoder.beginPass({ target: atlas ? atlas.target : target, viewport: atlas ? atlas.viewport : viewport,
                            ...(atlas ? { clearViewport: atlas.clear } : {}),
                            load: options.clear ? { kind: 'clear', color: options.clear } : { kind: 'load' }, store: 'store',
                            ...(options.stencil ? { stencil: { load: { kind: 'clear', value: 0 }, store: 'discard' } as const } : {}) });
                        const scope = layerPass(raw);
                        passes++;
                        auditCount(auditId, 'offscreen-pass');
                        const counted: GpuPass = renderAuditEnabled() ? new Proxy(scope.pass, { get(t, key) {
                            const value = Reflect.get(t, key, t) as unknown;
                            if (key === 'draw' && typeof value === 'function') return (cmd: unknown) => { auditCount(auditId, 'gpu-draw'); return (value as (c: unknown) => void).call(t, cmd); };
                            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
                        } }) : scope.pass;
                        const pass: GpuPass = { ...counted, draw: c => counted.draw(c), end: () => { if (open?.pass !== pass) throw new ArenaError('invalid-input'); close(); } };
                        const registered = [pass, counted, scope.pass];
                        open = { pass, finish: scope.finish, raw, registered };
                        for (const value of registered) drawScope.passes.add(value);
                        return pass;
                    },
                }, frame.view);
                if (open) throw new ArenaError('invalid-input');
            } finally {
                close();
                if (timed) auditStage(auditId, 'encodeOffscreen', performance.now() - started);
            }
        }
        return passes;
    }

    #check(): void { if (this.#disposed) throw new ArenaError('aborted'); }
    #drawable(snapshot: Snapshot, frame: ScheduledFrame): boolean {
        return !this.#disposed && this.#snapshot === snapshot && !!snapshot.metrics &&
            frame.token.deviceGeneration === this.target.generation &&
            this.surface.width === snapshot.metrics.backingWidth && this.surface.height === snapshot.metrics.backingHeight &&
            snapshot.layers.every(binding => frame.layers.some(meta => meta.layer === binding.layer));
    }
    /** Compiles the single and the batched quad together: a batch is useless without its single fallback, and one promise
     * keeps both handles in step. allSettled, so a failure of one still releases the other instead of leaking it. */
    /** The buffer for a batch of `floats`: grown when it is too small, and shrunk back once `BATCH_IDLE_LIMIT` batches in a row
     * used under a quarter of it, so one large batch does not keep its memory for the compositor's life. */
    #batchBuffer(floats: number): Float32Array {
        const current = this.#batchData;
        if (current.length < floats) { this.#batchIdle = 0; return (this.#batchData = new Float32Array(floats)); }
        if (current.length > BATCH_FLOOR_FLOATS && floats * 4 < current.length) {
            if (++this.#batchIdle < BATCH_IDLE_LIMIT) return current;
            this.#batchIdle = 0;
            return (this.#batchData = new Float32Array(Math.max(floats, BATCH_FLOOR_FLOATS)));
        }
        this.#batchIdle = 0;
        return current;
    }
    #prepareQuad(): void {
        if (this.#quad || this.#compiling) return;
        const device = this.#options.owner.resources;
        const epoch = this.#epoch;
        this.#nearest ??= device.createSampler('nearest');
        this.#linear ??= device.createSampler('linear');
        const compile: Promise<void> = Promise.allSettled([device.createPipeline(quadDescriptor(TEXTURED_QUAD_SHADER)),
            device.createPipeline(quadDescriptor(TEXTURED_QUAD_BATCH_SHADER))]).then(([single, batch]) => {
            const handles = [single, batch].map(result => result.status === 'fulfilled' ? result.value : null);
            if (this.#disposed || epoch !== this.#epoch) { for (const handle of handles) if (handle) device.destroy(handle); return; }
            const failed = [single, batch].find(result => result.status === 'rejected');
            if (failed) {
                for (const handle of handles) if (handle) device.destroy(handle);
                this.#failure(failed.reason);
                return;
            }
            this.#quad = handles[0];
            this.#batchQuad = handles[1];
            this.#options.invalidate('gpu-quad-ready');
        }).finally(() => {
            // A compile from a lost context can settle after a newer one started: its marker is not this one's to clear.
            if (this.#compiling === compile) this.#compiling = null;
            if (!this.#disposed && epoch !== this.#epoch && this.#available) this.#options.invalidate('gpu-quad-retry');
        });
        this.#compiling = compile;
    }
    #failure(error: unknown): void {
        if (error instanceof IsolationShortfall) {
            const request = error.request;
            const existing = this.#shortfalls.findIndex(item => item.request.format === request.format &&
                item.request.samples === request.samples && item.request.stencil === request.stencil);
            if (existing < 0) this.#shortfalls.push(error);
            else {
                const previous = this.#shortfalls[existing];
                this.#shortfalls[existing] = new IsolationShortfall({ ...request,
                    width: Math.max(previous.request.width, request.width), height: Math.max(previous.request.height, request.height) },
                Math.max(previous.simultaneous, error.simultaneous), previous.external || error.external);
            }
            this.#retryPending = true;
            this.#options.invalidate('isolation-shortfall');
            return;
        }
        if (error instanceof ArenaError && ['aborted', 'lost', 'out-of-budget'].includes(error.code)) {
            this.#retryPending = error.code === 'out-of-budget';
            this.#options.onDeferred?.();
        } else this.#options.onError(error);
    }
}

export function createGpuCompositor(options: GpuCompositorOptions): GpuCompositor { return new GpuCompositor(options); }
