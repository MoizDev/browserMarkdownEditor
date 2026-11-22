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
    /** Complete old-version coverage is a visible bridge, never current/exact data. */
    readonly staleVersion?: boolean;
}

/** Backdrop → ink/highlighter → opaque live stroke → chrome (C2.1:234–249).
 * The live highlighter remains in the ink layer's ordered bands.
 */
export interface CompositorLayer {
    readonly id: string;
    readonly layer: Layer;
    readonly group: CompositorLayerGroup;
    readonly isolation?: CompositorIsolation;
    /** Benchmark denominator only, in device pixels; never a declaration of painted coverage. */
    readonly benchmarkDomain?: (frame: ScheduledFrame) => readonly Readonly<Rect>[];
    coverage(frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage;
    /** Whether this layer's missing content may refuse the frame. Absent or true: the frame waits, as it always has. False:
     * an incomplete layer presents with whatever it drew (its stand-in), as PLAN issue 3 requires for non-critical content. */
    critical?(frame: ScheduledFrame): boolean;
}

/** Canonical allocators stay bound to one pool; never reconstruct a ByteLease by id. */
export interface LayerAllocators {
    readonly cpu: MemoryAllocator;
    readonly gpu: MemoryAllocator;
    /** The pane's current CPU grant in bytes: read-only, allocates nothing. Optional so a construction site that does not yet supply it
     * still typechecks; absent, a layer reads 0 (no grant known). */
    cpuGrantBytes?(): number;
}

/** Source is intrinsic texture/bitmap texels including its real gutter; destination is DEVICE pixels. */
/** One quad of a batch, in the same units and gutter rules as drawTexturedQuad: the source rectangle in texels and the
 * destination in device pixels. */
export interface TexturedQuadSpec {
    readonly sourceRect: Readonly<Rect>;
    readonly destRect: Readonly<Rect>;
}
export interface TexturedQuadOptions {
    readonly opacity: number;
    readonly sampling: 'nearest' | 'linear';
    /** Classification of the pixels actually drawn; omitted means no coverage. */
    readonly coverage?: 'current' | 'standin' | 'none';
    /** Benchmark-only executed source resolution relative to the demanded raster scale. */
    readonly standInRatio?: number;
}

/** Peak simultaneous inventory, declared during Layer.prepare. Masks share the target pool;
 * any multiply declaration adds one backdrop target. No declaration allocates or renews a budget.
 */
export type IsolationPaintOptions = Readonly<Pick<CompositorIsolation, 'opacity' | 'blend'>>;

export interface IsolationReservation {
    readonly depth: number;
    readonly maskDepth: number;
    readonly bounds: Readonly<RectI>;
    readonly stencil?: boolean;
    readonly samples?: Samples;
    readonly format?: TextureFormat;
    readonly multiply?: boolean;
    /** Peak externally acquired prepass targets, in addition to internal group/mask depth. */
    readonly targets?: {
        readonly count: number;
        readonly bounds: Readonly<RectI>;
        readonly stencil?: boolean;
        readonly samples?: Samples;
        readonly format?: TextureFormat;
    };
}

/** Platform construction services; streams never import a broker or native GL context (C4.3).
 * Resource creation/upload is prepare-only. CPU document/mirror ownership stays with the session.
 */
export interface LayerHost {
    device(): GfxDevice | null;
    /** Current broker circuit generation, also while device=null; never reset on CPU fallback. */
    readonly generation: number;
    invalidate(reason: string, damage?: DamageRecord): void;
    wakeAt(deadlineMs: number | null): void;
    /** A layer's declared CPU working set changed: the owner re-collects this pane's demand, once per tick. */
    demandChanged?(): void;
    /** Re-collects this pane's demand now, for a refusal that the current grant may be the cause of. */
    refreshDemandNow?(): void;
    /** A layer that refused part of its own encode (a tile, a path, an ink batch) says so during encode: the frame cannot claim
     * the layer complete. A critical layer's frame is refused and the previous picture stays; a non-critical one presents with
     * layersComplete false. A canvas2d frame draws each layer directly, so there it is a no-op. */
    markIncomplete(reason: string): void;
    readonly allocator: LayerAllocators;
    reserveIsolation(reservation: IsolationReservation): void;
    paintIsolation(ctx: CanvasRenderingContext2D, bounds: Readonly<RectI>, options: IsolationPaintOptions, paint: (isolatedCtx: CanvasRenderingContext2D) => void): void;
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void;
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void;
    /** CSS projection of the actual prepared draw, or null when it cannot be proven. */
    paneTransform(view: ViewState, frameId: number): Affine | null;
    /** DrawGpu-only packing into the active encoder's fenced ring, never a layer-owned ring. */
    uniforms(bytes: ArrayBufferView): UniformSlice;
    /** As uniforms, but rewrites a caller-owned record in place: a batch keeps one DrawCommand and rewrites its slice per draw. */
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void;
    /** Read-only governor state for this pane: a layer may shed work under 'slow-gpu' or 'pressure'. Allocates nothing. */
    trouble(): LayerTrouble;
    /** Routes a device-path error the layer hit to the pane's GPU error channel; the pane demotes or reports as it does for its own. */
    reportGpuError(error: unknown): void;
    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: DrawableImage, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuads(pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    drawTexturedQuads(ctx: CanvasRenderingContext2D, image: DrawableImage, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    /** canvas2d: whether this frame can draw the image (see CompositorResources.imageReady). Always true on the GPU path. */
    imageReady(image: DrawableImage): boolean;
}

/** The attach actor forwards these capabilities into its stable LayerHost objects. */
export interface CompositorResources {
    readonly owner: object;
    readonly device: GfxDevice | null;
    reserveIsolation(reservation: IsolationReservation): void;
    paintIsolation(ctx: CanvasRenderingContext2D, bounds: Readonly<RectI>, options: IsolationPaintOptions, paint: (isolatedCtx: CanvasRenderingContext2D) => void): void;
    /** Throws outside active GPU encoding; never returns a fictitious slice. */
    uniforms(bytes: ArrayBufferView): UniformSlice;
    /** The layer being encoded cannot complete its content this frame (see LayerHost.markIncomplete). */
    markIncomplete(reason: string): void;
    uniformsInto(bytes: ArrayBufferView, into: UniformSlice): void;
    drawTexturedQuad(pass: GpuPass, texture: TextureHandle, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuad(ctx: CanvasRenderingContext2D, image: DrawableImage, sourceRect: Readonly<Rect>, destRect: Readonly<Rect>, options: TexturedQuadOptions): void;
    drawTexturedQuads(pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    drawTexturedQuads(ctx: CanvasRenderingContext2D, image: DrawableImage, quads: readonly TexturedQuadSpec[], options: TexturedQuadOptions): void;
    /** canvas2d only: true when a draw of this image into the display needs no upload this frame has not admitted. A false answer
     * asks a later frame's preparation to admit it, so a layer with another picture of the same place (a stand-in) draws that one
     * meanwhile instead of making the frame miss an image: a canvas2d frame that misses one is not presented at all. */
    imageReady?(image: DrawableImage): boolean;
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
    /** Every item drew complete: no hole, raster stand-ins allowed. The commit gate of a size change (`complete` keeps its meaning
     * for presentation, where a non-critical layer may present its stand-in). A hole is layersComplete=false in the audit. */
    readonly layersComplete: boolean;
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
    /** CPU bytes of this compositor's working cache, which the pane's grant covers. */
    cpuWorkingBytes?(): number;
    /** The largest single upload this compositor needs one frame's progress grant to admit; the platform tile when absent. */
    progressUploadBytes?(): number;
    readonly surfaceGeneration: number;
    /** A detached CPU resize bridge is working scratch until the old GPU display is zeroed. */
    promoteSurface?(): boolean;
    readonly target: SurfaceCommitTarget;
    attach(host: PaneSurfaceHost): void;
    detach(): void;
    setLayers(layers: readonly CompositorLayer[]): void;
    setLayout(stack: Readonly<PageStack> | null): void;
    setAppearance(appearance: CompositorAppearance): void;
    setMetrics(metrics: ReadySurfaceMetrics): void;
    /** O(1) config snapshot, called with the same view handed to every layer. */
    snapshot(view: ViewState): void;
    /** Begin platform preparation before layers; the original frozen frame is shared everywhere. */
    prepareFrame(frame: ScheduledFrame, budget: FrameBudget): void;
    /** Admit declared peak inventory after all Layer.prepare calls, under the SAME budget/deadline. */
    finishPrepareFrame?(frame: ScheduledFrame, budget: FrameBudget): void;
    encode(frame: ScheduledFrame, changed: boolean): ScheduledEncoding | null;
    /** The layers' offscreen passes of a frame whose picture is unchanged, with no surface pass: nothing is presented. Null when no
     * layer has offscreen work or the frame cannot be encoded. Absent on a backend with no offscreen work (canvas2d). */
    encodeOffscreen?(frame: ScheduledFrame): ScheduledEncoding | null;
    coverage(frame: ScheduledFrame): CompositorCoverage;
    page(view: ViewState, index: number): CompositorPage | null;
    paneTransform(view: ViewState, frameId: number): Affine | null;
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
    selectGpu(grant: GpuGrant): boolean;
    mirrorQuad(entry: BorrowedMirror<T>, view: MirrorView): CompositorMirrorQuad | null;
    mirrorCoverage(view: MirrorView, drawn: readonly BorrowedMirror<T>[]): LayerCoverage;
    readonly browserBuild?: string;
}

/** One compositor and the lifecycle's existing show port, not a second renderer. */
export interface CreatedCompositor2D<T extends object> {
    readonly compositor: PaneCompositor;
    readonly presenter: Pane2DPresenter<T>;
}
