import type { Affine, ViewState } from '../../platform/types';
import type { FrameToken } from '../../platform/render/types';
import type { PaintImageItem, PaintSource } from './paintStream';

/** One image the actual draw consumed, with the exact accepted ImageBitmap it sampled. */
export interface PresentedImage {
    readonly nodeId: string;
    /** The drawn item itself: rect, sourceRect crop, localToWorld, opacity, blend and inversion. */
    readonly item: PaintImageItem;
    readonly source: ImageBitmap;
}

/** Borrowed backings for asynchronous fact work. They stay alive until `release`, even after the
 * presentation has been superseded, and a later release frees them exactly once. `frame` is the
 * DRAWN frame (dense tiles included, in paint order), whose items `images` reference by identity. */
export interface PresentedImageLease {
    readonly frame: PaintSource;
    readonly images: readonly PresentedImage[];
    release(): void;
}

/** Exact paired-band draw state, not the later requested camera or desired omission. */
export interface ViewerPaintPresentation {
    readonly view: ViewState;
    readonly frameId: number;
    readonly token: FrameToken;
    /** Exact world-to-pane-CSS matrix at the paired draw, never a later camera lookup. */
    readonly paneTransform: Affine | null;
    readonly omittedNodeIds: ReadonlySet<string> | null;
    /** Retains the actual raw source frame, not its omission/ink presentation wrapper. */
    retain(): () => void;
    /** Borrows the exact accepted image backings this presentation drew. Null when the presentation
     * cannot be proven: the frame has moved on, or a drawn image is not a live ImageBitmap. Callers
     * then keep the true-order poster; they never invent alpha for unavailable facts. */
    retainImages(): PresentedImageLease | null;
}
