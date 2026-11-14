// Executed only in the separate opaque image profile with img-src blob: and
// network, fonts, frames and connections denied. The image never enters the DOM.
export async function probeSvgInIsolatedRealm(blob: Blob, size: unknown): Promise<boolean | ImageBitmap> {
    if (!size || typeof size !== 'object') throw new Error('Missing SVG dimensions');
    const { width, height, raster } = size as { width?: unknown; height?: unknown; raster?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > (2 ** 26) / height) throw new Error('Invalid SVG dimensions');
    const url = URL.createObjectURL(blob.slice(0, blob.size, 'image/svg+xml'));
    const image = new Image();
    try {
        image.src = url;
        await image.decode();
        if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('SVG dimensions do not match its header');
        if (raster === undefined) {
            const canvas = new OffscreenCanvas(1, 1);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('SVG rasterization is unavailable');
            context.drawImage(image, 0, 0, 1, 1);
            context.getImageData(0, 0, 1, 1);
            return true;
        }
        if (!raster || typeof raster !== 'object') throw new Error('Invalid SVG raster');
        const region = raster as { sourceX?: unknown; sourceY?: unknown; sourceWidth?: unknown; sourceHeight?: unknown; width?: unknown; height?: unknown };
        const values = [region.sourceX, region.sourceY, region.sourceWidth, region.sourceHeight, region.width, region.height];
        if (!values.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid SVG raster');
        const { sourceX, sourceY, sourceWidth, sourceHeight, width: outWidth, height: outHeight } = region as {
            sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number; width: number; height: number };
        if (!sourceWidth || !sourceHeight || !outWidth || !outHeight || outWidth > 4096 || outHeight > 4096
            || sourceX > width - sourceWidth || sourceY > height - sourceHeight) throw new Error('Invalid SVG raster');
        const canvas = new OffscreenCanvas(outWidth, outHeight);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('SVG rasterization is unavailable');
        context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outWidth, outHeight);
        context.getImageData(0, 0, 1, 1);
        return canvas.transferToImageBitmap();
    } finally {
        image.removeAttribute('src');
        URL.revokeObjectURL(url);
    }
}
