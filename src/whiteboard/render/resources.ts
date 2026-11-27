import type { RenderToken } from '../../platform/render/types';
import type { PaintSource } from './paintStream';

export interface PaintImageLease {
    readonly source: CanvasImageSource;
    readonly width: number;
    readonly height: number;
    readonly cpuBytes: number;
    release(): void; // Idempotent; the consumer never closes a borrowed bitmap directly.
}
export interface PaintImageProvider {
    /** O(1) admission; decode is async, origin-clean, dimension-limited and token-pinned.
     * Abort/rejection publishes nothing. A late fulfilled lease must still be released.
     */
    acquire(imageKey: string, token: RenderToken, signal: AbortSignal): Promise<PaintImageLease>;
    mediaSize?(imageKey: string): { readonly id: string; readonly mime: string; readonly width: number; readonly height: number } | null;
}
export interface PaintFrameSource {
    readFrame(): PaintSource | null;
    isCurrent(frame: PaintSource): boolean;
}
export interface PaintLayerResources {
    readonly frames: PaintFrameSource;
    readonly images: PaintImageProvider;
    invalidate(): void;
    wakeAt?(deadlineMs: number | null): void;
    replan?(): void;
    textureHeld?(imageKey: string): boolean;
}
