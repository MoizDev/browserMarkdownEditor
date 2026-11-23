import type { ViewState } from '../types';
import type { GpuPass, RectI, RgbaP, TargetHandle } from './gfx/api';
import type { DamageRecord } from './damage';

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
/** Which pass of the frame a prepare call runs in (see Layer.twoPhase). 'single' is every layer that does not split: a critical
 * one runs in the foreground pass, any other in the background pass, as before. */
export type BudgetPhase = 'foreground' | 'background' | 'single';

export interface FrameBudget {
    frameId: number;
    token: FrameToken;
    cameraEpoch: number;
    readonly damage?: DamageRecord;
    /** Always set by the scheduler. A two-phase layer is prepared once per phase per frame, foreground first across every pane. */
    readonly phase: BudgetPhase;
    prepareDeadline: number;
    upload: { remainingBytes: number; deadline: number };
    shouldYield(): boolean;
    /** Claims upload bytes against this prepare's allowance. A 'media' claim (a VideoFrame being uploaded) is granted once per
     * prepare call per layer, outside the allowance, so one decoded frame never waits behind the layer's other uploads. */
    claimUpload(bytes: number, kind?: 'media'): boolean;
}

/** Idempotent cache teardown causes, never document mutations (contracts.md C4.3:519–520). */
export type GpuReleaseReason = 'hidden' | 'context-lost' | 'pressure';

/** Begins one pass into a layer-owned target; the returned pass must be ended before the next begins and before
 * `encodeOffscreen` returns. `clear` null loads the target's previous contents (an incremental tile update). */
export interface OffscreenPasses {
    begin(target: TargetHandle, viewport: RectI, options: { clear: RgbaP | null; stencil: boolean }): GpuPass;
}

/** One stream's ordered contribution to a pane (contracts.md C4.3:512–547).
 * Every layer supplies both rendering paths; it never owns a requestAnimationFrame loop.
 */
export interface Layer {
    /** Benchmark denominator classification; absent for vector-only layers. */
    readonly benchmarkRaster?: boolean;
    /** Opt-in (default off): this layer's offscreen tiles are drawn into regions of one shared atlas target instead of one target
     * each, which removes a framebuffer switch per tile. Only clear passes without stencil use the atlas; anything else draws
     * its own target and is counted as a fallback. */
    readonly atlas?: boolean;
    /** Opt-in (default off): preparation is split into two calls per frame, budget.phase 'foreground' then 'background'. The
     * scheduler runs every pane's foreground call before any background call, both sharing the frame's one upload window.
     * Foreground does this frame's begin-of-frame work (keyed by frameId, since both calls see the same frame) and the work
     * the frame's completeness needs; background does the rest. A foreground answer of changed marks the frame changed; the
     * frame's answer is the background call's. The scheduler skips the background call when the foreground call did not run. */
    readonly twoPhase?: true;
    /** True when this layer has nothing to draw now (a cleared preview slot, an empty overlay): a camera move changes nothing it shows, so
     * the scheduler does not force a change for it. Measured: a cleared preview answered unchanged on every zoom frame, and the forced
     * camera-move change presented each of those frames identically (28 to 43 redundant presents per zoom). */
    readonly idle?: () => boolean;
    /** Schedule work without blocking; preparation is split into resumable units (design:677–679).
     * Returns `false` only when a prepare ran to completion for this view and nothing the layer draws next can differ from what
     * it last presented, so a continuation frame may skip encode and present. A layer the budget or deadline skipped this frame
     * has proved nothing, so the scheduler counts it as changed. Any other answer, including no answer (every layer that does not
     * say), means the picture may have changed. A forwarding wrapper that does not return the inner answer simply reports changed.
     * A frame of `false` answers is a presented frame whose GPU work is skipped: the picture on screen is the one it would draw, so
     * the scheduler still delivers the presented-frame observers, overlays and presented record for it (only encode and submit are
     * skipped). That is why a layer must count every change it draws, its chrome included: an unchanged answer over a change is hidden. */
    prepare(view: ViewState, budget: FrameBudget): boolean | void;
    drawGpu(pass: GpuPass, view: ViewState): void;
    /** Optional, GPU only. Encodes passes into the layer's OWN offscreen targets (tile textures) on this frame's encoder,
     * before the frame's surface pass, so `drawGpu` can sample them in the same frame. Targets and every resource drawn
     * are created and admitted in `prepare`; this only draws, like `drawGpu`. A layer that composes its tiles here makes
     * their pixels on the GPU instead of rastering them on the CPU and uploading (rendering-design §5). */
    encodeOffscreen?(passes: OffscreenPasses, view: ViewState): void;
    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void;
    releaseGpu(reason: GpuReleaseReason): void;
    /** Optional, GPU only. Partial eviction under memory pressure: frees up to `bytes` of GPU memory, least recently used
     * first, and returns the bytes actually freed. It never releases anything drawn or referenced in `frameId`, so the
     * frame being encoded stays whole; a layer that cannot free anything outside that frame returns 0. */
    evictGpu?(bytes: number, frameId: number): number;
    /** Optional, GPU only. Called once per frame, before any layer prepares, with the frame's view: stamps what this frame shows
     * (its pictures and stand-ins) as used in `frameId`, so the frame's own partial relief leaves it. Without it, what the frame
     * draws from entries composed in earlier frames is not stamped until its draw, and a trim in the prepare could take it. */
    protectFrame?(frameId: number, view: ViewState): void;
    /** Cheap byte accounting, called every frame (C4.3:521–522). */
    memory(): { gpuBytes: number; cpuBytes: number };
    /** Awaiting a worker alone is not executable work and must return false (design:661). */
    needsFrame(): boolean;
    /** Deprecated, not read by the scheduler: every pane's foreground preparation now gets the frame's whole preparation budget
     * (the interval less the measured presentation cost), so an unpresented picture needs no separate share. Kept until the
     * implementers (the board layer) drop it, since removing it is a change in their files. */
    prepareUrgent?(): boolean;
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
        powerPreference: 'high-performance';
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
    /** A board picture tile's interior: the GPU route and canvas2d draw the same levels and keys (whiteboard/media/mips.ts). */
    readonly mediaTileInteriorPixels: 1024;
    /** Half-octave moving levels; the settled scale remains exact. PDFium bleed is not a gutter. */
    readonly movingTileLevelsPerOctave: 2;
    /** Motion-level hysteresis, not a current-pixel validity exception (design §5.2:500). */
    readonly motionLevelKeepMinDivisor: 1.15;
    readonly motionLevelKeepMaxFactor: 1.6;
    readonly versionBridgeDurationMs: 2000;
    /** Bounded nearby low coverage; extremely narrow pages use regions (§5.4:523–525). */
    readonly lowPreviewScaleDivisor: 4;
    readonly lowPreviewMaxAspectRatio: 16;
    readonly lowPreviewAheadViewports: 2;
    readonly lowPreviewBehindViewports: 1;
    readonly maxPagePreviewsPerPane: 12;
    /** Stable demand ordering, bounded travel horizon and motion coalescing (§5.7:571–575). */
    readonly demandAgePromotionMs: 250;
    readonly velocityWindowMs: 100;
    readonly prefetchHorizonSeconds: 0.2;
    readonly prefetchMinViewports: 0.25;
    readonly prefetchMaxViewports: 1;
    readonly prefetchBehindViewports: 0.25;
    readonly pinchDemandIntervalMs: 50;
    readonly settledDemandDelayMs: 100;
    /** Watchdog target; heavy fixtures may have an explicit host policy (§5.7:577). */
    readonly tileWatchdogMs: 2000;
    readonly tileRetryCount: 1;
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
    readonly gpuGrantMaxDpr: 2;
    /** C = min(Cmax, max(min, perPane*N + perPixel*P)). */
    readonly cpuGrantMinBytes: 33554432;
    readonly cpuGrantPerVisiblePaneBytes: 8388608;
    readonly cpuGrantPerVisiblePixelBytes: 12;
    /** Coarsened navigator.deviceMemory classes, not inferred installed RAM (design §6.2:607). */
    readonly deviceMemoryLowGiB: 4;
    readonly deviceMemoryMiddleGiB: 8;
    readonly deviceMemoryHighGiB: 16;
    /** Weighted sharing and minimum progress, never an exemption from grants (§6.3:640–641). */
    readonly focusedPaneWeight: 2;
    readonly unfocusedPaneWeight: 1;
    readonly minPaneTileCredits: 2;
    readonly liveVectorScratchBytes: 2097152;
    /** Decoded CPU/bridge storage, distinct from the 12-byte surface reserve (§6.1:592,597). */
    readonly decodedRgbaBytesPerPixel: 4;
    readonly memorySoftPressureRatio: 0.9;
    readonly memoryTrimTargetRatio: 0.8;
    readonly liveInputGpuFraction: 0.25;
    /** Hysteresis from §6.3:643 and §6.4:653; lower q remains allowed if 0.5 cannot fit. */
    readonly qualityReductionFactor: 0.8;
    readonly minInteractiveQualityScale: 0.5;
    readonly memoryRecoveryDelayMs: 5000;
    readonly memoryMadeRoomRecoveryDelayMs: 1000;
    /** Over budget takes one quality step per settle window: the step re-plans the grants, and the charge settles after it. */
    readonly qualityStepSettleMs: 300;
    /** A level that failed under pressure is not retried until this back-off passes; the back-off doubles on each repeat failure. */
    readonly qualityFailureBackoffMinMs: 5000;
    readonly qualityFailureBackoffMaxMs: 60000;
    /** A level held this long without trouble forgets its failure, so the back-off starts again at the minimum. */
    readonly qualityFailureResetMs: 30000;
    /** A visibility resume rebuilds the presented picture at once; that rebuild's charge is not pressure for this long. */
    readonly resumePressureHoldMs: 1500;
    /** Trouble signals, not a claim that driver allocation sizes can be measured (§6.4:655). */
    readonly slowGpuSampleCount: 120;
    readonly stalledFenceMs: 250;
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

/** What the memory governor says to a layer, read-only: 'slow-gpu' when the GPU's p95 frame time overran the interval
 * (a layer halves its compose limit), 'pressure' when the governor is trimming or degraded for any other reason. */
export type LayerTrouble = 'none' | 'slow-gpu' | 'pressure';

/** The governor's trouble state as one pure mapping, so the governor's getter allocates nothing: a normal governor is
 * 'none'; a trimming or degraded one names its reason, and only the slow-GPU reason is 'slow-gpu'. */
export function layerTroubleOf(state: 'normal' | 'trimming' | 'degraded' | 'cpu-pinned', lastTrouble: string | null): LayerTrouble {
    if (state === 'normal') return 'none';
    return lastTrouble === 'slow-gpu' ? 'slow-gpu' : 'pressure';
}
