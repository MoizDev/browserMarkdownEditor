import type { PlatformLayerDefinition, PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { EmbedPresentationPort } from '../../platform/render/embedPresentation.types';
import type { CompositorAppearance } from '../../platform/render/compositor.types';
import type { PageStack } from '../../platform/render/pageStack';
import type { RenderToken } from '../../platform/render/types';
import type { SheetId } from '../model/ids';
import type { PaintImageProvider } from '../render/resources';
import type { PaintFrame } from '../render/paintStream';
import type { VideoFrameOverlay } from '../media/videoFrames';
import type { ViewerPaintPresentation } from '../render/paintPresentation';
export type { ViewerPaintPresentation } from '../render/paintPresentation';
import type { PaintPalette } from '../render/colour';
import type { SceneSpatial } from '../scene/types';
import type { BoardSession } from '../session/BoardSession';
import type { HistoryStepInfo, TextSelectionSnapshot } from '../change/historyTypes';

export type ViewerReadiness = 'loading' | 'ready' | 'read-only' | 'failed';
export interface ViewerPageSize { readonly width: number; readonly height: number }
export interface ViewerViewParams {
    readonly visible: boolean;
    readonly focused: boolean;
    readonly theme: 'light' | 'dark';
    readonly inverted: boolean;
    readonly sheetId?: SheetId;
    readonly pages?: readonly ViewerPageSize[];
    /** Host backdrops, never model nodes. Definitions acquire LayerHost synchronously in create. */
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
    presented?(revision: number, token: RenderToken, frame?: PaintFrame, context?: ViewerPaintPresentation): void;
    liveNodeIds?(): ReadonlySet<string>;
    /** The theme palette changed. Interaction-owned paint (the wet ink source) caches pigments
     * from the palette and is only refreshed when its own layer is prepared, so the view must
     * tell it: the main layers' invalidation alone leaves a dark pigment on screen. */
    paletteChanged?(): void;
    /** Immutable, identity-stable semantic hover/edit targets requiring exact paint. */
    sensitiveNodeIds?(): ReadonlySet<string>;
}
export interface ViewerEngine {
    readonly session: BoardSession; // EXACT same instance the App acquired; never a second doc.
    readonly scene: SceneSpatial;
    readonly accessibility: ViewerAccessibilitySource;
    getSnapshot(): ViewerSnapshot;
    /** The layers' own deadline: a wake invalidates the view and nothing else. Picture animation schedules through it. */
    wakeAt(deadlineMs: number | null): void;
    getView(): ViewerViewParams;
    subscribe(listener: () => void): () => void;
    setView(params: ViewerViewParams): void;
    focusNode(id: string): void;
    cancelReveal(): void;
    bindInteractions(ports: ViewerInteractionPorts): () => void;
    connectEmbeds(port: EmbedPresentationPort | null): void;
    /** The platform's acceptance of a presented frame; the embed producer builds only after this matches its draw. */
    presentationAccepted(presentation: PlatformPresentation | null): void;
    readyPaintFrame(): PaintFrame | null;
    setInteractionLayers(layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }> | null): void;
    setPreviewLayers(layers: Readonly<{ underlay: PlatformLayerDefinition; content: PlatformLayerDefinition }> | null,
        coverage?: () => Readonly<{ frame: PaintFrame; nodeIds: ReadonlySet<string> }> | null): void;
    bindPreviewClear(clear: () => void): () => void;
    /** Detach the platform pane first: lifecycle disposes its layers. Releases only this view's
     * jobs/borrowed leases/listeners, NEVER the App-owned BoardSession or its undo/save state.
     */
    dispose(): void;
}
export interface AttachViewOptions {
    readonly session: BoardSession;
    readonly token: RenderToken;
    readonly view: ViewerViewParams;
    readonly palette?: Readonly<{ light: PaintPalette; dark: PaintPalette }>;
    readonly images?: PaintImageProvider;
    /** A view's playing video frames, served by their own image keys. Absent for any view with no video to play. */
    readonly liveFrames?: VideoFrameOverlay;
    readonly signal?: AbortSignal;
    readonly reveal: (world: Readonly<{ x: number; y: number; width: number; height: number }>) => void;
    readonly onError: (error: Error) => void;
}
/** Synchronous attachment, no LayerHost needed here. CPU/layout work may remain loading.
 * Returned definitions construct Layers synchronously inside PlatformLayerDefinition.create(host).
 * Admission/byte parsing belongs to the ONE App-owned BoardSession, before attaching a view.
 */
export type AttachView = (options: AttachViewOptions) => ViewerEngine;
export type OpenViewerOptions = AttachViewOptions;
export type OpenViewer = AttachView;
