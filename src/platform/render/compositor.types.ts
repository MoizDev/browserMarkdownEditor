import type { Rect, Rgba, ViewState } from '../types';
import type { PagePresentation } from './camera';
import type { Backend, GfxDevice, RectI, UniformSlice } from './gfx/api';
import type { PageStack } from './pageStack';
import type { ReadySurfaceMetrics, SurfaceCommitTarget } from './surfaceMetrics';
import type { ScheduledEncoding, ScheduledFrame } from './scheduler';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer } from './types';

/** One host contract for both paths; no backend-specific device escapes it (contracts.md C4.2:492–507). */
export type CompositorBackend = 'canvas2d' | Backend;

/** Document colour is resolved together; chrome is never page-inverted (design §4.1:383–390). */
export type CompositorLayerGroup = 'document' | 'chrome';

/** Explicit isolated effects only. Ordinary node/ancestor opacity stays per paint inside the layer (§10:789). */
export interface CompositorIsolation {
    readonly opacity: number;
    readonly blend: 'normal' | 'multiply';
}

/** Data availability, not a pixel-verdict substitute; external G1/G2 still witness actual output (§15:1018). */
export interface LayerCoverage {
    readonly complete: boolean;
    readonly sharp: boolean;
}

/** Ordered backdrop → ink/highlighter → opaque live stroke → chrome (contracts.md C2.1:234–249).
 * A live highlighter remains in the ink layer's own bands; it is never promoted to the opaque live slot.
 */
export interface CompositorLayer {
    readonly id: string;
    readonly layer: Layer;
    readonly group: CompositorLayerGroup;
    readonly isolation?: CompositorIsolation;
    coverage(frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage;
}

/** Adapter-owned layer attachment services. Streams never import the broker or a native GL context.
 * Cache allocators are supplied by the attaching adapter/session, not reconstructed by the layer.
 */
export interface CompositorResources {
    /** Opaque per-compositor identity; a late detach must not unbind a replacement's resources. */
    readonly owner: object;
    readonly device: GfxDevice | null;
    /** Frame-scoped CPU packing/admission; actual batched driver upload happens at submit.
     * Null means unavailable/unadmitted, never an uninitialised or fictitious uniform slice.
     */
    uniforms(bytes: ArrayBufferView, budget: FrameBudget): UniformSlice | null;
}

/** One opaque surrounding clear; page inversion belongs to the composited document group (C2.5:432–440). */
export interface CompositorAppearance {
    readonly background: Rgba;
    readonly inverted: boolean;
}

/** Stable host retains input/overlay nodes. attach replaces its one displayed canvas, never appends a second.
 * detach is identity-checked: disposing an older compositor must not remove its replacement (C4.2:500–502).
 */
export interface PaneSurfaceHost {
    attach(canvas: HTMLCanvasElement): void;
    detach(canvas: HTMLCanvasElement): void;
}

/** One shared page projection, including the true fractional outline and half-open device envelope (§4.1:396–399). */
export interface CompositorPage {
    readonly index: number;
    readonly rect: Readonly<Rect>;
    readonly presentation: PagePresentation;
    readonly clip: Readonly<RectI>;
    readonly outline: Readonly<Rect>;
}

/** A report identifies the requested frame; retained older pixels are never relabelled current (C9; design §15). */
export interface CompositorCoverage extends LayerCoverage {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly presented: boolean;
    readonly qualityScale: number;
}

/** Reserved public capture hook, implemented in R-A5; absent means unavailable, never a successful blank (§4.6:439–452). */
export interface CompositorCaptureOptions {
    readonly layers: readonly string[];
    readonly theme: 'light';
    readonly inverted: false;
    readonly signal?: AbortSignal;
    readonly policy?: 'exact' | 'allow-standin';
}

/** Type-only boundary consumed by attachPlatformPane and implemented by both compositors.
 * Backend changes replace the instance AND canvas. Layer/session CPU truth belongs to the caller.
 */
export interface PaneCompositor {
    readonly backend: CompositorBackend;
    readonly surface: HTMLCanvasElement;
    /** The adapter binds these services to its layers; it owns attach/detach and Layer.dispose. */
    readonly resources: CompositorResources;
    /** Physical surface-use serial for mirror admissions, independent of document identity. */
    readonly surfaceGeneration: number;
    /** Generation/limits/resize callback consumed only by surfaceMetrics in the shared frame. */
    readonly target: SurfaceCommitTarget;
    attach(host: PaneSurfaceHost): void;
    detach(): void;
    /** Replaces ordered bindings only; caller owns removed-layer release/disposal and resource rebinding. */
    setLayers(layers: readonly CompositorLayer[]): void;
    setLayout(stack: Readonly<PageStack> | null): void;
    setAppearance(appearance: CompositorAppearance): void;
    setMetrics(metrics: ReadySurfaceMetrics): void;
    /** O(1) freeze of layout/appearance/layer bindings; wire into ScheduledPane.snapshotScene. */
    snapshot(view: ViewState): void;
    /** Platform-owned target/uniform/implicit-upload admission, before encoding; never draws. */
    prepareFrame(view: ViewState, budget: FrameBudget): void;
    /** Null preserves the previous complete picture AND its overlay transform. */
    encode(frame: ScheduledFrame): ScheduledEncoding | null;
    coverage(frame: ScheduledFrame): CompositorCoverage;
    /** Projection data is identical for GPU, 2D, input and DOM; no per-page ViewState clones. */
    page(view: ViewState, index: number): CompositorPage | null;
    /** 2D helpers start from a device-identity context, install the shared scope and restore afterward. */
    paintWorld(ctx: CanvasRenderingContext2D, view: ViewState, paint: () => void): void;
    paintPage(ctx: CanvasRenderingContext2D, view: ViewState, index: number, paint: () => void): void;
    captureRegion?(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<ImageBitmap>;
    /** The common teardown route, idempotent; never clears undo, source bytes or session-owned mirrors. */
    releaseGpu(reason: GpuReleaseReason): void;
    /** Releases this compositor's surfaces/cache leases, not the streams' layer/session truth. */
    dispose(): void;
}
