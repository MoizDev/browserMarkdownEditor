import type { Rect } from '../../platform/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { PaintImageItem } from './paintStream';

export const IMAGE_SAMPLING_PROFILE = Object.freeze({ kernel: 'bilinear', mips: 'none', quality: 'low' } as const);

export const TILE_EDGE = 512, TILE_GUTTER = 2, TILE_SIZE = TILE_EDGE + 2 * TILE_GUTTER;
export const TILE_CROP: Readonly<Rect> = Object.freeze({ x: TILE_GUTTER, y: TILE_GUTTER, width: TILE_EDGE, height: TILE_EDGE });
const IDENTITY_AFFINE = [1, 0, 0, 1, 0, 0] as const;

export function isGutterQuadTile(item: PaintImageItem): boolean {
    const { rect, sourceRect: src } = item;
    return item.retainedTile === true && item.blend === 'normal' && item.opacity === 1 && !item.inverted && item.clips.length === 0
        && item.localToWorld.every((value, index) => value === IDENTITY_AFFINE[index])
        && src?.x === TILE_GUTTER && src.y === TILE_GUTTER && src.width === TILE_EDGE && src.height === TILE_EDGE
        && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.width === rect.height;
}

export function isGutterQuadDraw(item: PaintImageItem, image: CanvasImageSource): boolean {
    return isGutterQuadTile(item) && typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap
        && image.width === TILE_SIZE && image.height === TILE_SIZE;
}

export interface DeviceRect { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export interface AlphaPlane { readonly width: number; readonly height: number; readonly alpha: Uint8Array }

export interface FootprintInput {
    readonly plane: AlphaPlane;
    readonly window: Readonly<Rect>;
    readonly quad: DeviceRect;
    readonly within?: DeviceRect;
    readonly maxRuns: number;
}

export type FootprintFacts =
    | { readonly status: 'translucent' }
    | { readonly status: 'opaque'; readonly runs: Int32Array }
    | { readonly status: 'unavailable'; readonly reason: string };

const MAX_PIXELS = 4 * 1024 * 1024;

const clampTexel = (index: number, size: number) => index < 0 ? 0 : index >= size ? size - 1 : index;

export function classifyImageFootprint(input: FootprintInput): FootprintFacts {
    const { plane, window, quad, within, maxRuns } = input;
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 0) throw new RangeError('Invalid footprint run bound');
    if (plane.alpha.length !== plane.width * plane.height) throw new RangeError('Alpha plane size mismatch');
    const { x0, y0, x1, y1 } = quad;
    if (![x0, y0, x1, y1, window.x, window.y, window.width, window.height].every(Number.isFinite) || !(x1 > x0) || !(y1 > y0)
        || !(window.width > 0) || !(window.height > 0)) return { status: 'unavailable', reason: 'degenerate quad' };
    const left = Math.max(Math.floor(x0), within ? within.x0 : -Infinity), right = Math.min(Math.ceil(x1), within ? within.x1 : Infinity);
    const top = Math.max(Math.floor(y0), within ? within.y0 : -Infinity), bottom = Math.min(Math.ceil(y1), within ? within.y1 : Infinity);
    if (!(right > left) || !(bottom > top)) return { status: 'opaque', runs: new Int32Array(0) };
    if ((right - left) * (bottom - top) > MAX_PIXELS) return { status: 'unavailable', reason: 'region exceeds the classification bound' };
    const { width: w, height: h, alpha } = plane;
    const kx = window.width / (x1 - x0), ky = window.height / (y1 - y0);
    const runs: number[] = [];
    for (let py = top; py < bottom; py++) {
        const cy = py + 0.5;
        if (cy < y0 || cy >= y1) { continue; }
        const ty = window.y + (cy - y0) * ky - 0.5, iy = Math.floor(ty), fy = ty - iy;
        const ya = clampTexel(iy, h), yb = clampTexel(iy + 1, h), useYb = fy > 0;
        let runStart = -1;
        for (let px = left; px <= right; px++) {
            let opaque = false;
            const cx = px + 0.5;
            if (px < right && cx >= x0 && cx < x1) {
                const tx = window.x + (cx - x0) * kx - 0.5, ix = Math.floor(tx), fx = tx - ix;
                const xa = clampTexel(ix, w), xb = clampTexel(ix + 1, w), useXb = fx > 0;
                let min = 255, max = 0;
                for (let k = 0; k < (useYb ? 2 : 1); k++) {
                    const row = (k === 0 ? ya : yb) * w;
                    for (let j = 0; j < (useXb ? 2 : 1); j++) {
                        const value = alpha[row + (j === 0 ? xa : xb)];
                        if (value < min) min = value;
                        if (value > max) max = value;
                    }
                }
                if (min === 255 && max === 255) opaque = true;
                else if (max !== 0) return { status: 'translucent' };
            }
            if (opaque) { if (runStart < 0) runStart = px; }
            else if (runStart >= 0) {
                runs.push(runStart, py, px - runStart, 1);
                runStart = -1;
                if (runs.length > maxRuns * 4) return { status: 'unavailable', reason: 'opaque coverage exceeds the run bound' };
            }
        }
    }
    return { status: 'opaque', runs: Int32Array.from(runs) };
}

export function texturedQuad(dest: Readonly<Rect>, textureSize: number, crop: Readonly<Rect>): DeviceRect {
    const gutter = crop.x;
    if (crop.y !== gutter || crop.width !== crop.height || crop.x + crop.width + gutter !== textureSize || gutter < 0
        || !(dest.width > 0) || !Number.isFinite(dest.x) || !Number.isFinite(dest.y)) throw new RangeError('Unsupported textured quad crop');
    const apron = gutter * dest.width / crop.width;
    return { x0: dest.x - apron, y0: dest.y - apron, x1: dest.x + dest.width + apron, y1: dest.y + dest.height + apron };
}

export function readAlphaPlane(source: CanvasImageSource, width: number, height: number,
    allocator: MemoryAllocator): { plane: AlphaPlane; lease: ByteLease } | null {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new RangeError('Invalid alpha plane size');
    const bytes = width * height * 5;
    const lease: ByteLease | null = allocator.reserve(bytes);
    if (!lease) return null;
    try {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Alpha readback context is unavailable');
        context.drawImage(source, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        const alpha = new Uint8Array(width * height);
        for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
        return { plane: { width, height, alpha }, lease };
    } catch (error) { allocator.release(lease); throw error; }
}
