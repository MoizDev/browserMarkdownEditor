import type { Affine, Rect, Rgba, ViewState } from '../types';
import type { PagePresentation } from './camera';
import type { DamageRecord } from './damage';
import type { Backend, DrawableImage, GfxDevice, GpuPass, RectI, Samples, TextureFormat, TextureHandle, UniformSlice } from './gfx/api';
import type { MemoryAllocator, MemoryGovernor } from './memoryGovernor';
import type { BorrowedMirror, MirrorView } from './mirrorSet';
import type { Pane2DPresenter } from './paneLifecycle';
import type { PageStack } from './pageStack';
import type { ReadySurfaceMetrics, SurfaceCommitTarget } from './surfaceMetrics';
import type { GpuGrant } from './surfaceBroker.types';
import type { ScheduledEncoding, ScheduledFrame } from './scheduler';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer, LayerTrouble } from './types';

export type CompositorBackend = 'canvas2d' | Backend;
export type CompositorLayerGroup = 'document' | 'chrome';

export interface CompositorIsolation {
    readonly opacity: number;
    readonly blend: 'normal' | 'multiply';
    bounds?(frame: ScheduledFrame): RectI;
}

export interface LayerCoverage {
    readonly complete: boolean;
    readonly sharp: boolean;
    readonly staleVersion?: boolean;
}

export interface CompositorLayer {
    readonly id: string;
    readonly layer: Layer;
    readonly group: CompositorLayerGroup;
    readonly isolation?: CompositorIsolation;
    readonly benchmarkDomain?: (frame: ScheduledFrame) => readonly Readonly<Rect>[];
    coverage(frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage;
    critical?(frame: ScheduledFrame): boolean;
}

/** Canonical allocators stay bound to one pool; never reconstruct a ByteLease by id. */
export interface LayerAllocators {
    readonly cpu: MemoryAllocator;
    readonly gpu: MemoryAllocator;
    cpuGrantBytes?(): number;
}

export interface TexturedQuadSpec {
    readonly sourceRect: Readonly<Rect>;
    readonly destRect: Readonly<Rect>;
}
export interface TexturedQuadOptions {
    readonly opacity: number;
    readonly sampling: 'nearest' | 'linear';
    readonly coverage?: 'current' | 'standin' | 'none';
    readonly standInRatio?: number;
}

export type IsolationPaintOptions = Readonly<Pick<CompositorIsolation, 'opacity' | 'blend'>>;

export interface IsolationReservation {
    readonly depth: number;
    readonly maskDepth: number;
    readonly bounds: Readonly<RectI>;
    readonly stencil?: boolean;
    readonly samples?: Samples;
    readonly format?: TextureFormat;
    readonly multiply?: boolean;
    readonly targets?: {
        readonly count: number;
        readonly bounds: Readonly<RectI>;
        readonly stencil?: boolean;
        readonly samples?: Samples;
        readonly format?: TextureFormat;
    };
}

export interface LayerHost {
    device(): GfxDevice | null;
    readonly generation: number;
    invalidate(reason: string, damage?: DamageRecord): void;
    wakeAt(deadlineMs: number | null): void;
    demandChanged?(): void;
    refreshDemandNow?(): void;
    markIncomplete(reason: string): void;
    readonly allocator: LayerAllocators;
    reserveIsolation(reservation: IsolationReservation): void;
    paintIsolation(ctx: CanvasRenderingContext2D, bounds: Readonly<RectI>, options: IsolationPaintOptions, paint: (isolatedCtx: CanvasRenderingContext2D) => void): void;
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void;
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void;
    paneTransform(view: ViewState, frameId: number): Affine | null;
    uniforms(bytes: ArrayBufferView): UniformSlice;
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void;
    trouble(): LayerTrouble;
    reportGpuError(error: unknown): void;
    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: DrawableImage, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuads(pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    drawTexturedQuads(ctx: CanvasRenderingContext2D, image: DrawableImage, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    imageReady(image: DrawableImage): boolean;
}

export interface CompositorResources {
    readonly owner: object;
    readonly device: GfxDevice | null;
    reserveIsolation(reservation: IsolationReservation): void;
    paintIsolation(ctx: CanvasRenderingContext2D, bounds: Readonly<RectI>, options: IsolationPaintOptions, paint: (isolatedCtx: CanvasRenderingContext2D) => void): void;
    uniforms(bytes: ArrayBufferView): UniformSlice;
    markIncomplete(reason: string): void;
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void;
    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: DrawableImage, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuads(pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    drawTexturedQuads(ctx: CanvasRenderingContext2D, image: DrawableImage, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    imageReady?(image: DrawableImage): boolean;
}

export interface CompositorAppearance {
    readonly background: Rgba;
    readonly inverted: boolean;
}

export interface PaneSurfaceHost {
    attach(canvas: HTMLCanvasElement): void;
    detach(canvas: HTMLCanvasElement): void;
}

export interface CompositorPage {
    readonly index: number;
    readonly rect: Readonly<Rect>;
    readonly presentation: PagePresentation;
    readonly clip: Readonly<RectI>;
    readonly outline: Readonly<Rect>;
}

export interface CompositorCoverage extends LayerCoverage {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly presented: boolean;
    readonly qualityScale: number;
    readonly layersComplete: boolean;
}

export interface CompositorCaptureOptions {
    readonly layers: readonly string[];
    readonly theme: 'light';
    readonly inverted: false;
    readonly signal?: AbortSignal;
    readonly policy?: 'exact' | 'allow-standin';
}

export interface PaneCompositor {
    readonly backend: CompositorBackend;
    readonly surface: HTMLCanvasElement;
    readonly resources: CompositorResources;
    cpuWorkingBytes?(): number;
    progressUploadBytes?(): number;
    readonly surfaceGeneration: number;
    promoteSurface?(): boolean;
    readonly target: SurfaceCommitTarget;
    attach(host: PaneSurfaceHost): void;
    detach(): void;
    setLayers(layers: readonly CompositorLayer[]): void;
    setLayout(stack: Readonly<PageStack> | null): void;
    setAppearance(appearance: CompositorAppearance): void;
    setMetrics(metrics: ReadySurfaceMetrics): void;
    snapshot(view: ViewState): void;
    prepareFrame(frame: ScheduledFrame, budget: FrameBudget): void;
    finishPrepareFrame?(frame: ScheduledFrame, budget: FrameBudget): void;
    encode(frame: ScheduledFrame, changed: boolean): ScheduledEncoding | null;
    encodeOffscreen?(frame: ScheduledFrame): ScheduledEncoding | null;
    nowSharp?(frame: ScheduledFrame): boolean;
    coverage(frame: ScheduledFrame): CompositorCoverage;
    page(view: ViewState, index: number): CompositorPage | null;
    paneTransform(view: ViewState, frameId: number): Affine | null;
    /** Draw2d starts at device identity; scopes install absolute shared transforms, never multiply twice. */
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void;
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void;
    captureRegion?(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<ImageBitmap>;
    releaseGpu(reason: GpuReleaseReason): void;
    dispose(): void;
}

export interface CompositorMirrorQuad {
    readonly image: ImageBitmap;
    readonly sourceRect: Readonly<Rect>;
    readonly destRect: Readonly<Rect>;
}

export interface Compositor2DOptions<T extends object> {
    readonly paneId: string;
    readonly governor: MemoryGovernor;
    currentToken(): FrameToken | null;
    invalidate(reason: string): void;
    recordUpload(bytes: number, actualCallMs: number): void;
    select2D(compositor: PaneCompositor): void;
    selectGpu(grant: GpuGrant): boolean;
    mirrorQuad(entry: BorrowedMirror<T>, view: MirrorView): CompositorMirrorQuad | null;
    mirrorCoverage(view: MirrorView, drawn: readonly BorrowedMirror<T>[]): LayerCoverage;
    readonly browserBuild?: string;
}

export interface CreatedCompositor2D<T extends object> {
    readonly compositor: PaneCompositor;
    readonly presenter: Pane2DPresenter<T>;
}
