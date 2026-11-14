import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { CompositorAppearance } from '../../platform/render/compositor.types';
import type { PageStack } from '../../platform/render/pageStack';
import type { RenderToken } from '../../platform/render/types';
import type { SheetId } from '../model/ids';
import type { PaintImageProvider } from '../render/resources';
import type { PaintPalette } from '../render/colour';
import type { SceneSpatial } from '../scene/types';
import type { BoardSession } from '../session/BoardSession';

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
}
export interface ViewerEngine {
    readonly session: BoardSession; // EXACT same instance the App acquired; never a second doc.
    readonly scene: SceneSpatial;
    readonly accessibility: ViewerAccessibilitySource;
    getSnapshot(): ViewerSnapshot;
    subscribe(listener: () => void): () => void;
    setView(params: ViewerViewParams): void;
    focusNode(id: string): void;
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
