import type { Rect, Rgba, ViewState } from '../types';
import type { PagePresentation } from './camera';
import type { Backend, GfxDevice, GpuPass, RectI, TextureHandle, UniformSlice } from './gfx/api';
import type { MemoryAllocator, MemoryGovernor } from './memoryGovernor';
import type { BorrowedMirror, MirrorView } from './mirrorSet';
import type { Pane2DPresenter } from './paneLifecycle';
import type { PageStack } from './pageStack';
import type { ReadySurfaceMetrics, SurfaceCommitTarget } from './surfaceMetrics';
import type { GpuGrant } from './surfaceBroker.types';
import type { ScheduledEncoding, ScheduledFrame } from './scheduler';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer } from './types';

/** Both drawing paths implement one host boundary (contracts.md C4.2:492–507). */
export type CompositorBackend = 'canvas2d' | Backend;
export type CompositorLayerGroup = 'document' | 'chrome';

/** Explicit isolation only; ordinary node/ancestor opacity remains per paint (design §10). */
export interface CompositorIsolation {
    readonly opacity: number;
    readonly blend: 'normal' | 'multiply';
    /** Already projected device bounds; omit only for a genuinely full-layer effect. */
    bounds?(frame: ScheduledFrame): RectI;
}

/** Availability of the content actually painted, not merely requested. */
export interface LayerCoverage {
    readonly complete: boolean;
    readonly sharp: boolean;
}

/** Backdrop → ink/highlighter → opaque live stroke → chrome (C2.1:234–249).
 * The live highlighter remains in the ink layer's ordered bands.
 */
export interface CompositorLayer {
    readonly id: string;
    readonly layer: Layer;
    readonly group: CompositorLayerGroup;
    readonly isolation?: CompositorIsolation;
    coverage(frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage;
}

/** Canonical allocators stay bound to one pool; never reconstruct a ByteLease by id. */
export interface LayerAllocators {
    readonly cpu: MemoryAllocator;
    readonly gpu: MemoryAllocator;
}

/** Source is intrinsic texture/bitmap texels including its real gutter; destination is DEVICE pixels. */
export interface TexturedQuadOptions {
    readonly opacity: number;
    readonly sampling: 'nearest' | 'linear';
}

/** Platform construction services; streams never import a broker or native GL context (C4.3).
 * Resource creation/upload is prepare-only. CPU document/mirror ownership stays with the session.
 */
export interface LayerHost {
    device(): GfxDevice | null;
    /** Current broker circuit generation, also while device=null; never reset on CPU fallback. */
    readonly generation: number;
    invalidate(reason: string): void;
    wakeAt(deadlineMs: number | null): void;
    readonly allocator: LayerAllocators;
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void;
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void;
    /** DrawGpu-only packing into the active encoder's fenced ring, never a layer-owned ring. */
    uniforms(bytes: ArrayBufferView): UniformSlice;
    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: ImageBitmap, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
}

/** The attach actor forwards these capabilities into its stable LayerHost objects. */
export interface CompositorResources {
    readonly owner: object;
    readonly device: GfxDevice | null;
    /** Throws outside active GPU encoding; never returns a fictitious slice. */
    uniforms(bytes: ArrayBufferView): UniformSlice;
    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: ImageBitmap, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
}

/** Final clear is opaque; inversion applies once to composited document colour (C2.5). */
export interface CompositorAppearance {
    readonly background: Rgba;
    readonly inverted: boolean;
}

/** Replaces one canvas while retaining input/overlay nodes (C4.2).
 * Detach is identity-checked so an older instance cannot remove its replacement.
 */
export interface PaneSurfaceHost {
    attach(canvas: HTMLCanvasElement): void;
    detach(canvas: HTMLCanvasElement): void;
}

/** Shared projection, fractional outline and half-open device envelope (design §4.1). */
export interface CompositorPage {
    readonly index: number;
    readonly rect: Readonly<Rect>;
    readonly presentation: PagePresentation;
    readonly clip: Readonly<RectI>;
    readonly outline: Readonly<Rect>;
}

/** Retained older pixels are never relabelled as the requested frame. */
export interface CompositorCoverage extends LayerCoverage {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly presented: boolean;
    readonly qualityScale: number;
}

/** An absent capture hook is unavailable, never a successful blank (design §4.6). */
export interface CompositorCaptureOptions {
    readonly layers: readonly string[];
    readonly theme: 'light';
    readonly inverted: false;
    readonly signal?: AbortSignal;
    readonly policy?: 'exact' | 'allow-standin';
}

/** Backend changes replace the instance and canvas, not the layer/session truth.
 * Layer lifetime/release is exclusively the attach lifecycle's: setLayers borrows the list.
 */
export interface PaneCompositor {
    readonly backend: CompositorBackend;
    readonly surface: HTMLCanvasElement;
    readonly resources: CompositorResources;
    readonly surfaceGeneration: number;
    readonly target: SurfaceCommitTarget;
    attach(host: PaneSurfaceHost): void;
    detach(): void;
    setLayers(layers: readonly CompositorLayer[]): void;
    setLayout(stack: Readonly<PageStack> | null): void;
    setAppearance(appearance: CompositorAppearance): void;
    setMetrics(metrics: ReadySurfaceMetrics): void;
    /** O(1) config snapshot, called with the same view handed to every layer. */
    snapshot(view: ViewState): void;
    /** Platform target/ring admission before any layer prepares; never draws. */
    prepareFrame(view: ViewState, budget: FrameBudget): void;
    encode(frame: ScheduledFrame): ScheduledEncoding | null;
    coverage(frame: ScheduledFrame): CompositorCoverage;
    page(view: ViewState, index: number): CompositorPage | null;
    /** Draw2d starts at device identity; scopes install absolute shared transforms, never multiply twice. */
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void;
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void;
    captureRegion?(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<ImageBitmap>;
    /** Own compositor surfaces/cache only; lifecycle routes Layer.releaseGpu. */
    releaseGpu(reason: GpuReleaseReason): void;
    dispose(): void;
}

/** Normalized mirror quad; the producer supplies placement, never PDF-specific parsing here. */
export interface CompositorMirrorQuad {
    readonly image: ImageBitmap;
    readonly sourceRect: Readonly<Rect>;
    readonly destRect: Readonly<Rect>;
}

/** CPU construction is private to the platform factory; attach consumes PaneCompositor only. */
export interface Compositor2DOptions<T extends object> {
    readonly paneId: string;
    readonly governor: MemoryGovernor;
    currentToken(): FrameToken | null;
    invalidate(reason: string): void;
    recordUpload(bytes: number, actualCallMs: number): void;
    /** Presenter selection delegates to the actor's existing backend selector; no second state machine. */
    select2D(compositor: PaneCompositor): void;
    selectGpu(grant: GpuGrant): void;
    mirrorQuad(entry: BorrowedMirror<T>, view: MirrorView): CompositorMirrorQuad | null;
    mirrorCoverage(view: MirrorView, drawn: readonly BorrowedMirror<T>[]): LayerCoverage;
    readonly browserBuild?: string;
}

/** One compositor and the lifecycle's existing show port, not a second renderer. */
export interface CreatedCompositor2D<T extends object> {
    readonly compositor: PaneCompositor;
    readonly presenter: Pane2DPresenter<T>;
}
