import type { Camera, Rect, ViewState } from '../types';
import type { CompositorAppearance, CompositorBackend, CompositorCaptureOptions, CompositorIsolation, CompositorMirrorQuad, LayerCoverage, LayerHost } from './compositor.types';
import type { BorrowedMirror, MirrorSet, MirrorView } from './mirrorSet';
import type { PageStack } from './pageStack';
import type { ScheduledFrame } from './scheduler';
import type { FrameToken, Layer, RenderToken } from './types';

/** Retain a definition object to retain its layer across setLayers; removing it ends the layer once. */
export interface PlatformLayerDefinition {
    readonly id: string;
    readonly group: 'document' | 'chrome';
    readonly isolation?: CompositorIsolation;
    create(host: LayerHost): Layer;
    revision(layer: Layer): number;
    /** Prospective CPU bytes for the physical viewport, separate from currently leased memory. */
    cpuWorkingSet?(layer: Layer, viewport: Readonly<{ width: number; height: number }>): Readonly<{
        mandatoryBytes: number;
        prefetchBytes: number;
    }>;
    critical(layer: Layer, view: ViewState): boolean;
    coverage(layer: Layer, frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage;
}

export interface PlatformPresentation extends LayerCoverage {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly backend: CompositorBackend;
    readonly viewEpoch: number;
    readonly revision: string;
}

/** All callbacks are current snapshots, not closures over the view that first mounted the pane. */
export interface PlatformPaneOptions<T extends object> {
    readonly paneId: string;
    readonly viewLease: number;
    readonly documentToken: RenderToken;
    readonly session: {
        readonly mirrors: MirrorSet<T> | null;
        checkpoint(): void;
        captureRegion?(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<ImageBitmap>;
    };
    readonly layers: readonly PlatformLayerDefinition[];
    readonly initialVisible: boolean;
    readonly initialFocused: boolean;
    readonly layout: Readonly<PageStack> | null;
    /** Optional immutable layout snapshot for page/sheet changes after attachment. */
    readLayout?(): Readonly<PageStack> | null;
    readAppearance(): CompositorAppearance;
    currentToken(): RenderToken | null;
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
    onNotice(message: 'memory-pressure' | 'gpu-unavailable' | 'cpu-pinned'): void;
    /** Report presented quality changes, including recovery; never report an unpresented allocation (§6.4:653). */
    onQualityChange?(report: { readonly qualityScale: number }): void;
    mirrorQuad?(entry: BorrowedMirror<T>, view: MirrorView): CompositorMirrorQuad | null;
    mirrorCoverage?(view: MirrorView, drawn: readonly BorrowedMirror<T>[]): LayerCoverage;
}

export type AttachPlatformPane = <T extends object>(host: HTMLElement, options: PlatformPaneOptions<T>) => PlatformPane;

export interface PlatformPane {
    setVisible(visible: boolean): void;
    setFocused(focused: boolean): void;
    observeSize(): void;
    setLayers(layers: readonly PlatformLayerDefinition[]): void;
    invalidate(reason: string): void;
    captureRegion(worldRect: Rect, maxSidePx: number, options: CompositorCaptureOptions): Promise<ImageBitmap>;
    dispose(): void;
}
