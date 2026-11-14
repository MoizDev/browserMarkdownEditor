import type { PageGeometry } from '../../platform/types';
import type { PlatformLayerDefinition, Rect } from '../../platform/render';
import type { PdfPool } from '../pool/types';
import type { WriterSource } from '../writing/protocol';

export interface PdfInkBackdropOptions {
    pool: PdfPool;
    source: WriterSource;
    readOnly: boolean;
    isCurrent(): boolean;
    isVisible(): boolean;
    isFocused(): boolean;
    emphasisEnabled(): boolean;
    onError(error: unknown): void;
    /** Host must cover the original surface opaquely while this is true. */
    onUpdating?(updating: boolean): void;
    signal?: AbortSignal;
}
export interface PdfInkBackdrop {
    pages: readonly { width: number; height: number }[];
    layers: readonly PlatformLayerDefinition[];
    resolveGeometry(page: number, signal: AbortSignal): Promise<PageGeometry>;
    capture: {
        renderPage(page: number, maxSide: number, signal?: AbortSignal): Promise<ImageBitmap>;
        captureRegion(rect: Rect, maxSide: number, signal?: AbortSignal): Promise<ImageBitmap>;
    };
    setVisible(visible: boolean, focused?: boolean): void;
    /** Call only after a real committed current shared frame, never a bridge presentation. */
    notePresentation(): void;
    dispose(): void;
}
