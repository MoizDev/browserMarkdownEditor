import type { Camera, Rect, ViewState } from '../types';
import type { DamageRecord } from './damage';
import type { CaptureExportOptions } from './captureExport';
import type { CameraController, Point } from './camera';
import type { CompositorAppearance, CompositorBackend, CompositorCaptureOptions, CompositorIsolation, CompositorMirrorQuad, LayerCoverage, LayerHost } from './compositor.types';
import type { BorrowedMirror, MirrorSet, MirrorView } from './mirrorSet';
import type { PageStack } from './pageStack';
import type { ScheduledFrame, TouchPanSample } from './scheduler';
import type { GpuUnavailableCause } from './surfaceBroker.types';
import type { FrameToken, Layer, RenderToken } from './types';

export interface PlatformLayerDefinition {
    readonly id: string;
    readonly group: 'document' | 'chrome';
    readonly isolation?: CompositorIsolation;
    create(host: LayerHost): Layer;
    revision(layer: Layer): number;
    drawVersion?(layer: Layer): number;
    cpuWorkingSet?(layer: Layer, viewport: Readonly<{ width: number; height: number }>): Readonly<{
        mandatoryBytes: number;
        prefetchBytes: number;
    }>;
    gpuWorkingSet?(layer: Layer, viewport: Readonly<{ width: number; height: number }>): Readonly<{ mandatoryBytes: number }>;
    cpuEvict?(layer: Layer, bytes: number): void;
    readonly liveInput?: boolean;
    readonly foregroundCpu?: boolean;
    critical(layer: Layer, view: ViewState): boolean;
    benchmarkDomain?(layer: Layer, frame: ScheduledFrame): readonly Readonly<Rect>[];
    coverage(layer: Layer, frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage;
}

export interface PlatformPresentation extends LayerCoverage {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly backend: CompositorBackend;
    readonly viewEpoch: number;
    readonly revision: string;
    readonly drawnFrameId?: number;
}

export interface PlatformPaneOptions<T extends object> {
    readonly paneId: string;
    readonly backendPreference?: 'auto' | 'canvas2d';
    readonly viewLease: number;
    readonly documentToken: RenderToken;
    readonly session: {
        readonly mirrors: MirrorSet<T> | null;
        checkpoint(): void;
        captureRegion?(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<ImageBitmap>;
        captureBlob?(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<Blob>;
        captureExportBlob?(worldRect: Rect, maxSidePx: number, options: CaptureExportOptions): Promise<Blob>;
    };
    readonly layers: readonly PlatformLayerDefinition[];
    readonly initialVisible: boolean;
    readonly initialFocused: boolean;
    readonly layout: Readonly<PageStack> | null;
    readLayout?(): Readonly<PageStack> | null;
    readAppearance(): CompositorAppearance;
    currentToken(): RenderToken | null;
    readonly camera?: CameraController;
    readCamera(): Camera;
    readMirrorView?(view: ViewState): MirrorView;
    revision(): string;
    consumeInput(timestamp: number): void;
    isInteracting(): boolean;
    setInputEnabled(enabled: boolean): void;
    cancelViewWork(reason: string): void;
    writeOverlays(frame: ScheduledFrame): void;
    onPresentation(presentation: PlatformPresentation | null): void;
    onError(error: unknown): void;
    onNotice(message: 'memory-pressure' | 'cpu-floor-denied' | 'gpu-unavailable' | 'cpu-pinned', cause?: GpuUnavailableCause): void;
    onNoticeCleared?(message: 'gpu-unavailable' | 'memory-pressure' | 'cpu-floor-denied', cause?: GpuUnavailableCause): void;
    onQualityChange?(report: { readonly qualityScale: number }): void;
    mirrorQuad?(entry: BorrowedMirror<T>, view: MirrorView): CompositorMirrorQuad | null;
    mirrorCoverage?(view: MirrorView, drawn: readonly BorrowedMirror<T>[]): LayerCoverage;
}

export type AttachPlatformPane = <T extends object>(host: HTMLElement, options: PlatformPaneOptions<T>) => PlatformPane;

export interface PlatformPane {
    currentFrameToken(): FrameToken | null;
    setVisible(visible: boolean): void;
    setFocused(focused: boolean): void;
    observeSize(): void;
    setLayers(layers: readonly PlatformLayerDefinition[]): void;
    beginFreshView(): void;
    invalidate(reason: string, damage?: DamageRecord): void;
    startFling(samples: readonly TouchPanSample[]): void;
    animateZoom(targetZ: number, anchor?: Point): void;
    animatePan(delta: Point, durationMs: number): void;
    glideTo(target: Camera, durationMs: number): void;
    cancelMotion(): void;
    captureRegion(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<ImageBitmap>;
    captureBlob(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<Blob>;
    captureExportBlob(worldRect: Rect, maxSidePx: number, options: CaptureExportOptions): Promise<Blob>;
    dispose(): void;
}
