import type { RenderToken } from '../../platform/render/types';
import type { PaintFrame } from './paintStream';

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
}
export interface PaintFrameSource {
    /** O(1), complete immutable frame only. Null means no publishable frame yet. */
    readFrame(): PaintFrame | null;
    isCurrent(frame: PaintFrame): boolean;
}
export interface PaintLayerResources {
    readonly frames: PaintFrameSource;
    readonly images: PaintImageProvider;
    /** The existing LayerHost/scheduler invalidation, not another requestAnimationFrame loop. */
    invalidate(): void;
}
