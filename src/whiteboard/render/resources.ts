import type { RenderToken } from '../../platform/render/types';
import type { PaintSource } from './paintStream';

/** Decoder/broker ownership stays with the injected provider, never a Canvas executor. */
export interface PaintImageLease {
    readonly source: CanvasImageSource;
    readonly width: number;
    readonly height: number;
    /** Bytes attributable to THIS lease; zero when its shared backing is charged by the provider. */
    readonly cpuBytes: number;
    release(): void; // Idempotent; the consumer never closes a borrowed bitmap directly.
}
export interface PaintImageProvider {
    /** O(1) admission; decode is async, origin-clean, dimension-limited and token-pinned.
     * Abort/rejection publishes nothing. A late fulfilled lease must still be released.
     */
    acquire(imageKey: string, token: RenderToken, signal: AbortSignal): Promise<PaintImageLease>;
    /** A still picture's media id and full size from its media entry, for a whole-picture key ('sha256:<hash>' or 'media:<hash>:0');
     * null for anything else. Lets an export embed a picture's original bytes without decoding it. */
    mediaSize?(imageKey: string): { readonly id: string; readonly mime: string; readonly width: number; readonly height: number } | null;
}
export interface PaintFrameSource {
    /** O(1), complete immutable frame only. Null means no publishable frame yet. */
    readFrame(): PaintSource | null;
    isCurrent(frame: PaintSource): boolean;
}
export interface PaintLayerResources {
    readonly frames: PaintFrameSource;
    readonly images: PaintImageProvider;
    /** The existing LayerHost/scheduler invalidation, not another requestAnimationFrame loop. */
    invalidate(): void;
    /** The host's delayed wake (LayerHost.wakeAt), for work that must come back later without a frame loop. */
    wakeAt?(deadlineMs: number | null): void;
    /** Asks for a new frame from the scene (a new plan), for a picture whose tile level the pool refused. */
    replan?(): void;
    /** True when the device already holds this picture's texture, so a new snapshot need not decode its bitmap (the GPU route draws
     * the texture; a CPU draw that needs the bitmap asks for it again, as for one the route released). Absent: always decode. */
    textureHeld?(imageKey: string): boolean;
}
