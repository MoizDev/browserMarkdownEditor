import type { LayerHost, CompositorAppearance, CompositorLayer } from '../../platform/render/compositor.types';
import type { PageStack } from '../../platform/render/pageStack';
import type { RenderToken } from '../../platform/render/types';
import type { BoardKind } from '../model/doc';
import type { SheetId } from '../model/ids';
import type { PaintImageProvider } from '../render/resources';
import type { PaintPalette } from '../render/colour';

export type ViewerReadiness = 'loading' | 'ready' | 'read-only' | 'failed';
export interface ViewerPageSize { readonly width: number; readonly height: number }
export interface ViewerViewParams {
    readonly visible: boolean;
    readonly focused: boolean;
    readonly theme: 'light' | 'dark';
    readonly inverted: boolean; // Whole document group only, never chrome/export.
    readonly sheetId?: SheetId;
    /** PDF page dimensions come from the PDF host. Notebook dimensions come from its paper. */
    readonly pages?: readonly ViewerPageSize[];
    /** Host layers (for example PDF page pixels), NOT document nodes. Lifecycle owns them. */
    readonly backdrops?: readonly CompositorLayer[];
}
export interface ViewerAccessibilityItem {
    readonly id: string;
    readonly label: string;
    readonly selected: boolean;
}
export interface ViewerAccessibilitySnapshot {
    readonly token: RenderToken;
    readonly sceneRevision: number;
    readonly sheetName: string;
    readonly total: number;
    /** Ordered, deduplicated union: nearby window, up to 500 selected, and focused item. */
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
    readonly layers: readonly CompositorLayer[];
}
export interface ViewerEngine {
    readonly accessibility: ViewerAccessibilitySource;
    getSnapshot(): ViewerSnapshot;
    subscribe(listener: () => void): () => void;
    setView(params: ViewerViewParams): void;
    /** Keyboard/a11y reveal delegates to the shared host camera, never a private pan loop. */
    focusNode(id: string): void;
    /** Host detaches the platform pane FIRST (which disposes layers). This frees session/model
     * leases and listeners only; it never double-disposes lifecycle-owned registered layers.
     */
    dispose(): void;
}
export interface OpenViewerOptions {
    readonly bytes: Uint8Array;
    readonly kind: BoardKind;
    readonly token: RenderToken;
    readonly host: LayerHost;
    readonly view: ViewerViewParams;
    readonly palette?: Readonly<{ light: PaintPalette; dark: PaintPalette }>;
    readonly images?: PaintImageProvider;
    readonly signal?: AbortSignal;
    /** Host camera reveal; the engine supplies world bounds after exact geometry is ready. */
    readonly reveal: (world: Readonly<{ x: number; y: number; width: number; height: number }>) => void;
    readonly onError: (error: Error) => void;
}
/** React lazy host imports openViewer.ts when its implementation is available. No DOM in engine. */
export type OpenViewer = (options: OpenViewerOptions) => Promise<ViewerEngine>;
