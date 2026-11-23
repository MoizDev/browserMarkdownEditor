import type { RenderConstants } from './types';

/** Fixed policy from rendering.md §4:115–132 and rendering-design.md §6. MiB are binary, not measurements.
 * Keep runtime values out of the type modules, and freeze nested policy records as well as the root.
 */
export const RENDER_CONSTANTS: RenderConstants = Object.freeze({
    maxAppContexts: 8,
    reservedTerminalContexts: 1,
    maxVisiblePaneContexts: 5,
    transitionContexts: 2,
    contextAttributes: Object.freeze({
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        // Not 'high-performance': an integrated GPU is a real GPU for this work, and asking for more wakes a dual-GPU Mac's discrete
        // GPU for every open document. A software renderer is refused by the broker (softwareRenderer), not by this attribute.
        powerPreference: 'default',
        desynchronized: false,
        failIfMajorPerformanceCaveat: true,
    }),
    colorSpace: 'srgb',
    maxSurfaceAxisPixels: 8192,
    maxSurfacePixels: 16777216,
    hiddenGpuReleaseDelayMs: 0,
    keptContextReserveBytes: 4194304,
    hiddenWindowRetentionMs: 300000,
    hiddenCpuMirrorLimitBytes: 67108864,
    tileInteriorPixels: 512,
    tileGutterTexels: 1,
    mediaTileInteriorPixels: 1024,
    movingTileLevelsPerOctave: 2,
    // Bounded tile motion, low coverage and request demand (rendering-design.md §5.1–5.7).
    motionLevelKeepMinDivisor: 1.15,
    motionLevelKeepMaxFactor: 1.6,
    versionBridgeDurationMs: 2000,
    lowPreviewScaleDivisor: 4,
    lowPreviewMaxAspectRatio: 16,
    lowPreviewAheadViewports: 2,
    lowPreviewBehindViewports: 1,
    maxPagePreviewsPerPane: 12,
    demandAgePromotionMs: 250,
    velocityWindowMs: 100,
    prefetchHorizonSeconds: 0.2,
    prefetchMinViewports: 0.25,
    prefetchMaxViewports: 1,
    prefetchBehindViewports: 0.25,
    pinchDemandIntervalMs: 50,
    settledDemandDelayMs: 100,
    tileWatchdogMs: 2000,
    tileRetryCount: 1,
    memoryCeilings: Object.freeze({
        low: Object.freeze({ gpuBytes: 134217728, cpuRasterBytes: 67108864 }),
        medium: Object.freeze({ gpuBytes: 268435456, cpuRasterBytes: 134217728 }),
        high: Object.freeze({ gpuBytes: 536870912, cpuRasterBytes: 268435456 }),
    }),
    gpuGrantMinBytes: 67108864,
    gpuGrantBaseBytes: 33554432,
    gpuGrantPerVisiblePaneBytes: 16777216,
    gpuGrantPerVisiblePixelBytes: 24,
    /** The DPR the GPU target's fixed terms scale to at most (by its square): a desktop's 2; a higher ratio adds only its pixels. */
    gpuGrantMaxDpr: 2,
    cpuGrantMinBytes: 33554432,
    cpuGrantPerVisiblePaneBytes: 8388608,
    // 8 B per visible device pixel held the board's working canvases and nothing for a picture shown across the view: at DPR 2 a
    // 4000x3000 picture's view tiles were refused beside them and quality stepped down forever with the picture never drawn
    // (measured, canvas2d, 1872x1456 device px). 4 B more per pixel is one RGBA copy of the view for picture tiles.
    cpuGrantPerVisiblePixelBytes: 12,
    // Governor policy from rendering-design.md §6.1–6.4; no thresholds are inferred from hardware.
    deviceMemoryLowGiB: 4,
    deviceMemoryMiddleGiB: 8,
    deviceMemoryHighGiB: 16,
    focusedPaneWeight: 2,
    unfocusedPaneWeight: 1,
    minPaneTileCredits: 2,
    liveVectorScratchBytes: 2097152,
    decodedRgbaBytesPerPixel: 4,
    memorySoftPressureRatio: 0.9,
    memoryTrimTargetRatio: 0.8,
    /** Most of the GPU pool a live gesture's working set (wet ink) may hold; it is never trimmed while held. */
    liveInputGpuFraction: 0.25,
    qualityReductionFactor: 0.8,
    minInteractiveQualityScale: 0.5,
    memoryRecoveryDelayMs: 5000,
    // The cool window after the governor made the room itself (it trimmed what no frame draws): the rest is already there, and the
    // full window held a WebGL2 PDF at 0.8, its editing cover up, for 5 s after every such step (t21: back to 1 within 3 s).
    memoryMadeRoomRecoveryDelayMs: 1000,
    qualityStepSettleMs: 300,
    // A real trouble at a level (a device limit, an allocation refusal) re-fires whenever the level is retried at once, a raise/drop
    // cycle every ~5 s. The back-off spaces the retries 5, 10, 20, 40, 60 s and forgets them once the level holds 30 s. Measured with
    // forced troubles at full quality (gpu-h13): retries 8.0, 12.1 and 20 s after each failure.
    qualityFailureBackoffMinMs: 5000,
    qualityFailureBackoffMaxMs: 60000,
    qualityFailureResetMs: 30000,
    resumePressureHoldMs: 1500,
    slowGpuSampleCount: 120,
    stalledFenceMs: 250,
    surfaceReserveBytesPerPixel: 12,
    surfaceMaxGpuGrantFraction: 0.4,
    frameTargetMaxMs: 4,
    frameTargetIntervalFraction: 0.45,
    contextLossPinCount: 3,
    contextLossWindowMs: 60000,
    webGpuMinP95FractionImprovement: 0.2,
    webGpuMinP95MsImprovement: 1,
    webGpuMinProcessMemoryFractionImprovement: 0.25,
    webGpuMinFamilies: 2,
});
