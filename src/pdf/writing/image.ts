const MAX_PIXELS = 32 * 1024 * 1024;

export interface PdfImageData {
    width: number;
    height: number;
    color: Uint8Array;
    filter: 'DCTDecode' | 'FlateDecode';
    colorSpace: 'DeviceRGB' | 'DeviceGray';
    alpha?: Uint8Array;
}

function dimensions(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): { width: number; height: number; components?: number; icc?: boolean } {
    if (mime === 'image/png') {
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        if (bytes.length < 24 || signature.some((n, i) => bytes[i] !== n) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw new Error('Invalid PNG image');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Invalid JPEG image');
    let at = 2, icc = false;
    let frame: { width: number; height: number; components: number } | undefined;
    while (at + 3 < bytes.length) {
        if (bytes[at++] !== 0xff) throw new Error('Invalid JPEG segment');
        while (bytes[at] === 0xff) at++;
        const marker = bytes[at++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (at + 2 > bytes.length) break;
        const length = bytes[at] * 256 + bytes[at + 1];
        if (length < 2 || at + length > bytes.length) throw new Error('Invalid JPEG segment length');
        if (marker === 0xe2 && length >= 14 && String.fromCharCode(...bytes.subarray(at + 2, at + 13)) === 'ICC_PROFILE') icc = true;
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            if (length < 8 || bytes[at + 2] !== 8) throw new Error('Unsupported JPEG precision');
            frame = { height: bytes[at + 3] * 256 + bytes[at + 4], width: bytes[at + 5] * 256 + bytes[at + 6], components: bytes[at + 7] };
        }
        at += length;
    }
    if (!frame) throw new Error('Unsupported JPEG frame');
    return { ...frame, icc };
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
    const copy = new Uint8Array(bytes);
    const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reject dimensions before asking the browser decoder to allocate a bitmap. */
export async function normalizeImage(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): Promise<PdfImageData> {
    const info = dimensions(bytes, mime);
    const { width, height } = info;
    if (!width || !height || width * height > MAX_PIXELS) throw new RangeError('Image exceeds the 32 megapixel export limit');
    if (mime === 'image/jpeg' && !info.icc && (info.components === 1 || info.components === 3)) {
        return { width, height, color: bytes, filter: 'DCTDecode', colorSpace: info.components === 1 ? 'DeviceGray' : 'DeviceRGB' };
    }
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }), { imageOrientation: 'none', colorSpaceConversion: 'default' });
    try {
        if (bitmap.width !== width || bitmap.height !== height) throw new Error('Decoded image dimensions differ from its header');
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Image decoder is unavailable');
        context.drawImage(bitmap, 0, 0);
        const rgba = context.getImageData(0, 0, width, height).data;
        const rgb = new Uint8Array(width * height * 3), alpha = new Uint8Array(width * height);
        let hasAlpha = false;
        for (let i = 0, p = 0; i < alpha.length; i++, p += 4) {
            rgb[i * 3] = rgba[p]; rgb[i * 3 + 1] = rgba[p + 1]; rgb[i * 3 + 2] = rgba[p + 2];
            alpha[i] = rgba[p + 3]; if (alpha[i] !== 255) hasAlpha = true;
        }
        return { width, height, color: await deflate(rgb), filter: 'FlateDecode', colorSpace: 'DeviceRGB', ...(hasAlpha ? { alpha: await deflate(alpha) } : {}) };
    } finally { bitmap.close(); }
}
