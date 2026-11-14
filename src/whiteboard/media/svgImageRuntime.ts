// Executed only in the separate opaque image profile with img-src blob: and
// network, fonts, frames and connections denied. The image never enters the DOM.
export async function probeSvgInIsolatedRealm(blob: Blob, size: unknown): Promise<boolean> {
    if (!size || typeof size !== 'object') throw new Error('Missing SVG dimensions');
    const { width, height } = size as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > (2 ** 26) / height) throw new Error('Invalid SVG dimensions');
    const url = URL.createObjectURL(blob.slice(0, blob.size, 'image/svg+xml'));
    const image = new Image();
    try {
        image.src = url;
        await image.decode();
        if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('SVG dimensions do not match its header');
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('SVG rasterization is unavailable');
        context.drawImage(image, 0, 0, 1, 1);
        context.getImageData(0, 0, 1, 1);
        return true;
    } finally {
        image.removeAttribute('src');
        URL.revokeObjectURL(url);
    }
}
