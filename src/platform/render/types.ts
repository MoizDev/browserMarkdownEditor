import type { ViewState } from '../types';
import type { GpuPass } from './gfx/api';

export type { Camera, Viewport, ViewState } from '../types';

/** Content identity plus the App session serial (rendering-design.md:94–95; contracts.md C7.0:839–845).
 * viewLease/deviceGeneration are FrameToken tags, not document identity (design:666).
 * The PDF stream adds its required source discriminator to its own key (C7.0:845).
 */
export type RenderToken = Readonly<{
    vaultEpoch: number;
    documentId: string;
    bytesGeneration: number;
    session: number;
}>;

/** Full publication tags; both document identity and view/device lifetime must match (design:666). */
export type FrameToken = RenderToken & {
    readonly viewLease: number;
    readonly deviceGeneration: number;
};

/** Shared-frame admission, using the performance.now clock (rendering-design.md §7.1:664–673).
 * The upload deadline bounds admitted work, not an already-running GPU upload; record overshoot.
 */
export interface FrameBudget {
    frameId: number;
    token: FrameToken;
    cameraEpoch: number;
    prepareDeadline: number;
    upload: { remainingBytes: number; deadline: number };
    shouldYield(): boolean;
    claimUpload(bytes: number): boolean;
}

/** Idempotent cache teardown causes, never document mutations (contracts.md C4.3:519–520). */
export type GpuReleaseReason = 'hidden' | 'context-lost' | 'pressure';

/** One stream's ordered contribution to a pane (contracts.md C4.3:512–547).
 * Every layer supplies both rendering paths; it never owns a requestAnimationFrame loop.
 */
export interface Layer {
    /** Schedule work without blocking; preparation is split into resumable units (design:677–679). */
    prepare(view: ViewState, budget: FrameBudget): void;
    drawGpu(pass: GpuPass, view: ViewState): void;
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void;
    releaseGpu(reason: GpuReleaseReason): void;
    /** Cheap byte accounting, called every frame (C4.3:521–522). */
    memory(): { gpuBytes: number; cpuBytes: number };
    /** Awaiting a worker alone is not executable work and must return false (design:661). */
    needsFrame(): boolean;
    /** Optional by vr-lead ruling; a later rAF after submission, not physical scan-out (C4.3:538–542).
     * The compositor validates the full FrameToken before acknowledging a drawn revision.
     */
    onFramePresented?(sceneRevision: number, token: RenderToken): void;
    dispose(): void;
}

/** Fixed policy, not measured capacity or a promise that the browser grants a context (rendering.md §4).
 * Values live only in constants.ts; importing this file cannot load a renderer or create a device.
 */
export interface RenderConstants {
    readonly maxAppContexts: 8;
    readonly reservedTerminalContexts: 1;
    readonly maxVisiblePaneContexts: 5;
    readonly transitionContexts: 2;
    readonly contextAttributes: Readonly<{
        alpha: true;
        premultipliedAlpha: true;
        antialias: false;
        depth: false;
        stencil: false;
        preserveDrawingBuffer: false;
        powerPreference: 'default';
        desynchronized: false;
        failIfMajorPerformanceCaveat: true;
    }>;
    /** The working colour representation is premultiplied encoded-sRGB, unlike display-list Rgba. */
    readonly colorSpace: 'srgb';
    readonly maxSurfaceAxisPixels: 8192;
    readonly maxSurfacePixels: 16777216;
    /** Same-task hide, with a separately charged context/program reserve. */
    readonly hiddenGpuReleaseDelayMs: 0;
    readonly keptContextReserveBytes: 4194304;
    readonly hiddenWindowRetentionMs: 300000;
    readonly hiddenCpuMirrorLimitBytes: 67108864;
    readonly tileInteriorPixels: 512;
    readonly tileGutterTexels: 1;
    /** Half-octave moving levels; the settled scale remains exact. PDFium bleed is not a gutter. */
    readonly movingTileLevelsPerOctave: 2;
    readonly memoryCeilings: Readonly<{
        /** navigator.deviceMemory <= 4 GiB or unknown. */
        low: Readonly<{ gpuBytes: 134217728; cpuRasterBytes: 67108864 }>;
        /** navigator.deviceMemory = 8 GiB. */
        medium: Readonly<{ gpuBytes: 268435456; cpuRasterBytes: 134217728 }>;
        /** navigator.deviceMemory >= 16 GiB. */
        high: Readonly<{ gpuBytes: 536870912; cpuRasterBytes: 268435456 }>;
    }>;
    /** G = min(Gmax, max(min, base + perPane*N + perPixel*P)); P is device pixels, not MiB. */
    readonly gpuGrantMinBytes: 67108864;
    readonly gpuGrantBaseBytes: 33554432;
    readonly gpuGrantPerVisiblePaneBytes: 16777216;
    readonly gpuGrantPerVisiblePixelBytes: 24;
    /** C = min(Cmax, max(min, perPane*N + perPixel*P)). */
    readonly cpuGrantMinBytes: 33554432;
    readonly cpuGrantPerVisiblePaneBytes: 8388608;
    readonly cpuGrantPerVisiblePixelBytes: 8;
    readonly surfaceReserveBytesPerPixel: 12;
    readonly surfaceMaxGpuGrantFraction: 0.4;
    /** Across ALL panes: min(4 ms, 0.45 * frame interval), not one budget per pane. */
    readonly frameTargetMaxMs: 4;
    readonly frameTargetIntervalFraction: 0.45;
    readonly contextLossPinCount: 3;
    readonly contextLossWindowMs: 60000;
    /** A future backend must qualify on two GPU families; nothing enables WebGPU here. */
    readonly webGpuMinP95FractionImprovement: 0.2;
    readonly webGpuMinP95MsImprovement: 1;
    readonly webGpuMinProcessMemoryFractionImprovement: 0.25;
    readonly webGpuMinFamilies: 2;
}
