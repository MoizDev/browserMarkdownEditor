import type { Rect, ViewState } from '../types';
import type {
    CompositorAppearance, CompositorCoverage, CompositorLayer, CompositorPage, PaneCompositor, PaneSurfaceHost, TexturedQuadOptions,
} from './compositor.types';
import { paintPageScope, paintWorldScope, projectPage } from './compositorProjection';
import { TEXTURED_QUAD_SHADER } from './compositorShader';
import type { ClipToken, FrameEncoder, GpuPass, GroupToken, PipelineHandle, RectI, SamplerHandle, TextureHandle, UniformSlice } from './gfx/api';
import type { Webgl2Owner } from './gfx/webgl2';
import type { PageStack } from './pageStack';
import { ArenaError } from './resourceArena';
import type { ScheduledEncoding, ScheduledFrame, ScheduledSubmission } from './scheduler';
import type { ReadySurfaceMetrics, SurfaceCommitTarget } from './surfaceMetrics';
import { allocateSurfaceGeneration } from './surfaceGeneration';
import type { FrameBudget, FrameToken, GpuReleaseReason } from './types';

export interface GpuCompositorOptions {
    readonly owner: Webgl2Owner;
    readonly canvas: HTMLCanvasElement;
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
    const scopes: Array<{ kind: 'clip'; token: ClipToken } | { kind: 'group'; token: GroupToken }> = [];
    let active = true;
    const check = () => { if (!active) throw new ArenaError('aborted'); };
    const pop = (kind: 'clip' | 'group', token: ClipToken | GroupToken) => {
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
    #active: DrawScope | null = null;
    #quad: PipelineHandle | null = null;
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
            uniforms: (bytes: ArrayBufferView) => this.uniforms(bytes),
            drawTexturedQuad: this.drawTexturedQuad.bind(this) as PaneCompositor['resources']['drawTexturedQuad'] });
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
            // Keep callback receiver semantics without reading the caller's mutable binding again.
            return Object.freeze({ id: binding.id, layer: binding.layer, group: binding.group,
                isolation: binding.isolation ? Object.freeze({ ...binding.isolation }) : undefined,
                coverage: binding.coverage.bind(binding) });
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

    prepareFrame(view: ViewState, budget: FrameBudget): void {
        this.#check();
        const snapshot = this.#snapshot;
        if (!snapshot || snapshot.view !== view || budget.cameraEpoch !== view.epoch ||
            budget.token.deviceGeneration !== this.target.generation) return;
        this.#prepared = { frameId: budget.frameId, token: Object.freeze({ ...budget.token }), snapshot };
        try { this.#prepareQuad(); }
        catch (error) { this.#failure(error); }
    }

    encode(frame: ScheduledFrame): ScheduledEncoding | null {
        this.#check();
        const prepared = this.#prepared;
        const snapshot = this.#snapshot;
        if (!prepared || !snapshot || !this.#quad || !this.#nearest || !this.#linear || !snapshot.metrics ||
            prepared.snapshot !== snapshot || snapshot.view !== frame.view || prepared.frameId !== frame.frameId ||
            !sameToken(prepared.token, frame.token) || !this.#drawable(snapshot, frame)) return null;
        let encoder: FrameEncoder | null = null;
        try {
            const coverage = snapshot.layers.map(binding => binding.coverage(frame, this.backend));
            if (coverage.some(item => !item.complete)) return null;
            encoder = this.#options.owner.resources.beginFrame();
            this.#encodings.add(encoder);
            const bounds = { x: 0, y: 0, width: snapshot.metrics.backingWidth, height: snapshot.metrics.backingHeight };
            const pass = encoder.beginPass({ target: 'surface', viewport: bounds,
                load: { kind: 'clear', color: snapshot.appearance.background }, store: 'store' });
            const drawScope: DrawScope = { encoder, view: frame.view, passes: new Set() };
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
                    try { binding.layer.drawGpu(scope.pass, frame.view); }
                    finally { drawScope.passes.delete(scope.pass); scope.finish(); }
                    if (isolation) pass.endGroup(isolation);
                }
                if (document) pass.endGroup(document);
                pass.end();
            } finally { this.#active = null; }
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
                        done = true;
                        this.#encodings.delete(owned);
                        this.#retryPending = false;
                        this.#report = Object.freeze({ frameId: frame.frameId, token: Object.freeze({ ...frame.token }), presented: true,
                            complete: true, sharp: snapshot.metrics!.qualityScale === 1 && coverage.every(item => item.sharp),
                            qualityScale: snapshot.metrics!.qualityScale });
                        return { drawn: frame.layers.filter(meta => snapshot.layers.some(binding => binding.layer === meta.layer))
                            .map(meta => ({ layer: meta.layer, sceneRevision: meta.sceneRevision })),
                        completed: () => !this.#disposed && epoch === this.#epoch && this.#options.owner.resources.completed(submitted.serial) };
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
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void { paintWorldScope(ctx, view, paint); }
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void {
        paintPageScope(ctx, this.page(view, index), paint);
    }

    /** Host methods are scoped capabilities, not retained access to a previous frame's ring (C4.3). */
    uniforms(bytes: ArrayBufferView): UniformSlice {
        if (!this.#active || !this.#active.passes.size) throw new ArenaError('invalid-input');
        return this.#active.encoder.uniforms(bytes);
    }

    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: ImageBitmap, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(pass: GpuPass | CanvasRenderingContext2D, texture: TextureHandle | ImageBitmap,
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
                pass.drawImage(texture as ImageBitmap, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height,
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
        this.#quadData.set([0, 0, width, height, destRect.x, destRect.y, destRect.width, destRect.height,
            sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, info.width, info.height, opacity, 0]);
        const slice = this.uniforms(this.#quadData);
        pass.draw({ pipeline: this.#quad, vertices: [], first: 0, count: 4, instances: 1, scissor,
            bindings: { uniforms: [{ binding: 0, slice }], textures: [{ binding: 0, texture: gpuTexture,
                sampler: options.sampling === 'nearest' ? this.#nearest : this.#linear }] } });
    }

    releaseGpu(reason: GpuReleaseReason): void {
        if (this.#disposed) return;
        this.#epoch++;
        this.#available = false;
        this.#retryPending = false;
        for (const encoder of this.#encodings) this.#options.owner.discardFrame(encoder);
        this.#encodings.clear();
        this.#active = null; this.#prepared = null; this.#snapshot = null; this.#report = null; this.#metrics = null;
        if (reason === 'context-lost') { this.#quad = null; this.#linear = null; this.#nearest = null; this.#compiling = null; }
    }

    dispose(): void {
        if (this.#disposed) return;
        this.releaseGpu('hidden');
        this.#disposed = true;
        this.detach();
        this.#layers = [];
        for (const handle of [this.#quad, this.#linear, this.#nearest]) if (handle) this.#options.owner.resources.destroy(handle);
        this.#quad = null; this.#linear = null; this.#nearest = null;
    }

    #check(): void { if (this.#disposed) throw new ArenaError('aborted'); }
    #drawable(snapshot: Snapshot, frame: ScheduledFrame): boolean {
        return !this.#disposed && this.#snapshot === snapshot && !!snapshot.metrics &&
            frame.token.deviceGeneration === this.target.generation &&
            this.surface.width === snapshot.metrics.backingWidth && this.surface.height === snapshot.metrics.backingHeight &&
            snapshot.layers.every(binding => frame.layers.some(meta => meta.layer === binding.layer));
    }
    #prepareQuad(): void {
        if (this.#quad || this.#compiling) return;
        const device = this.#options.owner.resources;
        const epoch = this.#epoch;
        this.#nearest ??= device.createSampler('nearest');
        this.#linear ??= device.createSampler('linear');
        const promise = device.createPipeline({ shader: TEXTURED_QUAD_SHADER, topology: 'triangle-strip', colorFormat: 'rgba8',
            samples: 1, blend: 'source-over', alphaToCoverage: false, colorWrite: [true, true, true, true], stencil: { enabled: false } });
        this.#compiling = promise.then(handle => {
            if (this.#disposed || epoch !== this.#epoch) { device.destroy(handle); return; }
            this.#quad = handle;
            this.#options.invalidate('gpu-quad-ready');
        }).catch(error => { if (!this.#disposed && epoch === this.#epoch) this.#failure(error); })
            .finally(() => {
                this.#compiling = null;
                if (!this.#disposed && epoch !== this.#epoch && this.#available) this.#options.invalidate('gpu-quad-retry');
            });
    }
    #failure(error: unknown): void {
        if (error instanceof ArenaError && ['aborted', 'lost', 'out-of-budget'].includes(error.code)) {
            this.#retryPending = error.code === 'out-of-budget';
            this.#options.onDeferred?.();
        } else this.#options.onError(error);
    }
}

export function createGpuCompositor(options: GpuCompositorOptions): GpuCompositor { return new GpuCompositor(options); }
