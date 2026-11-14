import type { Camera, ViewState } from '../types';
import type { CompositorAppearance, CompositorBackend, CompositorIsolation, CompositorMirrorQuad, LayerCoverage, LayerHost } from './compositor.types';
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
    critical(layer: Layer, view: ViewState): boolean;
    coverage(layer: Layer, frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage;
}

export interface PlatformPresentation extends LayerCoverage {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly backend: CompositorBackend;
}

/** All callbacks are current snapshots, not closures over the view that first mounted the pane. */
export interface PlatformPaneOptions<T extends object> {
    readonly paneId: string;
    readonly viewLease: number;
    readonly documentToken: RenderToken;
    readonly session: { readonly mirrors: MirrorSet<T> | null; checkpoint(): void };
    readonly layers: readonly PlatformLayerDefinition[];
    readonly initialVisible: boolean;
    readonly initialFocused: boolean;
    readonly layout: Readonly<PageStack> | null;
    readonly appearance: CompositorAppearance;
    currentToken(): RenderToken | null;
    readCamera(): Camera;
    readMirrorView(view: ViewState): MirrorView;
    revision(): string;
    consumeInput(timestamp: number): void;
    isInteracting(): boolean;
    setInputEnabled(enabled: boolean): void;
    cancelViewWork(reason: string): void;
    writeOverlays(frame: ScheduledFrame): void;
    onPresentation(presentation: PlatformPresentation | null): void;
    onError(error: unknown): void;
    onNotice(message: 'memory-pressure' | 'gpu-unavailable' | 'cpu-pinned'): void;
    mirrorQuad?(entry: BorrowedMirror<T>, view: MirrorView): CompositorMirrorQuad | null;
    mirrorCoverage?(view: MirrorView, drawn: readonly BorrowedMirror<T>[]): LayerCoverage;
}

export interface PlatformPane {
    setVisible(visible: boolean): void;
    setFocused(focused: boolean): void;
    observeSize(): void;
    setLayers(layers: readonly PlatformLayerDefinition[]): void;
    invalidate(reason: string): void;
    dispose(): void;
}
