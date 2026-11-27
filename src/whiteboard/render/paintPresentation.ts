import type { Affine, ViewState } from '../../platform/types';
import type { FrameToken } from '../../platform/render/types';
import type { PaintImageItem, PaintSource } from './paintStream';

export interface PresentedImage {
    readonly nodeId: string;
    readonly item: PaintImageItem;
    readonly source: ImageBitmap;
}

export interface PresentedImageLease {
    readonly frame: PaintSource;
    readonly images: readonly PresentedImage[];
    release(): void;
}

export interface ViewerPaintPresentation {
    readonly view: ViewState;
    readonly frameId: number;
    readonly token: FrameToken;
    readonly paneTransform: Affine | null;
    readonly omittedNodeIds: ReadonlySet<string> | null;
    retain(): () => void;
    retainImages(): PresentedImageLease | null;
}
