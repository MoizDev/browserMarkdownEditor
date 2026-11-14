import type { Affine, PageDisplayItem, Rgba } from '../../platform/types';
import type { WorkerContext } from '../../platform/workers';
import type { BoardFonts } from './fonts';
import type { Face, PaintFragment } from './paint';
import { awaitOutlineResource } from './outlineAbort';

const TILE_SIDE = 1024;
function colorCss(color: Rgba): string {
    return `rgba(${color[0] * 255},${color[1] * 255},${color[2] * 255},${color[3]})`;
}
function configure(context: OffscreenCanvasRenderingContext2D, fragment: PaintFragment, face: Face): void {
    context.font = face.css;
    context.direction = fragment.rtl ? 'rtl' : 'ltr';
    context.textAlign = 'left'; context.textBaseline = 'alphabetic';
    context.fontKerning = 'normal'; context.textRendering = 'geometricPrecision';
    context.letterSpacing = '0px'; context.wordSpacing = '0px'; context.fontVariantCaps = 'normal';
}
function nonempty(data: Uint8ClampedArray): boolean {
    for (let index = 3; index < data.length; index += 4) if (data[index]) return true;
    return false;
}
function maxStretch(matrix: Affine): number {
    const scale = Math.max(Math.abs(matrix[0]), Math.abs(matrix[1]), Math.abs(matrix[2]), Math.abs(matrix[3]));
    if (!scale) return 0;
    const a = matrix[0] / scale, b = matrix[1] / scale, c = matrix[2] / scale, d = matrix[3] / scale;
    const x = a * a + b * b, y = c * c + d * d, cross = a * c + b * d;
    return scale * Math.sqrt((x + y + Math.hypot(x - y, 2 * cross)) / 2);
}

/** Each fallback bitmap stays small even when one source fragment spans a very wide page. */
export async function* rasterTextFragment(fragment: PaintFragment, face: Face, baseline: number, lineTop: number, lineBottom: number,
    localToWorld: Affine, color: Rgba, pageScale: number, blend: 'normal' | 'multiply', fonts: BoardFonts, context: WorkerContext): AsyncGenerator<PageDisplayItem> {
    context.signal.throwIfAborted();
    if (face.loaded && !await awaitOutlineResource(fonts.load(face.key), context.signal, 30_000, 'Export canvas font'))
        throw new Error('Export canvas font could not be loaded');
    context.signal.throwIfAborted();
    const probe = new OffscreenCanvas(1, 1), measuring = probe.getContext('2d');
    if (!measuring) throw new Error('Export canvas is unavailable');
    configure(measuring, fragment, face);
    const metrics = measuring.measureText(fragment.text), factor = face.size / 64, padding = factor * 2;
    const inkLeft = Math.min(fragment.x, fragment.x - metrics.actualBoundingBoxLeft * factor);
    const inkRight = Math.max(fragment.x + fragment.width, fragment.x + metrics.actualBoundingBoxRight * factor);
    const ascent = Math.max(0, metrics.actualBoundingBoxAscent * factor, face.ascent, baseline - lineTop);
    const descent = Math.max(0, metrics.actualBoundingBoxDescent * factor, face.descent, lineBottom - baseline);
    const left = inkLeft - padding, top = baseline - ascent - padding;
    const width = Math.max(factor, inkRight - inkLeft + 2 * padding), height = Math.max(factor, ascent + descent + 2 * padding);
    const stretch = maxStretch(localToWorld);
    if (stretch === 0) return;
    const density = 4 * pageScale * stretch, pixelWidth = Math.max(1, Math.ceil(width * density)), pixelHeight = Math.max(1, Math.ceil(height * density));
    if (![left, top, width, height, density].every(Number.isFinite) || !(factor > 0 && density > 0)
        || !Number.isSafeInteger(pixelWidth) || !Number.isSafeInteger(pixelHeight)) throw new RangeError('Text raster geometry is out of range');
    for (let py = 0; py < pixelHeight; py += TILE_SIDE) for (let px = 0; px < pixelWidth; px += TILE_SIDE) {
        context.signal.throwIfAborted();
        const tileWidth = Math.min(TILE_SIDE, pixelWidth - px), tileHeight = Math.min(TILE_SIDE, pixelHeight - py);
        const canvas = new OffscreenCanvas(tileWidth, tileHeight), draw = canvas.getContext('2d');
        if (!draw) throw new Error('Export canvas is unavailable');
        let item: PageDisplayItem | undefined;
        try {
            draw.scale(density, density);
            draw.translate(fragment.x - left - px / density, baseline - top - py / density);
            draw.scale(factor, factor);
            configure(draw, fragment, face);
            draw.fillStyle = colorCss(color);
            draw.fillText(fragment.text, 0, 0);
            context.signal.throwIfAborted();
            if (nonempty(draw.getImageData(0, 0, tileWidth, tileHeight).data)) {
                const blob = await awaitOutlineResource(canvas.convertToBlob({ type: 'image/png' }), context.signal, 30_000, 'Export bitmap encoding');
                const bytes = new Uint8Array(await awaitOutlineResource(blob.arrayBuffer(), context.signal, 30_000, 'Export bitmap read'));
                context.signal.throwIfAborted();
                item = { kind: 'raster', rect: { x: left + px / density, y: top + py / density,
                    width: tileWidth / density, height: tileHeight / density }, png: bytes, blend };
            }
        } finally { canvas.width = 0; canvas.height = 0; }
        if (item) yield item;
        await context.slice();
    }
}
