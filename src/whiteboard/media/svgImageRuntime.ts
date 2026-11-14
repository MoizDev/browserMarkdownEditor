// Executed only in the separate opaque image profile with img-src blob: and
// network, fonts, frames and connections denied. The image never enters the DOM.
export async function probeSvgInIsolatedRealm(blob: Blob): Promise<boolean> {
    const url = URL.createObjectURL(blob.slice(0, blob.size, 'image/svg+xml'));
    const image = new Image();
    try {
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > (2 ** 26) / image.naturalHeight) throw new Error('Invalid SVG dimensions');
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
