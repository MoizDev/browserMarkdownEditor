import type { GpuReleaseReason, RenderToken } from './types';
import type { GfxLimits } from './gfx/api';
import type { MemoryAllocator } from './memoryGovernor';
import type { GpuUnavailableCause } from '../renderStatus';

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
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly lastInputAt: number;
}

export type ContextDisposeReason = 'disposed' | 'revoked' | 'context-lost' |
    'creation-failed' | 'stale' | 'cpu-pinned' | 'restore-timeout' | 'pressure';
export type GpuErrorReason = `gpu-error:${string}`;
export type CpuFallbackReason = 'capacity' | 'budget' | 'out-of-budget' | 'creation-failed' | 'context-lost' |
    'cpu-pinned' | 'restore-timeout' | 'pressure' | 'gpu-unavailable' | GpuErrorReason;
export type { GpuUnavailableCause };
export type GpuFailureReason = 'creation-failed' | 'out-of-budget' | GpuErrorReason;

export interface SurfaceResizeResult {
    readonly width: number;
    readonly height: number;
    readonly complete: boolean;
    readonly generation: number;
    readonly refused?: boolean;
}

export type ResizeSurface = (width: number, height: number) => SurfaceResizeResult;

export interface BrokerGpuOwner {
    readonly limits: Readonly<GfxLimits>;
    readonly resizeSurface: ResizeSurface;
    openOffscreen(width: number, height: number): boolean;
    commitSurface(): SurfaceResizeResult | null;
    closeOffscreen(): void;
    releaseGpu(reason: GpuReleaseReason): void;
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
    readonly resizeSurface: ResizeSurface;
    readonly openOffscreen: (width: number, height: number) => boolean;
    readonly commitSurface: () => SurfaceResizeResult | null;
    readonly closeOffscreen: () => void;
    readonly generation: number;
    readonly reused: boolean;
}

export type GpuRequestResult = { readonly kind: 'gpu'; readonly grant: GpuGrant; } |
{ readonly kind: 'cpu'; readonly reason: CpuFallbackReason; } |
{ readonly kind: 'stale' | 'ineligible'; };

export interface SurfaceCallbacks {
    /** Same-task stop of frames/input/view jobs and synchronous edit checkpoint; never await a save. */
    beforeHide(): void;
    onSurfaceZeroed?(canvas: HTMLCanvasElement): void;
    prepareGpu(preparation: GpuPreparation): Promise<BrokerGpuOwner>;
    onGpuReady(grant: GpuGrant): void;
    onCapabilityFailure?(): void;
    onCpuFallback(reason: CpuFallbackReason): void;
    onSlotAvailable(): void;
    onPinned(): void;
    onGpuUnavailable?(cause: GpuUnavailableCause): void;
}

export interface SurfaceBrokerConfiguration {
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
    canMarkPresented(stamp: SurfaceStamp, generation: number): boolean;
    markPresented(stamp: SurfaceStamp, generation: number): boolean;
    failGpu(stamp: SurfaceStamp, generation: number, reason: GpuFailureReason, latch: boolean): void;
    retry(): void;
    snapshot(): SurfaceSnapshot;
    dispose(): void;
}
