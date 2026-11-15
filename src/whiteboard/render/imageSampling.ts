import type { Rect } from '../../platform/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { ByteLease } from '../../platform/render/gfx/api';

/** The one image sampling profile. GPU: a linear sampler on the full backing texture, drawn onto
 * the destination grown by its gutter, so every sample has real neighbour texels. CPU reference:
 * drawImage with smoothing enabled at 'low' quality, which is bilinear without mip levels. A
 * sample's footprint is the set of texels with POSITIVE bilinear weight; nothing else contributes. */
export const IMAGE_SAMPLING_PROFILE = Object.freeze({ kernel: 'bilinear', mips: 'none', quality: 'low' } as const);

/** Device pixels, half-open: a pixel belongs when its centre lies inside. */
export interface DeviceRect { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/** Alpha of a backing bitmap, read back once from the exact accepted source. */
export interface AlphaPlane { readonly width: number; readonly height: number; readonly alpha: Uint8Array }

export interface FootprintInput {
    readonly plane: AlphaPlane;
    /** Texels of the backing that the quad maps onto (the full texture, or a crop). */
    readonly window: Readonly<Rect>;
    /** Device rectangle that receives `window`, exactly as the draw places it. */
    readonly quad: DeviceRect;
    /** Optional device restriction, e.g. the live embed's clipped region; pixels outside are ignored. */
    readonly within?: DeviceRect;
    readonly maxRuns: number;
}

export type FootprintFacts =
    | { readonly status: 'translucent' }
    /** Opaque pixels as runs of (x, y, width, 1) in device pixels, flattened four numbers per run. */
    | { readonly status: 'opaque'; readonly runs: Int32Array }
    | { readonly status: 'unavailable'; readonly reason: string };

const MAX_PIXELS = 4 * 1024 * 1024;

const clampTexel = (index: number, size: number) => index < 0 ? 0 : index >= size ? size - 1 : index;

/** Classifies every device pixel the quad covers by its real positive-weight texel footprint:
 * all footprint texels 255 → opaque; all 0 → nothing; any other mix → translucent. The result is
 * the exact alpha of the sampled backing, not a bounding box, and it is decided on the same
 * mapping the GPU draw uses, so CPU and GPU agree on which texels a pixel reads. */
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

/** Device rectangle of a textured draw whose crop leaves a symmetric gutter inside the texture. The
 * draw grows `dest` by the gutter scaled to device size, as the production GPU quad does. */
export function texturedQuad(dest: Readonly<Rect>, textureSize: number, crop: Readonly<Rect>): DeviceRect {
    const gutter = crop.x;
    if (crop.y !== gutter || crop.width !== crop.height || crop.x + crop.width + gutter !== textureSize || gutter < 0
        || !(dest.width > 0) || !Number.isFinite(dest.x) || !Number.isFinite(dest.y)) throw new RangeError('Unsupported textured quad crop');
    const apron = gutter * dest.width / crop.width;
    return { x0: dest.x - apron, y0: dest.y - apron, x1: dest.x + dest.width + apron, y1: dest.y + dest.height + apron };
}

/** Reads the exact alpha of a source bitmap through a 2D canvas. The bytes are charged to the CPU
 * allocator before they exist; the caller owns the returned lease and releases it with its holds. A
 * denied reservation returns null (facts stay unavailable). */
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
