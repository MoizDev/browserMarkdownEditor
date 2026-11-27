import type { ViewState } from '../types';
import type { GpuPass, RectI, RgbaP, TargetHandle } from './gfx/api';
import type { DamageRecord } from './damage';

export type { Camera, Viewport, ViewState } from '../types';

export type RenderToken = Readonly<{
    vaultEpoch: number;
    documentId: string;
    bytesGeneration: number;
    session: number;
}>;

export type FrameToken = RenderToken & {
    readonly viewLease: number;
    readonly deviceGeneration: number;
};

export type BudgetPhase = 'foreground' | 'background' | 'single';

export interface FrameBudget {
    frameId: number;
    token: FrameToken;
    cameraEpoch: number;
    readonly damage?: DamageRecord;
    readonly phase: BudgetPhase;
    prepareDeadline: number;
    upload: { remainingBytes: number; deadline: number };
    shouldYield(): boolean;
    claimUpload(bytes: number, kind?: 'media'): boolean;
}

export type GpuReleaseReason = 'hidden' | 'context-lost' | 'pressure';

export interface OffscreenPasses {
    begin(target: TargetHandle, viewport: RectI, options: { clear: RgbaP | null; stencil: boolean; orClear?: RgbaP }): GpuPass;
}

export interface Layer {
    readonly benchmarkRaster?: boolean;
    readonly atlas?: boolean;
    readonly twoPhase?: true;
    backgroundOwed?(frameId: number): boolean;
    readonly idle?: () => boolean;
    prepare(view: ViewState, budget: FrameBudget): boolean | void;
    drawGpu(pass: GpuPass, view: ViewState): void;
    encodeOffscreen?(passes: OffscreenPasses, view: ViewState): void;
    offscreenSettled?(submitted: boolean): void;
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void;
    releaseGpu(reason: GpuReleaseReason): void;
    /** Optional, GPU only. Partial eviction under memory pressure: frees up to `bytes` of GPU memory, least recently used
     * first, and returns the bytes actually freed. It never releases anything drawn or referenced in `frameId`, so the
     * frame being encoded stays whole; a layer that cannot free anything outside that frame returns 0. */
    evictGpu?(bytes: number, frameId: number): number;
    protectFrame?(frameId: number, view: ViewState): void;
    memory(): { gpuBytes: number; cpuBytes: number };
    /** Awaiting a worker alone is not executable work and must return false (design:661). */
    needsFrame(): boolean;
    prepareUrgent?(): boolean;
    onFramePresented?(sceneRevision: number, token: RenderToken): void;
    dispose(): void;
}

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
        powerPreference: 'high-performance';
        desynchronized: false;
        failIfMajorPerformanceCaveat: true;
    }>;
    readonly colorSpace: 'srgb';
    readonly maxSurfaceAxisPixels: 8192;
    readonly maxSurfacePixels: 16777216;
    readonly hiddenGpuReleaseDelayMs: 0;
    readonly keptContextReserveBytes: 4194304;
    readonly hiddenWindowRetentionMs: 300000;
    readonly hiddenCpuMirrorLimitBytes: 67108864;
    readonly tileInteriorPixels: 512;
    readonly tileGutterTexels: 1;
    readonly mediaTileInteriorPixels: 1024;
    readonly movingTileLevelsPerOctave: 2;
    readonly motionLevelKeepMinDivisor: 1.15;
    readonly motionLevelKeepMaxFactor: 1.6;
    readonly versionBridgeDurationMs: 2000;
    readonly lowPreviewScaleDivisor: 4;
    readonly lowPreviewMaxAspectRatio: 16;
    readonly lowPreviewAheadViewports: 2;
    readonly lowPreviewBehindViewports: 1;
    readonly maxPagePreviewsPerPane: 12;
    readonly demandAgePromotionMs: 250;
    readonly velocityWindowMs: 100;
    readonly prefetchHorizonSeconds: 0.2;
    readonly prefetchMinViewports: 0.25;
    readonly prefetchMaxViewports: 1;
    readonly prefetchBehindViewports: 0.25;
    readonly pinchDemandIntervalMs: 50;
    readonly settledDemandDelayMs: 100;
    readonly tileWatchdogMs: 2000;
    readonly tileRetryCount: 1;
    readonly memoryCeilings: Readonly<{
        low: Readonly<{ gpuBytes: 134217728; cpuRasterBytes: 67108864 }>;
        medium: Readonly<{ gpuBytes: 268435456; cpuRasterBytes: 134217728 }>;
        high: Readonly<{ gpuBytes: 536870912; cpuRasterBytes: 268435456 }>;
    }>;
    readonly gpuGrantMinBytes: 67108864;
    readonly gpuGrantBaseBytes: 33554432;
    readonly gpuGrantPerVisiblePaneBytes: 16777216;
    readonly gpuGrantPerVisiblePixelBytes: 24;
    readonly gpuGrantMaxDpr: 2;
    readonly cpuGrantMinBytes: 33554432;
    readonly cpuGrantPerVisiblePaneBytes: 8388608;
    readonly cpuGrantPerVisiblePixelBytes: 12;
    readonly deviceMemoryLowGiB: 4;
    readonly deviceMemoryMiddleGiB: 8;
    readonly deviceMemoryHighGiB: 16;
    readonly focusedPaneWeight: 2;
    readonly unfocusedPaneWeight: 1;
    readonly minPaneTileCredits: 2;
    readonly liveVectorScratchBytes: 2097152;
    readonly decodedRgbaBytesPerPixel: 4;
    readonly memorySoftPressureRatio: 0.9;
    readonly memoryTrimTargetRatio: 0.8;
    readonly liveInputGpuFraction: 0.25;
    readonly qualityReductionFactor: 0.8;
    readonly minInteractiveQualityScale: 0.5;
    readonly memoryRecoveryDelayMs: 5000;
    readonly memoryMadeRoomRecoveryDelayMs: 1000;
    readonly memoryNoticeDelayMs: 1000;
    readonly qualityStepSettleMs: 300;
    readonly qualityFailureBackoffMinMs: 5000;
    readonly qualityFailureBackoffMaxMs: 60000;
    readonly qualityFailureResetMs: 30000;
    readonly resumePressureHoldMs: 1500;
    readonly slowGpuSampleCount: 120;
    readonly stalledFenceMs: 250;
    readonly surfaceReserveBytesPerPixel: 12;
    readonly surfaceMaxGpuGrantFraction: 0.4;
    readonly frameTargetMaxMs: 4;
    readonly frameTargetIntervalFraction: 0.45;
    readonly contextLossPinCount: 3;
    readonly contextLossWindowMs: 60000;
    readonly webGpuMinP95FractionImprovement: 0.2;
    readonly webGpuMinP95MsImprovement: 1;
    readonly webGpuMinProcessMemoryFractionImprovement: 0.25;
    readonly webGpuMinFamilies: 2;
}

export type LayerTrouble = 'none' | 'slow-gpu' | 'pressure';

export function layerTroubleOf(state: 'normal' | 'trimming' | 'degraded' | 'cpu-pinned', lastTrouble: string | null): LayerTrouble {
    if (state === 'normal') return 'none';
    return lastTrouble === 'slow-gpu' ? 'slow-gpu' : 'pressure';
}
