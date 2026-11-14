import type { PdfPageBitmapOptions, PdfPoolDocument } from './types';

let nextRequest = 1;

/** Compose exact-scale tile interiors; the one-pixel apron is never drawn twice. */
export async function renderPdfPageBitmap(document: PdfPoolDocument, page: number, scale: number,
    options: PdfPageBitmapOptions): Promise<ImageBitmap> {
    options.signal?.throwIfAborted();
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Invalid PDF capture scale');
    const geometry = document.geometry(page), width = Math.ceil(geometry.width * scale), height = Math.ceil(geometry.height * scale);
    const maximum = options.maxPixels ?? 16_777_216;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        !Number.isSafeInteger(maximum) || maximum < 1 || width * height > maximum) throw new RangeError('PDF capture exceeds its pixel limit');
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
    if (!context) throw new Error('PDF capture canvas is unavailable');
    const variant = options.variant === 'emphasis'
        ? { variant: 'emphasis' as const, emphasis: options.emphasis, profileKey: options.profileKey }
        : { variant: 'plain' as const, profileKey: options.profileKey };
    for (let y = 0; y < height; y += 1024) for (let x = 0; x < width; x += 1024) {
        options.signal?.throwIfAborted();
        const w = Math.min(1024, width - x), h = Math.min(1024, height - y);
        const result = await document.tile({ page, scale, rect: { x, y, w, h }, reqId: nextRequest++,
            annotations: options.annotations ?? true, forms: options.forms ?? true, ...variant }, options);
        let bitmap: ImageBitmap | undefined;
        try {
            const pixels = new Uint8ClampedArray(result.pixels);
            bitmap = await createImageBitmap(new ImageData(pixels, result.w, result.h));
            options.signal?.throwIfAborted();
            context.drawImage(bitmap, 1, 1, w, h, x, y, w, h);
        } finally { bitmap?.close(); document.releaseTile(result); }
    }
    options.signal?.throwIfAborted();
    return canvas.transferToImageBitmap();
}
