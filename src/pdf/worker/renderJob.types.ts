import type { DeviceRect } from '../engine/types';

/** Supplied by the contained worker dispatcher; cancellation is the only
 * signal allowed to bypass its serialized engine operation queue. */
export interface RenderSliceHooks {
    readonly signal: AbortSignal;
    heartbeat(): void;
    cooperate?(): Promise<void>;
}
export interface CopiedTile {
    readonly pixels: ArrayBuffer;
    readonly w: number;
    readonly h: number;
    readonly originX: number;
    readonly originY: number;
}
export interface RenderTileBounds { readonly rect: DeviceRect; readonly maxTileEdge: number; readonly maxTileBytes: number }
