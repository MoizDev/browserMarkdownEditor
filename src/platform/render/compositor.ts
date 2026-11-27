import { auditCount, auditDrawnStart, auditDrawnTake, auditGpuError, auditPresent, presentView, auditStage, renderAuditEnabled } from './renderAudit';
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
import type { AreaOutput, AreaTarget, ClipHandle, ClipToken, CoverageOutput, CoverageTarget, CoverageToken, DrawCommand, DrawableImage, FrameEncoder, GpuPass, GroupToken, PipelineDesc, PipelineHandle, RectI, RgbaP, SamplerHandle, ShaderModule, TargetHandle, TargetLease, TextureHandle, UniformSlice } from './gfx/api';
import type { Webgl2Owner } from './gfx/webgl2';
import type { PageStack } from './pageStack';
import { ArenaError } from './resourceArena';
import type { ScheduledEncoding, ScheduledFrame, ScheduledSubmission } from './scheduler';
import type { ReadySurfaceMetrics, SurfaceCommitTarget } from './surfaceMetrics';
import { allocateSurfaceGeneration } from './surfaceGeneration';
import type { FrameBudget, FrameToken, GpuReleaseReason, OffscreenPasses } from './types';

const benchmarkDomain = __BME_BENCH__ ? await import('./benchmarkPaintDomain') : null;

const ATLAS_SIZE = 2064;
const BATCH_FLOOR_FLOATS = 64 * 8;
const BATCH_IDLE_LIMIT = 120;

function quadDescriptor(shader: ShaderModule): PipelineDesc {
    return { shader, topology: 'triangle-strip', colorFormat: 'rgba8', samples: 1, blend: 'source-over', alphaToCoverage: false,
        colorWrite: [true, true, true, true], stencil: { enabled: false } };
}


export interface GpuCompositorOptions {
    readonly owner: Webgl2Owner;
    readonly canvas: HTMLCanvasElement;
    readonly paneId?: string;
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
interface DrawScope { encoder: FrameEncoder; view: ViewState; readonly passes: Set<GpuPass> }

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

function quietly(action: () => void): void {
    try { action(); } catch { /* the failure in flight is the one reported */ }
}

type PassScope = { readonly kind: 'clip'; readonly token: ClipToken } | { readonly kind: 'group'; readonly token: GroupToken }
    | { readonly kind: 'coverage' | 'area'; readonly token: CoverageToken };
type PassDesc = Parameters<GpuPass['acquireTarget']>[0];
type GroupOptions = Parameters<GpuPass['beginGroup']>[1];
type CompositeOptions = Parameters<GpuPass['composite']>[2];

class ScopedPass implements GpuPass {
    readonly #scopes: PassScope[] = [];
    #active = true;
    constructor(readonly raw: GpuPass, private readonly onEnd: ((pass: ScopedPass) => void) | null = null) {}
    #check(): void { if (!this.#active) throw new ArenaError('aborted'); }
    #pop(kind: PassScope['kind'], token: ClipToken | GroupToken | CoverageToken): void {
        this.#check();
        const top = this.#scopes.at(-1);
        if (!top || top.kind !== kind || top.token !== token) throw new ArenaError('invalid-input');
        this.#scopes.pop();
    }
    draw(command: DrawCommand): void { this.#check(); this.raw.draw(command); }
    acquireTarget(desc: PassDesc): TargetLease | null { this.#check(); return this.raw.acquireTarget(desc); }
    releaseTarget(lease: TargetLease): void { this.#check(); this.raw.releaseTarget(lease); }
    pushClip(clip: RectI | ClipHandle): ClipToken {
        this.#check(); const token = this.raw.pushClip(clip); this.#scopes.push({ kind: 'clip', token }); return token;
    }
    popClip(token: ClipToken): void { this.#pop('clip', token); this.raw.popClip(token); }
    clipRect(): Readonly<RectI> { this.#check(); return this.raw.clipRect(); }
    beginGroup(bounds: RectI, options: GroupOptions): GroupToken {
        this.#check(); const token = this.raw.beginGroup(bounds, options); this.#scopes.push({ kind: 'group', token }); return token;
    }
    endGroup(token: GroupToken): void { this.#pop('group', token); this.raw.endGroup(token); }
    beginCoverage(target: CoverageTarget, bounds: RectI): CoverageToken {
        this.#check(); const token = this.raw.beginCoverage(target, bounds); this.#scopes.push({ kind: 'coverage', token }); return token;
    }
    endCoverage(token: CoverageToken, output: CoverageOutput): void { this.#pop('coverage', token); this.raw.endCoverage(token, output); }
    beginArea(target: AreaTarget): CoverageToken {
        this.#check(); const token = this.raw.beginArea(target); this.#scopes.push({ kind: 'area', token }); return token;
    }
    endArea(token: CoverageToken): void { this.#pop('area', token); this.raw.endArea(token); }
    compositeArea(target: AreaTarget, at: Readonly<{ x: number; y: number }>, bounds: RectI, output: AreaOutput): void {
        this.#check(); this.raw.compositeArea(target, at, bounds, output);
    }
    composite(source: TextureHandle, bounds: RectI, options: CompositeOptions): void { this.#check(); this.raw.composite(source, bounds, options); }
    end(): void {
        if (!this.onEnd) { this.#check(); throw new ArenaError('invalid-input'); }
        this.onEnd(this);
    }
    finish(): void { this.#active = false; if (this.#scopes.length) throw new ArenaError('invalid-input'); }
    abandon(): void {
        this.#active = false;
        while (this.#scopes.length) {
            const top = this.#scopes.pop()!;
            if (top.kind === 'clip') quietly(() => this.raw.popClip(top.token));
            else if (top.kind === 'group') quietly(() => this.raw.endGroup(top.token));
            else if (top.kind === 'area') quietly(() => this.raw.endArea(top.token));
        }
    }
}

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
    #drawingBinding: CompositorLayer | null = null;
    #deferredBindings = new Set<CompositorLayer | null>();
    #report: CompositorCoverage | null = null;
    readonly #encodings = new Set<FrameEncoder>();
    readonly #settling = new Map<FrameEncoder, CompositorLayer['layer'][]>();
    #frameScope: DrawScope | null = null;
    #scopeFor(encoder: FrameEncoder, view: ViewState): DrawScope {
        const scope = this.#frameScope ??= { encoder, view, passes: new Set() };
        scope.encoder = encoder; scope.view = view; scope.passes.clear();
        return scope;
    }
    readonly #offscreen: { encoder: FrameEncoder | null; drawScope: DrawScope | null; layer: CompositorLayer['layer'] | null; auditId: string;
        passes: number; open: ScopedPass | null; counted: GpuPass | null; readonly api: OffscreenPasses } = {
        encoder: null, drawScope: null, layer: null, auditId: 'layer', passes: 0, open: null, counted: null,
        api: { begin: (target, viewport, options) => this.#beginOffscreen(target, viewport, options) } };
    readonly #quadData = new Float32Array(16);
    #batchData = new Float32Array(BATCH_FLOOR_FLOATS);
    #batchIdle = 0;
    readonly #batchUniforms = new Float32Array(16);
    #atlas: { lease: TargetLease | null; x: number; y: number; rowH: number } | null = null;
    readonly #atlasRegions = new Map<TextureHandle, { texture: TextureHandle; x: number; y: number }>();
    readonly #passExtents = new WeakMap<GpuPass, { readonly width: number; readonly height: number }>();

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
            markIncomplete: (reason: string) => this.#markIncomplete(reason),
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

    encodeOffscreen(frame: ScheduledFrame): ScheduledEncoding | null {
        this.#check();
        const prepared = this.#prepared;
        const snapshot = this.#snapshot;
        if (!prepared || !snapshot || !snapshot.metrics || prepared.snapshot !== snapshot || snapshot.view !== frame.view ||
            prepared.frameId !== frame.frameId || this.#isolationReadyFrame !== frame.frameId || !sameToken(prepared.token, frame.token) ||
            !this.#drawable(snapshot, frame)) return null;
        return this.#encodeRefused(snapshot, frame);
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
        const timed = renderAuditEnabled();
        const encodeStarted = timed ? performance.now() : 0;
        try {
            const zooming = timed && this.#zoomStep(frame.view.camera.z);
            if (timed) auditDrawnStart();
            let refuse = false, allComplete = true, allSharp = true, anyStale = false;
            for (let i = 0; i < snapshot.layers.length; i++) {
                const layer = snapshot.layers[i];
                const verdict = layer.coverage(frame, this.backend);
                if (!verdict.sharp || verdict.staleVersion) { allSharp = false; if (renderAuditEnabled()) auditCount(layer.id, verdict.staleVersion ? 'coverage:stale' : 'coverage:not-sharp'); }
                if (verdict.staleVersion) anyStale = true;
                if (verdict.complete) continue;
                allComplete = false;
                if (layer.critical?.(frame) === false) { if (renderAuditEnabled()) auditCount(layer.id, 'standin'); continue; }
                refuse = true;
                if (renderAuditEnabled()) auditCount(layer.id, 'incomplete');
            }
            if (refuse) {
                auditCount('compositor', 'refuse:coverage');
                const refused = this.#encodeRefused(snapshot, frame);
                if (timed) {
                    const tally = auditDrawnTake();
                    auditPresent({ pane: this.#options.paneId ?? null, frame: frame.frameId, rawTick: frame.timestamp, view: presentView(frame.view), backend: this.backend,
                        layersComplete: false, canvas: null, standIns: tally.standIns, standInsRaster: tally.standInsRaster, holes: tally.holes,
                        zooming, refusal: 'coverage' });
                }
                return refused;
            }
            encoder = this.#options.owner.resources.beginFrame();
            this.#encodings.add(encoder);
            const bounds = { x: 0, y: 0, width: snapshot.metrics.backingWidth, height: snapshot.metrics.backingHeight };
            const drawScope = this.#scopeFor(encoder, frame.view);
            this.#active = drawScope;
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
                    const scope = new ScopedPass(pass);
                    drawScope.passes.add(scope);
                    const auditId = (binding as { id?: string }).id ?? 'layer';
                    auditCount(auditId, 'gpu-layer');
                    const layerTarget = renderAuditEnabled() ? new Proxy(scope, { get(target, key) {
                        const value = Reflect.get(target, key, target) as unknown;
                        if (key === 'draw' && typeof value === 'function') return (cmd: unknown) => { auditCount(auditId, 'gpu-draw'); return (value as (c: unknown) => void).call(target, cmd); };
                        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
                    } }) : scope;
                    // The layer receives the audit view, so the scope must admit that same object: drawTexturedQuad checks identity.
                    drawScope.passes.add(layerTarget);
                    const drawStarted = timed ? performance.now() : 0;
                    let drawn = false;
                    this.#drawingBinding = binding;
                    try { binding.layer.drawGpu(layerTarget, frame.view); drawn = true; }
                    catch (error) { auditGpuError(null, `layer-draw:${auditId}`, error); throw error; }
                    finally {
                        this.#drawingBinding = null;
                        drawScope.passes.delete(layerTarget); drawScope.passes.delete(scope);
                        try { if (drawn) scope.finish(); else scope.abandon(); }
                        finally {
                            if (isolation) { if (drawn) pass.endGroup(isolation); else quietly(() => pass.endGroup(isolation)); }
                            if (timed) auditStage(auditId, 'draw', performance.now() - drawStarted);
                        }
                    }
                }
                if (document) { pass.endGroup(document); document = null; }
                pass.end();
            } finally {
                this.#active = null;
                if (document) quietly(() => pass.endGroup(document!));
            }
            const deferred = this.#deferredBindings.size > 0;
            if (deferred) this.#options.invalidate('gpu-uniform-ring-deferred');
            let criticalDeferred = false;
            for (const binding of this.#deferredBindings) if (binding === null || binding.critical?.(frame) !== false) { criticalDeferred = true; break; }
            if (criticalDeferred) {
                auditCount('compositor', 'refuse:uniform-ring');
                this.#encodings.delete(encoder);
                this.#discard(encoder);
                this.#failure(new ArenaError('out-of-budget'));
                return null;
            }
            const tally = timed ? auditDrawnTake() : null;
            const owned = encoder;
            let done = false;
            const epoch = this.#epoch;
            return {
                submit: (): ScheduledSubmission | null => {
                    if (done || this.#disposed || epoch !== this.#epoch || !this.#drawable(snapshot, frame)) {
                        this.#discard(owned);
                        this.#encodings.delete(owned);
                        done = true;
                        return null;
                    }
                    try {
                        const submitStarted = timed ? performance.now() : 0;
                        const submitted = owned.submit();
                        this.#settle(owned, true);
                        auditCount('compositor', 'gl:state', submitted.stateSwitches);
                        if (timed) {
                            const now = performance.now();
                            auditStage('compositor', 'submit', now - submitStarted);
                            auditStage('compositor', 'frame', now - encodeStarted);
                        }
                        this.#lastSubmissionSerial = submitted.serial;
                        this.surface.style.width = `${snapshot.metrics!.viewport.width}px`;
                        this.surface.style.height = `${snapshot.metrics!.viewport.height}px`;
                        done = true;
                        this.#encodings.delete(owned);
                        this.#retryPending = false;
                        this.#shortfalls = [];
                        const layersComplete = !deferred && allComplete;
                        if (snapshot.metrics!.qualityScale !== 1 && renderAuditEnabled()) auditCount('compositor', 'coverage:quality-' + snapshot.metrics!.qualityScale.toFixed(2));
                        this.#report = Object.freeze({ frameId: frame.frameId, token: Object.freeze({ ...frame.token }), presented: true,
                            complete: true, sharp: snapshot.metrics!.qualityScale === 1 && allSharp,
                            staleVersion: anyStale, layersComplete,
                            qualityScale: snapshot.metrics!.qualityScale });
                        if (tally) auditPresent({ pane: this.#options.paneId ?? null, frame: frame.frameId, rawTick: frame.timestamp, view: presentView(frame.view),
                            backend: this.backend, layersComplete, canvas: this.surface,
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
                        this.#discard(owned);
                        this.#failure(error);
                        throw error;
                    }
                },
                discard: () => {
                    if (done) return;
                    done = true;
                    this.#encodings.delete(owned);
                    this.#discard(owned);
                },
            };
        } catch (error) {
            if (encoder) { this.#encodings.delete(encoder); this.#discard(encoder); }
            this.#failure(error);
            return null;
        }
    }

    #discard(encoder: FrameEncoder): void {
        try { this.#options.owner.discardFrame(encoder); }
        finally { this.#settle(encoder, false); }
    }

    #settle(encoder: FrameEncoder, submitted: boolean): void {
        const layers = this.#settling.get(encoder);
        if (!layers) return;
        this.#settling.delete(encoder);
        for (const layer of layers) {
            try { layer.offscreenSettled?.(submitted); } catch (error) { this.#failure(error); }
        }
    }

    #zoomStep(scale: number): boolean {
        const zooming = this.#lastScale !== null && scale !== this.#lastScale;
        this.#lastScale = scale;
        return zooming;
    }

    #encodeRefused(snapshot: Snapshot, frame: ScheduledFrame): ScheduledEncoding | null {
        let encoder: FrameEncoder | null = null;
        try {
            encoder = this.#options.owner.resources.beginFrame();
            this.#encodings.add(encoder);
            const drawScope = this.#scopeFor(encoder, frame.view);
            this.#active = drawScope;
            let offscreen = 0;
            this.#atlas = null;
            this.#atlasRegions.clear();
            try { offscreen = this.#encodeOffscreen(snapshot, frame, encoder, drawScope); } finally { this.#active = null; }
            if (!offscreen) {
                this.#encodings.delete(encoder);
                try { this.#options.owner.discardFrame(encoder); } finally { this.#settle(encoder, true); }
                return null;
            }
            auditCount('compositor', 'offscreen-on-refuse', offscreen);
            if (this.#deferredBindings.size > 0) this.#options.invalidate('gpu-uniform-ring-deferred');
            const owned = encoder;
            let done = false;
            const epoch = this.#epoch;
            return {
                submit: (): ScheduledSubmission | null => {
                    if (done || this.#disposed || epoch !== this.#epoch || !this.#drawable(snapshot, frame)) {
                        this.#discard(owned);
                        this.#encodings.delete(owned);
                        done = true;
                        return null;
                    }
                    try {
                        const submitted = owned.submit();
                        this.#settle(owned, true);
                        auditCount('compositor', 'gl:state', submitted.stateSwitches);
                        this.#lastSubmissionSerial = submitted.serial;
                        done = true;
                        this.#encodings.delete(owned);
                        return { drawn: [] };
                    } catch (error) {
                        done = true;
                        this.#encodings.delete(owned);
                        this.#discard(owned);
                        this.#failure(error);
                        throw error;
                    }
                },
                discard: () => {
                    if (done) return;
                    done = true;
                    this.#encodings.delete(owned);
                    this.#discard(owned);
                },
            };
        } catch (error) {
            if (encoder) { this.#encodings.delete(encoder); this.#discard(encoder); }
            this.#failure(error);
            return null;
        }
    }

    nowSharp(frame: ScheduledFrame): boolean {
        const prepared = this.#prepared, snapshot = this.#snapshot;
        if (!prepared || !snapshot?.metrics || prepared.snapshot !== snapshot || snapshot.view !== frame.view || prepared.frameId !== frame.frameId ||
            !sameToken(prepared.token, frame.token) || snapshot.metrics.qualityScale !== 1) return false;
        for (let i = 0; i < snapshot.layers.length; i++) {
            const verdict = snapshot.layers[i].coverage(frame, this.backend);
            if (!verdict.complete || !verdict.sharp || verdict.staleVersion) return false;
        }
        return true;
    }

    coverage(frame: ScheduledFrame): CompositorCoverage {
        const report = this.#report;
        if (report && report.frameId === frame.frameId && sameToken(report.token, frame.token)) return report;
        return { frameId: frame.frameId, token: frame.token, presented: false, complete: false, layersComplete: false, sharp: false,
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

    withCapturePass(encoder: FrameEncoder, pass: GpuPass, view: ViewState, paint: (scope: GpuPass) => void): void {
        this.#check();
        if (this.#active || !this.#available || !this.#quad || !this.#linear || !this.#nearest) throw new ArenaError('out-of-budget');
        const scoped = new ScopedPass(pass);
        this.#active = { encoder, view, passes: new Set([scoped]) };
        let painted = false;
        try { paint(scoped); painted = true; }
        finally { this.#active = null; if (painted) scoped.finish(); else scoped.abandon(); }
    }

    uniforms(bytes: ArrayBufferView): UniformSlice {
        if (!this.#active || !this.#active.passes.size) throw new ArenaError('invalid-input');
        return this.#active.encoder.uniforms(bytes);
    }

    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void {
        if (!this.#active || !this.#active.passes.size) throw new ArenaError('invalid-input');
        this.#active.encoder.uniformsInto(bytes, into);
    }

    #markIncomplete(reason: string): void {
        auditCount('compositor', `layer-incomplete:${reason}`);
        this.#deferredBindings.add(this.#drawingBinding);
    }

    #slice(bytes: ArrayBufferView): UniformSlice | null {
        try { return this.uniforms(bytes); }
        catch (error) {
            if (!(error instanceof ArenaError && error.code === 'out-of-budget')) throw error;
            auditCount('compositor', 'gpu:quad-deferred');
            this.#deferredBindings.add(this.#drawingBinding);
            return null;
        }
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
        const { width, height } = this.#extentOf(pass, active.view);
        const scissor = envelope(destRect, width, height);
        if (!scissor.width || !scissor.height) return;
        const region = this.#atlasRegions.get(gpuTexture);
        const sampledTexture = region ? region.texture : gpuTexture;
        const sampled = region ? this.#options.owner.textureInfo(region.texture) : info;
        const sample = region ? { x: sourceRect.x + region.x, y: sourceRect.y + region.y, width: sourceRect.width, height: sourceRect.height } : sourceRect;
        if (region) auditCount('compositor', 'atlas-sample');
        this.#quadData.set([0, 0, width, height, destRect.x, destRect.y, destRect.x + destRect.width, destRect.y + destRect.height,
            sample.x, sample.y, sample.width, sample.height, sampled.width, sampled.height, opacity,
            __BME_BENCH__ ? options.coverage === 'current' ? 3 : options.coverage === 'standin' ? 2 : 0 : 0]);
        const slice = this.#slice(this.#quadData);
        if (!slice) return;
        pass.draw({ pipeline: this.#quad, vertices: [], first: 0, count: 4, instances: 1, scissor,
            ...(__BME_BENCH__ && options.coverage && options.coverage !== 'none' ? {
                coverageClass: options.coverage === 'standin' ? 2 as const : 3 as const,
                ...(options.coverage === 'standin' ? { standInRatio: options.standInRatio ?? Math.min(1,
                    sourceRect.width / destRect.width, sourceRect.height / destRect.height) } : {}),
            } : {}),
            bindings: { uniforms: [{ binding: 0, slice }], textures: [{ binding: 0, texture: sampledTexture,
                sampler: options.sampling === 'nearest' ? this.#nearest : this.#linear }] } });
    }

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
        const region = this.#atlasRegions.get(gpuTexture);
        const ox = region ? region.x : 0, oy = region ? region.y : 0;
        const sampledTexture = region ? region.texture : gpuTexture;
        const sampledInfo = region ? this.#options.owner.textureInfo(region.texture) : info;
        if (region) auditCount('compositor', 'atlas-sample', quads.length);
        const { width, height } = this.#extentOf(pass, active.view);
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
        this.#batchUniforms.set([0, 0, width, height, 0, 0, 0, 0, 0, 0, 0, 0, sampledInfo.width, sampledInfo.height, opacity,
            __BME_BENCH__ ? options.coverage === 'current' ? 3 : options.coverage === 'standin' ? 2 : 0 : 0]);
        const uniforms = this.#slice(this.#batchUniforms);
        if (!uniforms) return;
        const vertices = this.#slice(batch.subarray(0, count * 8));
        if (!vertices) return;
        pass.draw({ pipeline, vertices: [vertices], first: 0, count: 4, instances: count,
            scissor: { x: left, y: top, width: right - left, height: bottom - top },
            ...(__BME_BENCH__ && options.coverage && options.coverage !== 'none' ? {
                coverageClass: options.coverage === 'standin' ? 2 as const : 3 as const,
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
        for (const encoder of this.#encodings) this.#discard(encoder);
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
        this.#atlasRegions.set(this.#options.owner.targetTexture(target), { texture: atlas.lease.texture, x: region.x, y: region.y });
        auditCount('compositor', 'atlas-region');
        return { target: atlas.lease.target, viewport: region, clear: { x: origin.x, y: origin.y, width: w, height: h } };
    }

    #encodeOffscreen(snapshot: Snapshot, frame: ScheduledFrame, encoder: FrameEncoder, drawScope: DrawScope): number {
        const run = this.#offscreen;
        run.encoder = encoder; run.drawScope = drawScope; run.passes = 0;
        this.#deferredBindings.clear();
        try {
            for (const binding of snapshot.layers) {
                const layer = binding.layer;
                if (!layer.encodeOffscreen) continue;
                if (layer.offscreenSettled) {
                    const settling = this.#settling.get(encoder);
                    if (settling) settling.push(layer); else this.#settling.set(encoder, [layer]);
                }
                this.#drawingBinding = binding;
                run.layer = layer; run.auditId = (binding as { id?: string }).id ?? 'layer';
                const timed = renderAuditEnabled();
                const started = timed ? performance.now() : 0;
                let completed = false;
                try {
                    layer.encodeOffscreen(run.api, frame.view);
                    if (run.open) throw new ArenaError('invalid-input');
                    completed = true;
                } finally {
                    this.#closeOffscreen(!completed);
                    if (timed) auditStage(run.auditId, 'encodeOffscreen', performance.now() - started);
                }
            }
            return run.passes;
        } finally { run.encoder = null; run.drawScope = null; run.layer = null; }
    }

    #beginOffscreen(target: TargetHandle, viewport: RectI, options: { clear: RgbaP | null; stencil: boolean; orClear?: RgbaP }): GpuPass {
        const run = this.#offscreen, encoder = run.encoder, drawScope = run.drawScope, layer = run.layer;
        if (!encoder || !drawScope || !layer || run.open) throw new ArenaError('invalid-input');
        const atlas = layer.atlas === true ? this.#atlasRegion(encoder, target, viewport, options) : null;
        const raw = encoder.beginPass({ target: atlas ? atlas.target : target, viewport: atlas ? atlas.viewport : viewport,
            ...(atlas ? { clearViewport: atlas.clear } : {}),
            load: options.clear ? { kind: 'clear', color: options.clear } : { kind: 'load', ...(options.orClear ? { orClear: options.orClear } : {}) }, store: 'store',
            ...(options.stencil ? { stencil: { load: { kind: 'clear', value: 0 }, store: 'discard' } as const } : {}) });
        const scope = new ScopedPass(raw, this.#endOffscreen);
        run.passes++;
        const auditId = run.auditId;
        auditCount(auditId, 'offscreen-pass');
        const counted: GpuPass = renderAuditEnabled() ? new Proxy(scope, { get(t, key) {
            const value = Reflect.get(t, key, t) as unknown;
            if (key === 'draw' && typeof value === 'function') return (cmd: unknown) => { auditCount(auditId, 'gpu-draw'); return (value as (c: unknown) => void).call(t, cmd); };
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
        } }) : scope;
        run.open = scope; run.counted = counted;
        const extent = { width: viewport.width, height: viewport.height };
        this.#passExtents.set(scope, extent); this.#passExtents.set(counted, extent);
        drawScope.passes.add(scope); drawScope.passes.add(counted);
        return counted;
    }

    readonly #endOffscreen = (pass: ScopedPass): void => {
        if (this.#offscreen.open !== pass) throw new ArenaError('invalid-input');
        this.#closeOffscreen(false);
    };

    #closeOffscreen(abandoned: boolean): void {
        const run = this.#offscreen, current = run.open;
        if (!current) return;
        run.open = null;
        if (run.drawScope) { run.drawScope.passes.delete(current); if (run.counted) run.drawScope.passes.delete(run.counted); }
        run.counted = null;
        if (abandoned) { current.abandon(); quietly(() => current.raw.end()); }
        else { current.finish(); current.raw.end(); }
    }

    #extentOf(pass: GpuPass, view: ViewState): { readonly width: number; readonly height: number } {
        return this.#passExtents.get(pass)
            ?? { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
    }
    #check(): void { if (this.#disposed) throw new ArenaError('aborted'); }
    #drawable(snapshot: Snapshot, frame: ScheduledFrame): boolean {
        return !this.#disposed && this.#snapshot === snapshot && !!snapshot.metrics &&
            frame.token.deviceGeneration === this.target.generation &&
            this.surface.width === snapshot.metrics.backingWidth && this.surface.height === snapshot.metrics.backingHeight &&
            snapshot.layers.every(binding => frame.layers.some(meta => meta.layer === binding.layer));
    }
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
