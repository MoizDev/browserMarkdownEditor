import type { ViewState } from '../types';
import type { ByteLease, GfxDevice, TargetHandle, TextureHandle } from './gfx/api';
import type { ReserveOptions } from './memoryGovernor';

/**
 * A layer-owned square render target that a tile's content is composed INTO on the GPU (Layer.encodeOffscreen), then
 * sampled by the layer's own drawGpu: one texture and one single-sample, stencil-less target. It is charged to the
 * caller's GPU allocator through one lease, which the device returns when the texture retires.
 */
export interface TileTarget {
    readonly device: GfxDevice;
    readonly texture: TextureHandle;
    readonly target: TargetHandle;
    readonly size: number;
    readonly bytes: number;
}

/** RGBA colour only: path winding uses the coverage kit's own scratch target, never the tile's. */
export function tileTargetBytes(size: number): number {
    return size * size * 4;
}

/** Null when the allocator refuses: a wait for capacity, never an unaccounted allocation. */
export function createTileTarget(device: GfxDevice, allocator: { reserve(bytes: number, options?: ReserveOptions): ByteLease | null; release(lease: ByteLease): void },
    size: number, options?: ReserveOptions): TileTarget | null {
    if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError('Invalid tile target size');
    const bytes = tileTargetBytes(size);
    const lease = allocator.reserve(bytes, options);
    if (!lease) return null;
    let made: { texture: TextureHandle; target: TargetHandle };
    try { made = device.createRenderTexture(size, size, lease); }
    catch (error) { allocator.release(lease); throw error; }
    return Object.freeze({ device, texture: made.texture, target: made.target, size, bytes });
}

export function destroyTileTarget(tile: TileTarget): void {
    tile.device.destroy(tile.target);
    tile.device.destroy(tile.texture);
}

/**
 * The view a tile is composed in: its own pixels, dpr 1, camera at the tile's world origin and zoom equal to the raster
 * scale (device pixels per world unit). Every GPU drawing route that takes a pane's ViewState (path coverage, analytic
 * ink, textured quads) then draws into the tile unchanged, in the same paint order as the 2D reference.
 */
export function tileView(worldX: number, worldY: number, scale: number, size: number, epoch: number): ViewState {
    return { camera: { x: worldX, y: worldY, z: scale }, viewport: { width: size, height: size, dpr: 1 }, epoch, moving: false };
}
