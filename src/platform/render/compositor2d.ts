import type { Rect, ViewState } from '../types';
import { deviceContext, imageExtent, paintCanvasIsolation, registerCanvasIsolation } from './canvas2dContext';
import { createColourGroup2d } from './colourGroup2d';
import type { ColourGroup2d } from './colourGroup2d';
import { paintPageScope, paintWorldScope, projectPage } from './compositorProjection';
import type { Compositor2DOptions, CompositorAppearance, CompositorCoverage, CompositorLayer, CreatedCompositor2D, IsolationPaintOptions, IsolationReservation, PaneCompositor, PaneSurfaceHost, TexturedQuadOptions } from './compositor.types';
import { RENDER_CONSTANTS as POLICY } from './constants';
import type { ByteLease, GfxLimits, GpuPass, RectI, TextureHandle } from './gfx/api';
import type { MemoryCacheHandle } from './memoryGovernor';
import type { BorrowedMirror } from './mirrorSet';
import type { MirrorFrame, MirrorPresentation, PreparedMirrorPresentation } from './paneLifecycle';
import type { PageStack } from './pageStack';
import type { ScheduledEncoding, ScheduledFrame, ScheduledSubmission } from './scheduler';
import { SurfaceBacking } from './surfaceBacking';
import { allocateSurfaceGeneration } from './surfaceGeneration';
import type { ReadySurfaceMetrics, SurfaceCommitTarget } from './surfaceMetrics';
import type { FrameBudget, FrameToken, GpuReleaseReason } from './types';

export const CANVAS2D_LIMITS: Readonly<GfxLimits> = Object.freeze({
    maxTexture2D: POLICY.maxSurfaceAxisPixels, maxRenderTargetSize: POLICY.maxSurfaceAxisPixels,
    maxViewport: [POLICY.maxSurfaceAxisPixels, POLICY.maxSurfaceAxisPixels] as const,
    maxSamples: 1, uniformAlignment: 1, maxUniformBytes: 0, maxTextureBindings: 0,
});

interface Buffer2D {
    readonly canvas: HTMLCanvasElement;
    readonly native: CanvasRenderingContext2D;
    readonly context: CanvasRenderingContext2D;
    readonly origin: { x: number; y: number };
    readonly lease: ByteLease;
    readonly images: Map<CanvasImageSource, ImageUse>;
}
interface ImageUse {
    readonly source: CanvasImageSource;
    readonly version: string;
    readonly bytes: number;
    lease: ByteLease | null;
    resident: boolean;
    admission: FrameBudget | null;
}
interface Crop {
    readonly rect: Rect;
    image: ImageBitmap | null;
    lease: ByteLease | null;
    pending: boolean;
}
interface ImageSourceState {
    readonly source: CanvasImageSource;
    readonly version: string;
    readonly crops: Map<string, Crop>;
    error: unknown;
}
interface Snapshot {
    readonly view: ViewState;
    readonly layers: readonly CompositorLayer[];
    readonly layout: Readonly<PageStack> | null;
    readonly appearance: CompositorAppearance;
    readonly metrics: ReadySurfaceMetrics | null;
    readonly serial: number;
}
interface MirrorJob {
    readonly key: string;
    readonly token: FrameToken;
    readonly buffer: Buffer2D;
    stage: 'upload' | 'colour' | 'copy';
    colour: ColourGroup2d | null;
    timer: ReturnType<typeof setTimeout> | null;
}
interface ColourJob {
    readonly key: string;
    readonly snapshot: Snapshot;
    readonly frame: ScheduledFrame;
    readonly back: Buffer2D;
    readonly band: Buffer2D;
    y: number;
    stage: 'render' | 'colour' | 'ready' | 'finished';
    colour: ColourGroup2d | null;
    admission: FrameBudget | null;
    timer: ReturnType<typeof setTimeout> | null;
}
const noMirror: MirrorPresentation = Object.freeze({ presented: false, complete: false, sharp: false, usedMirror: false });
const tileSize = POLICY.tileInteriorPixels;
const gutter = POLICY.tileGutterTexels;
const maxImagePixels = (tileSize + 2 * gutter) ** 2;

function sameToken(a: FrameToken | null, b: FrameToken): boolean {
    return !!a && a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration &&
        a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function validRect(rect: Readonly<Rect>): boolean {
    return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0;
}
function opaque(ctx: CanvasRenderingContext2D, appearance: CompositorAppearance): void {
    const [r, g, b] = appearance.background;
    ctx.save();
    try {
        ctx.resetTransform(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
        ctx.fillStyle = `rgb(${r * 255} ${g * 255} ${b * 255})`;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    } finally { ctx.restore(); }
}

/** The displayed canvas is never a working target. Incomplete uploads, isolated effects and CPU
 * inversion stay in governor-owned detached buffers until one complete frame can be copied (C4.2).
 * The compositor borrows layers; only the attaching lifecycle may release or dispose those layers.
 */
export class Canvas2DCompositor<T extends object> implements PaneCompositor {
    readonly backend = 'canvas2d' as const;
    readonly surface = document.createElement('canvas');
    readonly target: SurfaceCommitTarget;
    readonly resources: PaneCompositor['resources'];
    private readonly display: CanvasRenderingContext2D;
    private backing: SurfaceBacking | null = null;
    private displayReserved = 0;
    private working: MemoryCacheHandle | null = null;
    private cpu: MemoryCacheHandle | null = null;
    private readonly gpuLeases = new Set<ByteLease>();
    private readonly cpuLeases = new Set<ByteLease>();
    private gpuBytes = 0;
    private cpuBytes = 0;
    private readonly buffers = new Map<string, Buffer2D>();
    private readonly requests = new Map<string, { width: number; height: number; read: boolean }>();
    private readonly sources = new Map<CanvasImageSource, ImageSourceState>();
    private retained = new Set<CanvasImageSource>();
    private pendingSources = new Set<CanvasImageSource>();
    private readonly encodedSources = new Set<Set<CanvasImageSource>>();
    private retainedCrops = new Set<Crop>();
    private pendingCrops = new Set<Crop>();
    private readonly encodedCrops = new Set<Set<Crop>>();
    private sourceKey = '';
    private readonly contexts = new WeakMap<CanvasRenderingContext2D, Buffer2D>();
    private isolationBounds: Rect | null = null;
    private isolationDepth = 0;
    private maskDepth = 0;
    private externalTargets = 0;
    private multiply = false;
    private shortfall: { key: string; depth: number; bounds: Rect; multiply: boolean } | null = null;
    private admittedDepth = 0;
    private borrowedDepth = 0;
    private host: PaneSurfaceHost | null = null;
    private layers: readonly CompositorLayer[] = [];
    private layout: Readonly<PageStack> | null = null;
    private appearance: CompositorAppearance = { background: [0, 0, 0, 1], inverted: false };
    private metrics: ReadySurfaceMetrics | null = null;
    private scene: Snapshot | null = null;
    private budget: FrameBudget | null = null;
    private activeKey = '';
    private serial = 0;
    private generation = allocateSurfaceGeneration();
    private job: ColourJob | null = null;
    private mirrorJob: MirrorJob | null = null;
    private lastFrame: ScheduledFrame | null = null;
    private report: CompositorCoverage | null = null;
    private presentedKey = '';
    private missing = false;
    private busy = 0;
    private cropsPending = 0;
    private disposed = false;
    private asyncEpoch = 0;

    constructor(private readonly options: Compositor2DOptions<T>) {
        this.surface.width = 0; this.surface.height = 0;
        this.surface.style.width = '100%'; this.surface.style.height = '100%'; this.surface.style.display = 'block';
        const display = this.surface.getContext('2d', { alpha: false, colorSpace: 'srgb' });
        if (!display) throw new Error('Canvas 2D is unavailable');
        this.display = display;
        const resizeSurface = (width: number, height: number) => this.resize(width, height);
        this.target = Object.freeze({
            get generation() { return options.currentToken()?.deviceGeneration ?? 0; },
            limits: CANVAS2D_LIMITS,
            resizeSurface,
        });
        this.resources = Object.freeze({ owner: this, device: null,
            reserveIsolation: (request: IsolationReservation) => this.reserveIsolation(request),
            paintIsolation: paintCanvasIsolation,
            uniforms: () => { throw new Error('Uniforms require an active GPU draw scope'); },
            drawTexturedQuad: this.quad.bind(this) as PaneCompositor['resources']['drawTexturedQuad'] });
    }

    get surfaceGeneration(): number { return this.generation; }

    attach(host: PaneSurfaceHost): void {
        this.check();
        if (this.host && this.host !== host) this.detach();
        this.host = host; host.attach(this.surface);
    }
    detach(): void { const host = this.host; this.host = null; host?.detach(this.surface); }

    setLayers(layers: readonly CompositorLayer[]): void {
        this.check();
        const ids = new Set<string>();
        const objects = new Set<CompositorLayer['layer']>();
        let chrome = false;
        this.layers = Object.freeze(layers.map(binding => {
            if (!binding.id || ids.has(binding.id) || objects.has(binding.layer) ||
                !['document', 'chrome'].includes(binding.group) || chrome && binding.group === 'document') throw new TypeError('Invalid layer order');
            const effect = binding.isolation;
            if (effect && (!Number.isFinite(effect.opacity) || effect.opacity < 0 || effect.opacity > 1 ||
                !['normal', 'multiply'].includes(effect.blend))) throw new TypeError('Invalid isolation');
            ids.add(binding.id); objects.add(binding.layer); chrome ||= binding.group === 'chrome';
            return Object.freeze({ id: binding.id, layer: binding.layer, group: binding.group,
                isolation: effect ? Object.freeze({ ...effect }) : undefined, coverage: binding.coverage.bind(binding) });
        }));
        this.changed();
    }
    setLayout(stack: Readonly<PageStack> | null): void {
        this.check();
        if (stack && (!Number.isFinite(stack.width) || !Number.isFinite(stack.height) || stack.width < 0 || stack.height < 0 ||
            stack.rects.some(rect => !validRect(rect)))) throw new TypeError('Invalid page layout');
        this.layout = stack ? Object.freeze({ width: stack.width, height: stack.height,
            rects: Object.freeze(stack.rects.map(rect => Object.freeze({ ...rect }))) as unknown as PageStack['rects'] }) : null;
        this.changed();
    }
    setAppearance(appearance: CompositorAppearance): void {
        this.check();
        if (appearance.background.length !== 4 || appearance.background.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
            appearance.background[3] !== 1) throw new TypeError('Surrounding clear must be opaque');
        if (appearance.inverted === this.appearance.inverted && appearance.background.every((value, i) => value === this.appearance.background[i])) return;
        this.appearance = Object.freeze({ background: Object.freeze([...appearance.background]) as CompositorAppearance['background'], inverted: appearance.inverted });
        this.changed();
    }
    setMetrics(metrics: ReadySurfaceMetrics): void {
        this.check();
        const back = this.buffers.get('back');
        if (metrics.limits !== CANVAS2D_LIMITS || !back || back.canvas.width !== metrics.backingWidth || back.canvas.height !== metrics.backingHeight) {
            throw new Error('Uncommitted Canvas 2D metrics');
        }
        if (this.metrics?.backingWidth !== metrics.backingWidth || this.metrics?.backingHeight !== metrics.backingHeight ||
            this.metrics?.renderDpr !== metrics.renderDpr) this.changed();
        this.metrics = metrics;
    }
    snapshot(view: ViewState): void {
        this.check();
        if (this.scene && this.scene.view.epoch !== view.epoch) this.cancelJob();
        this.scene = { view, layers: this.layers, layout: this.layout, appearance: this.appearance, metrics: this.metrics, serial: this.serial };
        this.budget = null;
    }
    prepareFrame(frame: ScheduledFrame, budget: FrameBudget): void {
        this.check();
        const view = frame.view;
        if (this.scene?.view !== view || budget.cameraEpoch !== view.epoch || !sameToken(this.options.currentToken(), budget.token)) return;
        this.budget = budget;
        this.isolationBounds = null; this.isolationDepth = 0; this.maskDepth = 0;
        this.externalTargets = 0; this.multiply = false; this.admittedDepth = 0;
        // A draw-time shortfall survives budget-deferred retries of this scene, but cannot
        // grow the inventory of a later scene after its declarations have changed.
        const key = this.key(this.scene!, frame);
        if (this.shortfall?.key !== key) this.shortfall = null;
        if (this.shortfall) this.reserveIsolation({ ...this.shortfall, maskDepth: 0 });
        this.busy++;
        try {
            this.init();
            for (const [key, request] of this.requests) {
                if (budget.shouldYield()) break;
                if (this.allocate(key, request.width, request.height, request.read)) this.requests.delete(key);
            }
            this.prepareCrops(budget);
            for (const buffer of this.buffers.values()) for (const use of buffer.images.values()) {
                if (use.resident || budget.shouldYield()) continue;
                if (!use.lease) use.lease = this.reserveGpu(use.bytes);
                if (use.lease && budget.claimUpload(use.bytes)) use.admission = budget;
            }
            const job = this.job;
            if (job?.stage === 'colour' && job.timer === null) this.scheduleColour(job);
            if (this.mirrorJob?.stage === 'colour' && this.mirrorJob.timer === null) this.scheduleMirrorColour(this.mirrorJob);
            if (job?.stage === 'ready' && !budget.shouldYield() && budget.claimUpload(job.band.canvas.width * job.band.canvas.height * 4)) {
                job.admission = budget;
            }
        } finally { this.busy--; }
    }

    finishPrepareFrame(frame: ScheduledFrame, budget: FrameBudget): void {
        this.check();
        if (frame.view !== this.scene?.view || frame.frameId !== budget.frameId || !sameToken(this.options.currentToken(), frame.token)) return;
        this.busy++;
        try { this.admitIsolation(frame, budget, true); }
        finally { this.busy--; }
    }

    reserveIsolation(request: IsolationReservation): void {
        const counts = [request.depth, request.maskDepth, request.targets?.count ?? 0];
        if (counts.some(value => !Number.isSafeInteger(value) || value < 0) || !validRect(request.bounds) ||
            request.targets && !validRect(request.targets.bounds) || request.samples !== undefined && ![1, 4].includes(request.samples) ||
            request.format !== undefined && !['rgba8', 'r8'].includes(request.format)) throw new TypeError('Invalid isolation inventory');
        this.isolationDepth = Math.max(this.isolationDepth, request.depth);
        this.maskDepth = Math.max(this.maskDepth, request.maskDepth);
        this.externalTargets = Math.max(this.externalTargets, request.targets?.count ?? 0);
        this.multiply ||= !!request.multiply;
        const union = (bounds: Readonly<Rect>) => {
            const old = this.isolationBounds;
            if (!old) { this.isolationBounds = { ...bounds }; return; }
            const x = Math.min(old.x, bounds.x), y = Math.min(old.y, bounds.y);
            this.isolationBounds = { x, y, width: Math.max(old.x + old.width, bounds.x + bounds.width) - x,
                height: Math.max(old.y + old.height, bounds.y + bounds.height) - y };
        };
        union(request.bounds);
        if (request.targets) union(request.targets.bounds);
    }

    private admitIsolation(frame: ScheduledFrame, budget: FrameBudget, reconcile = false): void {
        const snapshot = this.scene;
        if (!snapshot?.metrics) return;
        if (this.borrowedDepth || this.encodedSources.size) { this.options.invalidate('2d-isolation-admission-deferred'); return; }
        const own = snapshot.layers.filter(binding => binding.isolation && binding.isolation.opacity > 0);
        for (const binding of own) this.reserveIsolation({ depth: 0, maskDepth: 0,
            bounds: binding.isolation!.bounds?.(frame) ?? { x: 0, y: 0, width: snapshot.metrics.backingWidth, height: snapshot.metrics.backingHeight },
            multiply: binding.isolation!.blend === 'multiply' });
        const bounds = this.isolationBounds;
        const left = bounds ? Math.max(0, Math.floor(bounds.x)) : 0, top = bounds ? Math.max(0, Math.floor(bounds.y)) : 0;
        const right = bounds ? Math.min(snapshot.metrics.backingWidth, Math.ceil(bounds.x + bounds.width)) : 0;
        const bottom = bounds ? Math.min(snapshot.metrics.backingHeight, Math.ceil(bounds.y + bounds.height)) : 0;
        const count = right > left && bottom > top
            ? this.isolationDepth + this.maskDepth + this.externalTargets + Number(own.length > 0) + Number(this.multiply) : 0;
        if (!Number.isSafeInteger(count)) throw new RangeError('Isolation depth exceeds safe accounting');
        const mayShrink = reconcile && !this.borrowedDepth && !this.encodedSources.size;
        if (mayShrink) for (const [key, buffer] of this.buffers) {
            if (key.startsWith('isolation-pool:') && Number(key.slice('isolation-pool:'.length)) >= count) this.closeBuffer(key, buffer);
        }
        this.admittedDepth = 0;
        for (let i = 0; i < count; i++) {
            const key = `isolation-pool:${i}`;
            const old = this.buffers.get(key);
            const width = mayShrink ? right - left : Math.max(old?.canvas.width ?? 0, right - left);
            const height = mayShrink ? bottom - top : Math.max(old?.canvas.height ?? 0, bottom - top);
            if (old && old.canvas.width === width && old.canvas.height === height) { this.admittedDepth++; continue; }
            if (budget.shouldYield() && old && old.canvas.width >= width && old.canvas.height >= height) {
                this.admittedDepth++; this.options.invalidate('2d-isolation-shrink-deferred'); continue;
            }
            if (budget.shouldYield() || !this.allocate(key, width, height, false)) {
                this.options.invalidate('2d-isolation-admission-deferred'); return;
            }
            this.admittedDepth++;
        }
    }

    paintIsolation(ctx: CanvasRenderingContext2D, bounds: Readonly<RectI>, options: IsolationPaintOptions,
        paint: (isolatedCtx: CanvasRenderingContext2D) => void): void {
        const target = this.contexts.get(ctx);
        if (!target || !validRect(bounds) || !Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1 ||
            !['normal', 'multiply'].includes(options.blend)) throw new TypeError('Invalid 2D isolation scope');
        if (options.opacity === 0) return;
        const left = Math.max(target.origin.x, Math.floor(bounds.x)), top = Math.max(target.origin.y, Math.floor(bounds.y));
        const right = Math.min(target.origin.x + target.canvas.width, Math.ceil(bounds.x + bounds.width));
        const bottom = Math.min(target.origin.y + target.canvas.height, Math.ceil(bounds.y + bounds.height));
        if (right <= left || bottom <= top) return;
        const index = this.borrowedDepth;
        const buffer = this.buffers.get(`isolation-pool:${index}`);
        if (index >= this.admittedDepth || !buffer || buffer.canvas.width < right - left || buffer.canvas.height < bottom - top) {
            const own = Number(!!this.scene?.layers.some(binding => binding.isolation && binding.isolation.opacity > 0));
            const depth = Math.max(0, index + 1 - own), multiply = options.blend === 'multiply';
            const previous = this.shortfall?.key === this.activeKey ? this.shortfall : null;
            const x = Math.min(previous?.bounds.x ?? bounds.x, bounds.x), y = Math.min(previous?.bounds.y ?? bounds.y, bounds.y);
            this.shortfall = { key: this.activeKey, depth: Math.max(previous?.depth ?? 0, depth), multiply: !!previous?.multiply || multiply,
                bounds: { x, y, width: Math.max((previous?.bounds.x ?? bounds.x) + (previous?.bounds.width ?? bounds.width), bounds.x + bounds.width) - x,
                    height: Math.max((previous?.bounds.y ?? bounds.y) + (previous?.bounds.height ?? bounds.height), bounds.y + bounds.height) - y } };
            this.missing = true; this.options.invalidate('2d-isolation-shortfall'); return;
        }
        this.borrowedDepth++;
        this.clear(buffer, left, top);
        const lease = Proxy.revocable(buffer.context, {});
        this.contexts.set(lease.proxy, buffer);
        registerCanvasIsolation(lease.proxy, this.paintIsolation.bind(this));
        buffer.native.save();
        try {
            buffer.native.resetTransform(); buffer.native.beginPath();
            buffer.native.rect(0, 0, right - left, bottom - top); buffer.native.clip();
            const properties = ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
                'font', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'textRendering', 'textAlign', 'textBaseline', 'direction',
                'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'filter', 'imageSmoothingEnabled', 'imageSmoothingQuality',
                'globalAlpha', 'globalCompositeOperation'] as const;
            for (const property of properties) Reflect.set(lease.proxy, property, Reflect.get(ctx, property));
            lease.proxy.setLineDash(ctx.getLineDash());
            lease.proxy.setTransform(ctx.getTransform());
            lease.proxy.beginPath(); paint(lease.proxy);
        } finally { buffer.native.restore(); lease.revoke(); this.borrowedDepth--; }
        target.native.save();
        try {
            target.native.resetTransform(); target.native.globalAlpha = options.opacity;
            target.native.globalCompositeOperation = options.blend === 'multiply' ? 'multiply' : 'source-over';
            const start = performance.now();
            try { target.native.drawImage(buffer.canvas, 0, 0, right - left, bottom - top,
                left - target.origin.x, top - target.origin.y, right - left, bottom - top); }
            finally { this.options.recordUpload(0, performance.now() - start); }
        } finally { target.native.restore(); }
    }

    encode(frame: ScheduledFrame): ScheduledEncoding | null {
        this.check();
        this.lastFrame = frame;
        const snapshot = this.scene;
        const budget = this.budget;
        const back = this.buffers.get('back');
        if (this.encodedSources.size || !snapshot?.metrics || snapshot.view !== frame.view || !back || !budget || budget.frameId !== frame.frameId ||
            !sameToken(this.options.currentToken(), frame.token)) return null;
        const key = this.key(snapshot, frame);
        this.activeKey = key;
        this.beginSources(key);
        const availability = snapshot.layers.map(binding => binding.coverage(frame, this.backend));
        if (availability.some(item => !item.complete)) return null;
        this.missing = false;
        this.busy++;
        try {
            if (this.job && this.job.key !== key) this.cancelJob();
            if (this.presentedKey !== key) {
                if (snapshot.appearance.inverted && snapshot.layers.some(layer => layer.group === 'document')) {
                    if (!this.paintInverted(snapshot, frame, back, key)) return null;
                } else {
                    opaque(back.native, snapshot.appearance);
                    this.paintBindings(snapshot.layers, back, snapshot, frame);
                    if (this.missing) { this.options.invalidate('2d-prepare-required'); return null; }
                }
            }
            // Another pane's admission may trim caches between encode and submit. Pin this complete
            // detached frame until consumed; eviction must not turn it into a zero-size display copy.
            this.busy++;
            const encodedSources = new Set(this.pendingSources), encodedCrops = new Set(this.pendingCrops);
            this.encodedSources.add(encodedSources); this.encodedCrops.add(encodedCrops);
            let done = false;
            const release = () => { done = true; this.busy--; this.encodedSources.delete(encodedSources);
                this.encodedCrops.delete(encodedCrops); this.pruneSources(); };
            return {
                submit: () => {
                    if (done) throw new Error('Canvas encoding already consumed');
                    try {
                    if (this.disposed || this.scene !== snapshot || !sameToken(this.options.currentToken(), frame.token)) return null;
                    if (this.presentedKey !== key && !this.publish(back, snapshot.metrics!)) return null;
                    this.presentedKey = key;
                    this.retained = encodedSources; this.retainedCrops = encodedCrops;
                    this.report = Object.freeze({ frameId: frame.frameId, token: frame.token, presented: true,
                        complete: true, sharp: snapshot.metrics!.qualityScale === 1 && availability.every(item => item.sharp && !item.staleVersion),
                        staleVersion: availability.some(item => item.staleVersion), qualityScale: snapshot.metrics!.qualityScale });
                    return { drawn: frame.layers.map(item => ({ layer: item.layer, sceneRevision: item.sceneRevision })) } satisfies ScheduledSubmission;
                    } finally { release(); }
                },
                discard: () => { if (!done) release(); },
            };
        } finally { this.busy--; }
    }

    coverage(frame: ScheduledFrame): CompositorCoverage {
        if (this.report?.frameId === frame.frameId && sameToken(this.report.token, frame.token)) return this.report;
        return { frameId: frame.frameId, token: frame.token, presented: false, complete: false, sharp: false,
            qualityScale: this.scene?.metrics?.qualityScale ?? 0 };
    }
    page(view: ViewState, index: number) { return projectPage(this.scene ? this.scene.layout : this.layout, view, index); }
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void { paintWorldScope(ctx, view, paint); }
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void { paintPageScope(ctx, this.page(view, index), paint); }

    /** Mirror admission belongs to lifecycle. Partial admitted uploads may warm a detached target,
     * never the display: otherwise a multi-tile frame larger than one admission could never progress.
     */
    prepareMirror(frame: MirrorFrame<T>): PreparedMirrorPresentation {
        const back = this.buffers.get('back');
        const generation = this.generation;
        const key = JSON.stringify([frame.revision, frame.view, this.serial, generation]);
        if (this.mirrorJob?.key !== key) this.cancelMirror();
        const buffer = back ? this.requested('mirror', back.canvas.width, back.canvas.height, true) : null;
        if (!buffer) this.options.invalidate('2d-mirror-buffer');
        if (buffer && !this.mirrorJob) this.mirrorJob = { key, token: frame.budget.token, buffer, stage: 'upload', colour: null, timer: null };
        const job = this.mirrorJob;
        const selected: { entry: BorrowedMirror<T>; quad: NonNullable<ReturnType<Compositor2DOptions<T>['mirrorQuad']>> }[] = [];
        if (job?.stage === 'upload') for (const entry of frame.entries) {
            const quad = this.options.mirrorQuad(entry, frame.view);
            if (quad && validRect(quad.sourceRect) && validRect(quad.destRect) && frame.claimImplicit(entry.entry.id)) selected.push({ entry, quad });
        }
        let done = false;
        return {
            discard: () => { done = true; },
            submit: () => {
                if (done) throw new Error('Mirror preparation already consumed');
                done = true;
                if (this.encodedSources.size || !back || !job || this.mirrorJob !== job || this.disposed || this.generation !== generation ||
                    !sameToken(this.options.currentToken(), frame.budget.token)) return noMirror;
                this.busy++;
                try {
                    if (job.stage === 'upload') {
                        this.clear(job.buffer, 0, 0);
                        const drawn: BorrowedMirror<T>[] = [];
                        for (const { entry, quad } of selected) {
                            if (!frame.mayDrawImplicit(entry.entry.id)) break;
                            const start = performance.now();
                            let succeeded = false;
                            try {
                                const s = quad.sourceRect, d = quad.destRect;
                                job.buffer.native.drawImage(quad.image, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
                                succeeded = true; drawn.push(entry);
                            } finally { frame.recordImplicit(entry.entry.id, performance.now() - start, succeeded); }
                        }
                        const actual = this.options.mirrorCoverage(frame.view, drawn);
                        if (!actual.complete) { this.options.invalidate('2d-mirror-upload-deferred'); return noMirror; }
                        if (this.appearance.inverted) {
                            job.colour = createColourGroup2d(job.buffer.native, { x: 0, y: 0, width: job.buffer.canvas.width, height: job.buffer.canvas.height });
                            job.stage = 'colour'; this.scheduleMirrorColour(job); return noMirror;
                        }
                        job.stage = 'copy';
                    }
                    if (job.stage !== 'copy' || !this.metrics) return noMirror;
                    this.activeKey = `mirror:${key}`; this.beginSources(this.activeKey); this.missing = false;
                    opaque(back.native, this.appearance);
                    const full = { x: 0, y: 0, width: back.canvas.width, height: back.canvas.height };
                    this.image(back, job.buffer.canvas, full, full);
                    const current = this.lastFrame;
                    const scene = this.scene;
                    if (!current || current.frameId !== frame.budget.frameId || !scene) return noMirror;
                    const chrome = scene.layers.filter(layer => layer.group === 'chrome');
                    if (chrome.some(layer => !layer.coverage(current, this.backend).complete)) return noMirror;
                    this.paintBindings(chrome, back, scene, current);
                    if (this.missing) { this.options.invalidate('2d-mirror-copy-prepare'); return noMirror; }
                    const actual = this.options.mirrorCoverage(frame.view, frame.entries);
                    if (!actual.complete || !this.publish(back, this.metrics)) return noMirror;
                    this.presentedKey = '';
                    this.retained = new Set(this.pendingSources); this.retainedCrops = new Set(this.pendingCrops); this.pruneSources();
                    return { presented: true, complete: true, sharp: actual.sharp && !actual.staleVersion, staleVersion: actual.staleVersion, usedMirror: true };
                } finally { this.busy--; }
            },
        };
    }

    releaseGpu(_reason: GpuReleaseReason): void {
        if (this.disposed) return;
        this.dropWork();
        this.surface.width = 0; this.surface.height = 0;
        this.backing?.releaseZeroed(); this.displayReserved = 0;
        this.metrics = null; this.scene = null; this.report = null; this.presentedKey = '';
        this.generation = allocateSurfaceGeneration();
    }
    dispose(): void {
        if (this.disposed) return;
        this.detach(); this.releaseGpu('hidden');
        this.backing?.close(); this.working?.close(); this.cpu?.close();
        this.disposed = true;
    }

    private check(): void { if (this.disposed) throw new Error('Canvas compositor is disposed'); }
    private changed(): void { this.serial++; this.cancelJob(); this.cancelMirror(); this.report = null; }
    private key(snapshot: Snapshot, frame: ScheduledFrame): string {
        const t = frame.token, v = frame.view;
        return JSON.stringify([t.vaultEpoch, t.documentId, t.bytesGeneration, t.session, t.viewLease, t.deviceGeneration,
            v.epoch, v.camera.x, v.camera.y, v.camera.z, v.viewport.width, v.viewport.height, v.viewport.dpr,
            snapshot.serial, frame.layers.map(item => item.sceneRevision)]);
    }
    private init(): boolean {
        if (this.working && this.cpu && this.backing) return true;
        const owner = this.options.currentToken();
        if (!owner) return false;
        const now = performance.now();
        const id = `canvas2d:${this.options.paneId}:${this.generation}`;
        const common = { paneId: this.options.paneId, owner, class: 'critical' as const, hiddenAt: null, lastUsedAt: now, lastVisibleAt: now };
        this.working ??= this.options.governor.register({ ...common, id: `${id}:working`, pool: 'gpu', kind: 'canvas-working',
            memory: () => ({ live: this.gpuBytes, retiring: 0 }),
            evict: () => { if (!this.busy) { this.dropWork(); this.options.invalidate('geometry'); } } });
        this.cpu ??= this.options.governor.register({ ...common, id: `${id}:cpu`, pool: 'cpu', kind: 'working',
            memory: () => ({ live: this.cpuBytes, retiring: 0 }),
            evict: () => { if (!this.busy) { this.dropWork(); this.options.invalidate('geometry'); } } });
        this.backing ??= new SurfaceBacking({ governor: this.options.governor, paneId: this.options.paneId,
            owner, id: `${id}:surface`, canvas: this.surface, displayed: true, now });
        return true;
    }
    private reserveGpu(bytes: number): ByteLease | null {
        const lease = this.working?.reserve(bytes) ?? null;
        if (lease) { this.gpuLeases.add(lease); this.gpuBytes += lease.bytes; }
        return lease;
    }
    private releaseGpuLease(lease: ByteLease | null): void {
        if (lease && this.gpuLeases.delete(lease)) { this.gpuBytes -= lease.bytes; this.working!.release(lease); }
    }
    private reserveCpu(bytes: number): ByteLease | null {
        const lease = this.cpu?.reserve(bytes) ?? null;
        if (lease) { this.cpuLeases.add(lease); this.cpuBytes += lease.bytes; }
        return lease;
    }
    private releaseCpuLease(lease: ByteLease | null): void {
        if (lease && this.cpuLeases.delete(lease)) { this.cpuBytes -= lease.bytes; this.cpu!.release(lease); }
    }
    private resize(width: number, height: number) {
        this.check();
        const token = this.options.currentToken();
        const result = (complete: boolean) => ({ width, height, generation: token?.deviceGeneration ?? 0, complete });
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0 ||
            width > POLICY.maxSurfaceAxisPixels || height > POLICY.maxSurfaceAxisPixels || width * height > POLICY.maxSurfacePixels) throw new RangeError('Invalid CPU backing');
        if (this.encodedSources.size) return result(false);
        this.busy++;
        try {
            if (!this.init()) return result(false);
            const bytes = width * height * POLICY.surfaceReserveBytesPerPixel;
            if (bytes > this.displayReserved) {
                if (!this.backing!.reserve(bytes - this.displayReserved)) return result(false);
                this.displayReserved = bytes;
            }
            const old = this.buffers.get('back');
            if (old && (old.canvas.width !== width || old.canvas.height !== height)) this.dropWork();
            if (!this.allocate('back', width, height, false)) return result(false);
            if (old !== this.buffers.get('back')) { this.cancelJob(); this.generation = allocateSurfaceGeneration(); }
            return result(true);
        } finally { this.busy--; }
    }
    private allocate(key: string, width: number, height: number, read: boolean): Buffer2D | null {
        const existing = this.buffers.get(key);
        if (existing?.canvas.width === width && existing.canvas.height === height) return existing;
        if (existing) this.closeBuffer(key, existing);
        const lease = this.reserveGpu(width * height * POLICY.surfaceReserveBytesPerPixel);
        if (!lease) return null;
        const canvas = document.createElement('canvas');
        let buffer: Buffer2D | null = null;
        try {
            canvas.width = width; canvas.height = height;
            const native = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb', willReadFrequently: read });
            if (!native || native.isContextLost()) throw new Error('CPU working surface allocation failed');
            const origin = { x: 0, y: 0 };
            const context = deviceContext(native, origin, (source, src, dst) => this.image(buffer!, source, src, dst));
            buffer = { canvas, native, context, origin, lease, images: new Map() };
            this.buffers.set(key, buffer);
            this.contexts.set(context, buffer); this.contexts.set(native, buffer);
            registerCanvasIsolation(context, this.paintIsolation.bind(this));
            registerCanvasIsolation(native, this.paintIsolation.bind(this));
            return buffer;
        } catch (error) { canvas.width = 0; canvas.height = 0; this.releaseGpuLease(lease); throw error; }
    }
    private requested(key: string, width: number, height: number, read = false): Buffer2D | null {
        const buffer = this.buffers.get(key);
        if (buffer?.canvas.width === width && buffer.canvas.height === height) return buffer;
        this.requests.set(key, { width, height, read }); this.missing = true;
        return null;
    }
    private closeBuffer(key: string, buffer: Buffer2D): void {
        buffer.canvas.width = 0; buffer.canvas.height = 0;
        for (const use of buffer.images.values()) this.releaseGpuLease(use.lease);
        this.releaseGpuLease(buffer.lease); this.buffers.delete(key);
    }
    private clear(buffer: Buffer2D, x: number, y: number): void {
        buffer.origin.x = x; buffer.origin.y = y;
        buffer.native.resetTransform(); buffer.native.clearRect(0, 0, buffer.canvas.width, buffer.canvas.height);
        buffer.context.resetTransform();
    }
    private paintBindings(bindings: readonly CompositorLayer[], target: Buffer2D, snapshot: Snapshot, frame: ScheduledFrame): void {
        for (const binding of bindings) {
            const effect = binding.isolation;
            if (!effect) {
                target.context.save();
                try { target.context.resetTransform(); target.context.beginPath(); binding.layer.draw2d(target.context, snapshot.view); }
                finally { target.context.restore(); }
                continue;
            }
            const bounds = effect.bounds?.(frame) ?? { x: 0, y: 0, width: snapshot.metrics!.backingWidth, height: snapshot.metrics!.backingHeight };
            this.paintIsolation(target.context, bounds, effect, isolated => {
                isolated.resetTransform(); isolated.beginPath(); binding.layer.draw2d(isolated, snapshot.view);
            });
        }
    }
    private paintInverted(snapshot: Snapshot, frame: ScheduledFrame, back: Buffer2D, key: string): boolean {
        if (!this.job) {
            // A band never exceeds the scheduler's one-tile progress admission, even at width8192.
            const rows = Math.max(1, Math.min(256, snapshot.metrics!.backingHeight, Math.floor(maxImagePixels / back.canvas.width)));
            const band = this.requested('document', back.canvas.width, rows, true);
            if (!band) { this.options.invalidate('2d-document-buffer'); return false; }
            opaque(back.native, snapshot.appearance);
            this.job = { key, snapshot, frame, back, band, y: 0, stage: 'render', colour: null, admission: null, timer: null };
        }
        const job = this.job;
        if (job.stage === 'colour') return false;
        if (job.stage === 'ready') {
            const admission = job.admission;
            if (!admission || admission.frameId !== frame.frameId || performance.now() >= admission.upload.deadline) {
                this.options.invalidate('2d-colour-upload-deferred'); return false;
            }
            const bytes = job.band.canvas.width * job.band.canvas.height * 4;
            this.blit(back.native, job.band.canvas, 0, job.y, bytes);
            job.y += job.band.canvas.height; job.stage = job.y < back.canvas.height ? 'render' : 'finished'; job.admission = null;
        }
        if (job.stage === 'render') {
            this.clear(job.band, 0, job.y);
            this.paintBindings(snapshot.layers.filter(layer => layer.group === 'document'), job.band, snapshot, frame);
            if (this.missing) { this.options.invalidate('2d-document-prepare'); return false; }
            job.colour = createColourGroup2d(job.band.native, { x: 0, y: 0, width: job.band.canvas.width, height: job.band.canvas.height });
            job.stage = 'colour'; this.scheduleColour(job);
            return false;
        }
        this.paintBindings(snapshot.layers.filter(layer => layer.group === 'chrome'), back, snapshot, frame);
        if (this.missing) {
            // Retry from clean document pixels: replaying translucent chrome onto its own incomplete
            // attempt would accumulate alpha even though the underlying document revision is unchanged.
            this.cancelJob(); this.options.invalidate('2d-chrome-prepare'); return false;
        }
        return true;
    }
    private scheduleColour(job: ColourJob): void {
        if (job.timer !== null) return;
        job.timer = setTimeout(() => {
            job.timer = null;
            if (this.disposed || this.job !== job || !sameToken(this.options.currentToken(), job.frame.token)) return;
            const deadline = performance.now() + POLICY.frameTargetMaxMs;
            let scratch: ByteLease | null = null;
            let denied = false;
            this.busy++;
            try {
                const complete = job.colour!.step({ shouldYield: () => performance.now() >= deadline,
                    claim: bytes => {
                        this.releaseCpuLease(scratch); scratch = this.reserveCpu(bytes);
                        denied ||= !scratch; return !!scratch;
                    } });
                if (complete) { job.stage = 'ready'; this.options.invalidate('2d-colour-ready'); }
                else if (denied) { job.stage = 'colour'; this.options.invalidate('2d-colour-memory'); }
                else this.scheduleColour(job);
            } finally { this.releaseCpuLease(scratch); this.busy--; }
        }, 0);
    }
    private scheduleMirrorColour(job: MirrorJob): void {
        if (job.timer !== null) return;
        job.timer = setTimeout(() => {
            job.timer = null;
            if (this.disposed || this.mirrorJob !== job || !sameToken(this.options.currentToken(), job.token)) return;
            const deadline = performance.now() + POLICY.frameTargetMaxMs;
            let scratch: ByteLease | null = null;
            let denied = false;
            this.busy++;
            try {
                const complete = job.colour!.step({ shouldYield: () => performance.now() >= deadline,
                    claim: bytes => { this.releaseCpuLease(scratch); scratch = this.reserveCpu(bytes); denied ||= !scratch; return !!scratch; } });
                if (complete) { job.stage = 'copy'; this.options.invalidate('2d-mirror-colour-ready'); }
                else if (denied) this.options.invalidate('2d-mirror-colour-memory');
                else this.scheduleMirrorColour(job);
            } finally { this.releaseCpuLease(scratch); this.busy--; }
        }, 0);
    }
    private cancelMirror(): void {
        if (this.mirrorJob?.timer !== null && this.mirrorJob?.timer !== undefined) clearTimeout(this.mirrorJob.timer);
        this.mirrorJob = null;
    }
    private cancelJob(): void {
        if (this.job?.timer !== null && this.job?.timer !== undefined) clearTimeout(this.job.timer);
        this.job = null;
    }
    private blit(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, x: number, y: number, bytes = 0): void {
        const start = performance.now();
        try { ctx.drawImage(source, x, y); }
        finally { this.options.recordUpload(bytes, performance.now() - start); }
    }
    private publish(back: Buffer2D, metrics: ReadySurfaceMetrics): boolean {
        if (back.canvas.width !== metrics.backingWidth || back.canvas.height !== metrics.backingHeight ||
            back.native.isContextLost() || this.display.isContextLost() || !this.backing ||
            this.displayReserved < back.canvas.width * back.canvas.height * POLICY.surfaceReserveBytesPerPixel) return false;
        // All content/leases are ready before this first write to the displayed surface. The final
        // operation is one whole-frame copy, never a sequence of layer writes to visible pixels.
        const actual = this.backing.resize(back.canvas.width, back.canvas.height, (width, height) => {
            if (this.surface.width !== width) this.surface.width = width;
            if (this.surface.height !== height) this.surface.height = height;
            return { width: this.surface.width, height: this.surface.height, complete: true, generation: this.target.generation };
        });
        if (!actual?.complete) return false;
        this.display.save();
        try { this.display.resetTransform(); this.display.globalAlpha = 1; this.display.globalCompositeOperation = 'copy'; this.blit(this.display, back.canvas, 0, 0); }
        finally { this.display.restore(); }
        this.displayReserved = this.backing.reservedBytes;
        return metrics.backingWidth === this.surface.width && metrics.backingHeight === this.surface.height;
    }

    private quad(ctx: CanvasRenderingContext2D | GpuPass, image: ImageBitmap | TextureHandle,
        sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void {
        if (!('drawImage' in ctx) || !(image instanceof ImageBitmap)) throw new TypeError('A CPU quad needs a 2D context and ImageBitmap');
        if (!validRect(sourceRect) || !validRect(destRect) || !Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1) throw new TypeError('Invalid image quad');
        ctx.save();
        try {
            ctx.resetTransform(); ctx.globalAlpha *= options.opacity; ctx.imageSmoothingEnabled = options.sampling === 'linear';
            ctx.drawImage(image, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, destRect.x, destRect.y, destRect.width, destRect.height);
        } finally { ctx.restore(); }
    }
    private image(buffer: Buffer2D, source: CanvasImageSource, src: Rect, dst: Rect): void {
        this.pendingSources.add(source);
        const extent = imageExtent(source);
        if (extent.width * extent.height <= maxImagePixels) {
            this.drawImage(buffer, source, src, dst);
            return;
        }
        const version = source instanceof ImageBitmap ? '' : this.activeKey;
        let state = this.sources.get(source);
        if (state && state.version !== version) { this.closeSource(state); this.sources.delete(source); state = undefined; }
        if (!state) { state = { source, version, crops: new Map(), error: null }; this.sources.set(source, state); }
        if (state.error) throw state.error;
        const x0 = Math.max(0, src.x), y0 = Math.max(0, src.y);
        const x1 = Math.min(extent.width, src.x + src.width), y1 = Math.min(extent.height, src.y + src.height);
        for (let y = Math.floor(y0 / tileSize) * tileSize; y < y1; y += tileSize) for (let x = Math.floor(x0 / tileSize) * tileSize; x < x1; x += tileSize) {
            const left = Math.max(x0, x), top = Math.max(y0, y);
            const right = Math.min(x1, x + tileSize), bottom = Math.min(y1, y + tileSize);
            const dest = { x: dst.x + (left - src.x) / src.width * dst.width, y: dst.y + (top - src.y) / src.height * dst.height,
                width: (right - left) / src.width * dst.width, height: (bottom - top) / src.height * dst.height };
            const matrix = buffer.native.getTransform();
            const corners = [[dest.x, dest.y], [dest.x + dest.width, dest.y], [dest.x, dest.y + dest.height], [dest.x + dest.width, dest.y + dest.height]]
                .map(([px, py]) => matrix.transformPoint({ x: px, y: py }));
            if (Math.max(...corners.map(p => p.x)) <= 0 || Math.min(...corners.map(p => p.x)) >= buffer.canvas.width ||
                Math.max(...corners.map(p => p.y)) <= 0 || Math.min(...corners.map(p => p.y)) >= buffer.canvas.height) continue;
            const id = `${x}:${y}`;
            let crop = state.crops.get(id);
            if (!crop) {
                const sx = Math.max(0, x - gutter), sy = Math.max(0, y - gutter);
                crop = { rect: { x: sx, y: sy, width: Math.min(extent.width, x + tileSize + gutter) - sx,
                    height: Math.min(extent.height, y + tileSize + gutter) - sy }, image: null, lease: null, pending: false };
                state.crops.set(id, crop);
            }
            this.pendingCrops.add(crop);
            if (!crop.image) { this.missing = true; continue; }
            this.drawImage(buffer, crop.image, { x: left - crop.rect.x, y: top - crop.rect.y, width: right - left, height: bottom - top }, dest);
        }
    }
    private drawImage(buffer: Buffer2D, source: CanvasImageSource, src: Rect, dst: Rect): void {
        this.pendingSources.add(source);
        const version = source instanceof ImageBitmap ? '' : this.activeKey;
        let use = buffer.images.get(source);
        if (use && use.version !== version) { this.releaseGpuLease(use.lease); buffer.images.delete(source); use = undefined; }
        if (!use) {
            const extent = imageExtent(source);
            use = { source, version, bytes: extent.width * extent.height * 4, resident: false, lease: null, admission: null };
            buffer.images.set(source, use);
        }
        if (!use.resident && (!use.admission || use.admission.frameId !== this.budget?.frameId || performance.now() >= use.admission.upload.deadline)) {
            this.missing = true; return;
        }
        const bytes = use.resident ? 0 : use.bytes;
        const start = performance.now();
        try {
            buffer.native.drawImage(source, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height);
            use.resident = true; use.admission = null;
        } finally { this.options.recordUpload(bytes, performance.now() - start); }
    }
    private prepareCrops(budget: FrameBudget): void {
        for (const state of this.sources.values()) for (const [id, crop] of state.crops) {
            if (budget.shouldYield() || this.cropsPending >= 2) return;
            if (crop.image || crop.pending || state.error) continue;
            const lease = this.reserveCpu(crop.rect.width * crop.rect.height * 4);
            if (!lease) return;
            crop.lease = lease; crop.pending = true; this.cropsPending++;
            const epoch = this.asyncEpoch;
            const token = budget.token;
            const r = crop.rect;
            void createImageBitmap(state.source, r.x, r.y, r.width, r.height, { colorSpaceConversion: 'none', premultiplyAlpha: 'premultiply' }).then(image => {
                const current = this.options.currentToken();
                if (this.disposed || epoch !== this.asyncEpoch || this.sources.get(state.source) !== state || !current ||
                    current.vaultEpoch !== token.vaultEpoch || current.documentId !== token.documentId ||
                    current.bytesGeneration !== token.bytesGeneration || current.session !== token.session || state.crops.get(id) !== crop) {
                    image.close(); this.releaseCpuLease(lease); crop.lease = null; crop.pending = false; return;
                }
                crop.image = image; crop.pending = false;
                this.options.invalidate('2d-image-crop-ready');
            }, error => {
                this.releaseCpuLease(lease); crop.lease = null; crop.pending = false;
                if (!this.disposed && epoch === this.asyncEpoch && this.sources.get(state.source) === state && state.crops.get(id) === crop) { state.error = error; this.options.invalidate('2d-image-crop-failed'); }
            }).finally(() => { this.cropsPending--; });
        }
    }
    // A retry may need crops discovered by earlier partial bands; the last complete frame and
    // any unconsumed encoding stay pinned until its replacement is actually published.
    private beginSources(key: string): void {
        if (this.sourceKey === key) return;
        this.sourceKey = key;
        this.pendingSources = new Set(); this.pendingCrops = new Set();
        this.pruneSources();
    }
    private pruneSources(): void {
        const pinned = (source: CanvasImageSource) => {
            if (this.retained.has(source) || this.pendingSources.has(source)) return true;
            for (const sources of this.encodedSources) if (sources.has(source)) return true;
            return false;
        };
        const cropPinned = (crop: Crop) => {
            if (this.retainedCrops.has(crop) || this.pendingCrops.has(crop)) return true;
            for (const crops of this.encodedCrops) if (crops.has(crop)) return true;
            return false;
        };
        for (const [source, state] of this.sources) {
            if (!pinned(source)) { this.sources.delete(source); this.closeSource(state); continue; }
            for (const [id, crop] of state.crops) if (!cropPinned(crop)) {
                state.crops.delete(id); this.closeCrop(crop);
            }
        }
        for (const buffer of this.buffers.values()) for (const [source, use] of buffer.images) if (!pinned(source)) {
            this.releaseGpuLease(use.lease); buffer.images.delete(source);
        }
    }
    private closeSource(state: ImageSourceState): void {
        for (const crop of state.crops.values()) this.closeCrop(crop);
    }
    private closeCrop(crop: Crop): void {
        if (crop.image) {
            for (const buffer of this.buffers.values()) {
                const use = buffer.images.get(crop.image);
                if (use) { this.releaseGpuLease(use.lease); buffer.images.delete(crop.image); }
            }
            crop.image.close();
        }
        if (!crop.pending) this.releaseCpuLease(crop.lease);
    }
    private dropWork(): void {
        this.asyncEpoch++; this.cancelJob(); this.cancelMirror();
        for (const [key, buffer] of this.buffers) this.closeBuffer(key, buffer);
        for (const source of this.sources.values()) this.closeSource(source);
        this.sources.clear(); this.requests.clear(); this.budget = null; this.presentedKey = ''; this.shortfall = null;
        this.retained.clear(); this.pendingSources.clear(); this.retainedCrops.clear(); this.pendingCrops.clear(); this.sourceKey = '';
    }
}

export function createCompositor2D<T extends object>(options: Compositor2DOptions<T>): CreatedCompositor2D<T> {
    const compositor = new Canvas2DCompositor(options);
    return { compositor, presenter: {
        generation: () => compositor.surfaceGeneration,
        prepare: frame => compositor.prepareMirror(frame),
        select2D: () => options.select2D(compositor),
        selectGpu: grant => options.selectGpu(grant),
        releaseSurface: () => compositor.releaseGpu('hidden'),
    } };
}
