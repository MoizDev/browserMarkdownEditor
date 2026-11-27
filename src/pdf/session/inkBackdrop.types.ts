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
    fontEpoch(): number;
    notePresentation(backend: CompositorBackend): void;
    dispose(): void;
}
