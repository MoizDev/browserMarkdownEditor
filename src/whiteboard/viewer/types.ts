import type { PlatformLayerDefinition, PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { ViewState } from '../../platform/types';
import type { EmbedPresentationPort } from '../../platform/render/embedPresentation.types';
import type { CompositorAppearance } from '../../platform/render/compositor.types';
import type { PageStack } from '../../platform/render/pageStack';
import type { RenderToken } from '../../platform/render/types';
import type { SheetId } from '../model/ids';
import type { PaintImageProvider } from '../render/resources';
import type { PaintProgress } from '../render/boardLayers';
import type { PaintSource } from '../render/paintStream';
import type { VideoFrameOverlay } from '../media/videoFrames';
import type { ViewerPaintPresentation } from '../render/paintPresentation';
export type { ViewerPaintPresentation } from '../render/paintPresentation';
import type { PaintPalette } from '../render/colour';
import type { SceneSpatial } from '../scene/types';
import type { BoardSession } from '../session/BoardSession';
import type { HistoryStepInfo, TextSelectionSnapshot } from '../change/historyTypes';

export type ViewerReadiness = 'loading' | 'ready' | 'read-only' | 'failed';
export type ViewerPaintProgress = PaintProgress;
export interface ViewerPageSize { readonly width: number; readonly height: number }
export interface ViewerViewParams {
    readonly visible: boolean;
    readonly focused: boolean;
    readonly theme: 'light' | 'dark';
    readonly inverted: boolean;
    readonly sheetId?: SheetId;
    readonly pages?: readonly ViewerPageSize[];
    readonly backdrops?: readonly PlatformLayerDefinition[];
}
export interface ViewerAccessibilityItem { readonly id: string; readonly label: string; readonly selected: boolean }
export interface ViewerAccessibilitySnapshot {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly sheetName: string;
    readonly total: number;
    readonly items: readonly ViewerAccessibilityItem[];
    readonly selectedCount: number;
    readonly focusedId: string | null;
}
export interface ViewerAccessibilitySource {
    getSnapshot(): ViewerAccessibilitySnapshot;
    subscribe(listener: () => void): () => void;
}
export interface ViewerSnapshot {
    readonly state: ViewerReadiness;
    readonly paint: ViewerPaintProgress;
    readonly readOnlyReason: string | null;
    readonly sceneRevision: number;
    readonly layout: Readonly<PageStack> | null;
    readonly appearance: CompositorAppearance;
    readonly palette: PaintPalette;
    readonly layers: readonly PlatformLayerDefinition[];
    readonly backendPreference?: 'auto' | 'canvas2d';
}
export interface ViewerInteractionPorts {
    finishGesture(): void;
    finishComposition(): void;
    captureText?(): TextSelectionSnapshot | undefined;
    restoreText?(snapshot: TextSelectionSnapshot): void;
    beforeHistoryReplay?(step: HistoryStepInfo, direction: 'undo' | 'redo'): boolean;
    presented?(revision: number, token: RenderToken, frame?: PaintSource, context?: ViewerPaintPresentation): void;
    liveNodeIds?(): ReadonlySet<string>;
    liveDraws?(nodeId: string, band: 'underlay' | 'content', view: ViewState, canvas: boolean): boolean;
    paletteChanged?(): void;
    sensitiveNodeIds?(): ReadonlySet<string>;
    pointerDown?(): boolean;
}
export interface ViewerEngine {
    readonly session: BoardSession; // EXACT same instance the App acquired; never a second doc.
    readonly scene: SceneSpatial;
    readonly accessibility: ViewerAccessibilitySource;
    getSnapshot(): ViewerSnapshot;
    wakeAt(deadlineMs: number | null): void;
    getView(): ViewerViewParams;
    subscribe(listener: () => void): () => void;
    setView(params: ViewerViewParams): void;
    focusNode(id: string): void;
    cancelReveal(): void;
    bindInteractions(ports: ViewerInteractionPorts): () => void;
    connectEmbeds(port: EmbedPresentationPort | null): void;
    presentationAccepted(presentation: PlatformPresentation | null): void;
    embedsChanged(): void;
    readyPaintFrame(): PaintSource | null;
    boardDrawnInk(): ReadonlySet<string>;
    setInteractionLayers(layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }> | null): void;
    setPreviewLayers(layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }> | null,
        coverage?: () => Readonly<{ frame: PaintSource; nodeIds: ReadonlySet<string>;
            committed?: number }> | null): void;
    bindPreviewClear(clear: () => void): () => void;
    dispose(): void;
}
export interface AttachViewOptions {
    readonly session: BoardSession;
    readonly token: RenderToken;
    readonly view: ViewerViewParams;
    readonly palette?: Readonly<{ light: PaintPalette; dark: PaintPalette }>;
    readonly images?: PaintImageProvider;
    readonly liveFrames?: VideoFrameOverlay;
    readonly signal?: AbortSignal;
    readonly auditPane?: string;
    readonly reveal: (world: Readonly<{ x: number; y: number; width: number; height: number }>) => void;
    readonly onError: (error: Error) => void;
}
export type AttachView = (options: AttachViewOptions) => ViewerEngine;
export type OpenViewerOptions = AttachViewOptions;
export type OpenViewer = AttachView;
