import type { ViewState } from '../types';
import type { ByteLease, GfxDevice, TargetHandle, TextureHandle } from './gfx/api';
import type { ReserveOptions } from './memoryGovernor';

export interface TileTarget {
    readonly device: GfxDevice;
    readonly texture: TextureHandle;
    readonly target: TargetHandle;
    readonly size: number;
    readonly bytes: number;
}

export function tileTargetBytes(size: number): number {
    return size * size * 4;
}

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

export function tileView(worldX: number, worldY: number, scale: number, size: number, epoch: number): ViewState {
    const view: ViewState = { camera: { x: worldX, y: worldY, z: scale }, viewport: { width: size, height: size, dpr: 1 }, epoch, moving: false };
    tileViews.add(view);
    return view;
}
const tileViews = new WeakSet<ViewState>();
export function isTileView(view: ViewState): boolean { return tileViews.has(view); }
