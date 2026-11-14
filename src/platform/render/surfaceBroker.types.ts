import type { GpuReleaseReason, RenderToken } from './types';
import type { GfxLimits } from './gfx/api';
import type { MemoryAllocator } from './memoryGovernor';

export type { GpuReleaseReason } from './types';

export type SurfaceState = 'dormant' | 'requesting' | 'gpu-visible' | 'context-reserved' |
    'cpu-visible' | 'lost-waiting' | 'rebuilding' | 'cpu-pinned' | 'disposed';

export interface SurfaceStamp {
    readonly paneId: string;
    readonly viewLease: number;
    readonly documentToken: RenderToken;
}

export interface SurfaceView {
    readonly visible: boolean;
    readonly focused: boolean;
    /** Latest measured CSS extent, for eligibility only. surfaceMetrics owns backing dimensions. */
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly lastInputAt: number;
}

export type ContextDisposeReason = 'disposed' | 'revoked' | 'context-lost' |
    'creation-failed' | 'stale' | 'cpu-pinned' | 'restore-timeout' | 'pressure';
export type CpuFallbackReason = 'capacity' | 'out-of-budget' | 'creation-failed' | 'context-lost' |
    'cpu-pinned' | 'restore-timeout' | 'pressure';

export interface SurfaceResizeResult {
    readonly width: number;
    readonly height: number;
    readonly complete: boolean;
    readonly generation: number;
}

export type ResizeSurface = (width: number, height: number) => SurfaceResizeResult;

/** Platform adapter only: layers never receive the raw context or this owner. */
export interface BrokerGpuOwner {
    readonly limits: Readonly<GfxLimits>;
    /** Backend owns canvas resize and the one drawing-buffer/framebuffer check after a commit. */
    readonly resizeSurface: ResizeSurface;
    /** Release working handles through the arena; hidden keeps only device-owned programs. */
    releaseGpu(reason: GpuReleaseReason): void;
    /** Dispose/abandon the remaining programs and arena; safe after releaseGpu and loss. */
    dispose(reason: ContextDisposeReason): void;
}

export interface GpuPreparation {
    readonly canvas: HTMLCanvasElement;
    readonly context: WebGL2RenderingContext;
    readonly generation: number;
    readonly signal: AbortSignal;
}

export interface GpuGrant {
    readonly canvas: HTMLCanvasElement;
    readonly limits: Readonly<GfxLimits>;
    /** Called only by surfaceMetrics in the shared frame, with the current governor grant. */
    readonly resizeSurface: ResizeSurface;
    readonly generation: number;
    readonly reused: boolean;
}

export type GpuRequestResult = { readonly kind: 'gpu'; readonly grant: GpuGrant; } |
{ readonly kind: 'cpu'; readonly reason: CpuFallbackReason; } |
{ readonly kind: 'stale' | 'ineligible'; };

export interface SurfaceCallbacks {
    /** Same-task stop of frames/input/view jobs and synchronous edit checkpoint; never await a save. */
    beforeHide(): void;
    /** The broker has actually zeroed this native canvas; its backing lease may now be returned. */
    onSurfaceZeroed?(canvas: HTMLCanvasElement): void;
    /**
     * Resolve only after the generation's asynchronous colour/alpha capability check passes.
     * This factory owns partial-init cleanup on rejection/abort. A late successful owner is disposed
     * by the broker. It must not publish GPU resources to layers before onGpuReady.
     */
    prepareGpu(preparation: GpuPreparation): Promise<BrokerGpuOwner>;
    /**
     * Schedule admitted rebuilding, not a canvas swap; markPresented guards the later swap.
     * The adapter's prepared device supplies generation-owned limits to surfaceMetrics, which
     * commits the current grant in the shared frame and checks the resulting drawing buffer.
     */
    onGpuReady(grant: GpuGrant): void;
    /**
     * Present through a DIFFERENT 2D canvas, retaining the input/overlay host. Detach a lost GL
     * canvas solely for restoration notification; never request another context type on it.
     */
    onCpuFallback(reason: CpuFallbackReason): void;
    /** A capacity event, not a polling loop. Submit a fresh tagged request if still needed. */
    onSlotAvailable(): void;
    /** Stable App-owned status-line callback; once per session, including across view remounts. */
    onPinned(): void;
}

export interface SurfaceBrokerConfiguration {
    /** App-wide native-context reserve allocator, bound once at platform startup (never import). */
    readonly contextAllocator: MemoryAllocator;
}

export interface SurfaceRegistration extends SurfaceStamp {
    readonly view: SurfaceView;
    readonly callbacks: SurfaceCallbacks;
}

export interface SurfaceSnapshot extends SurfaceStamp, SurfaceView {
    readonly state: SurfaceState;
    readonly hiddenAt: number | null;
    readonly gpuGeneration: number;
    readonly capabilityCheckedGeneration: number | null;
    readonly reserved: boolean;
    readonly lossTimes: readonly number[];
}

export interface SurfaceLease {
    readonly stamp: SurfaceStamp;
    updateView(view: SurfaceView): void;
    /** Byte changes invalidate pending publications; rename/move must not call this. */
    updateToken(token: RenderToken): void;
    requestGpu(canvas: HTMLCanvasElement, stamp: SurfaceStamp): Promise<GpuRequestResult>;
    markPresented(stamp: SurfaceStamp, generation: number): boolean;
    /** An unrecoverable qualified-backend fault abandons this reservation and returns to CPU. */
    failGpu(stamp: SurfaceStamp, generation: number, reason: 'creation-failed' | 'out-of-budget'): void;
    /** One fresh attempt after an outright failure/timeout, only on explicit user action or later show. */
    retry(): void;
    snapshot(): SurfaceSnapshot;
    dispose(): void;
}
