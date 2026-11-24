import type { PageGeometry } from '../../platform/types';
import type { PlatformLayerDefinition, Rect } from '../../platform/render';
import type { CompositorBackend } from '../../platform/render/compositor.types';
import type { CaptureRequest, CaptureSnapshot } from '../../platform/render/capture';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
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
    captureSnapshot(request: CaptureRequest, memory: MemoryAllocator): CaptureSnapshot;
    capture: {
        renderPage(page: number, maxSide: number, signal?: AbortSignal): Promise<ImageBitmap>;
        captureRegion(rect: Rect, maxSide: number, signal?: AbortSignal): Promise<ImageBitmap>;
    };
    setVisible(visible: boolean, focused?: boolean): void;
    /** The document's font-profile epoch. A snapshot pins the epoch it was taken at; a font provided
     * later advances it and invalidates that snapshot, so a capture re-pins only by taking a new one. */
    fontEpoch(): number;
    /** Call only after a real committed current shared frame, never a bridge presentation, naming the backend that presented it. */
    notePresentation(backend: CompositorBackend): void;
    dispose(): void;
}
