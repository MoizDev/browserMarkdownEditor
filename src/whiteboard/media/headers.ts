export interface RasterHeader { readonly width: number; readonly height: number; readonly animated: boolean; readonly decodePixels?: number }
const LIMIT = 2 ** 26;

function dimensions(width: number, height: number, animated = false): RasterHeader {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > LIMIT / height) {
        throw new RangeError('Invalid or oversized media dimensions');
    }
    return { width, height, animated };
}
const fourcc = (bytes: Uint8Array, offset: number, name: string): boolean => {
    if (offset < 0 || offset + name.length > bytes.length) return false;
    for (let i = 0; i < name.length; i++) if (bytes[offset + i] !== name.charCodeAt(i)) return false;
    return true;
};

export function pngHeader(bytes: Uint8Array): RasterHeader {
    if (bytes.length < 33 || !fourcc(bytes, 1, 'PNG\r\n\x1a\n') || bytes[0] !== 0x89) throw new Error('Invalid PNG');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13 || !fourcc(bytes, 12, 'IHDR')) throw new Error('Invalid PNG header');
    const size = dimensions(view.getUint32(16), view.getUint32(20));
    let animated = false, ended = false;
    for (let pos = 8; pos + 12 <= bytes.length;) {
        const length = view.getUint32(pos);
        if (length > bytes.length - pos - 12) throw new Error('Truncated PNG chunk');
        if (fourcc(bytes, pos + 4, 'acTL')) animated = true;
        if (fourcc(bytes, pos + 4, 'fcTL')) {
            if (length !== 26) throw new Error('Invalid APNG frame');
            const width = view.getUint32(pos + 12), height = view.getUint32(pos + 16);
            const x = view.getUint32(pos + 20), y = view.getUint32(pos + 24);
            dimensions(width, height);
            if (x > size.width - width || y > size.height - height) throw new Error('APNG frame exceeds canvas');
        }
        if (fourcc(bytes, pos + 4, 'IEND')) { ended = true; break; }
        pos += length + 12;
    }
    if (!ended) throw new Error('Truncated PNG');
    return { ...size, animated };
}

export function jpegHeader(bytes: Uint8Array): RasterHeader {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Invalid JPEG');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let orientation = 1, size: RasterHeader | undefined;
    for (let pos = 2; pos < bytes.length;) {
        if (bytes[pos++] !== 0xff) throw new Error('Invalid JPEG marker');
        while (pos < bytes.length && bytes[pos] === 0xff) pos++;
        const marker = bytes[pos++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (pos + 2 > bytes.length) throw new Error('Truncated JPEG segment');
        const length = view.getUint16(pos);
        if (length < 2 || length > bytes.length - pos) throw new Error('Truncated JPEG segment');
        if (marker === 0xe1 && length >= 16 && fourcc(bytes, pos + 2, 'Exif\0\0')) {
            const tiff = pos + 8, end = pos + length;
            const little = fourcc(bytes, tiff, 'II');
            if ((little || fourcc(bytes, tiff, 'MM')) && view.getUint16(tiff + 2, little) === 42) {
                const dir = tiff + view.getUint32(tiff + 4, little);
                if (dir + 2 <= end) {
                    const count = view.getUint16(dir, little);
                    for (let i = 0; i < count && dir + 2 + (i + 1) * 12 <= end; i++) {
                        const e = dir + 2 + i * 12;
                        if (view.getUint16(e, little) === 0x112 && view.getUint16(e + 2, little) === 3 && view.getUint32(e + 4, little) === 1) {
                            orientation = view.getUint16(e + 8, little);
                            break;
                        }
                    }
                }
            }
        }
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
            if (length < 8) throw new Error('Invalid JPEG frame');
            size = dimensions(view.getUint16(pos + 5), view.getUint16(pos + 3));
        }
        pos += length;
    }
    if (!size) throw new Error('Missing JPEG dimensions');
    return orientation >= 5 && orientation <= 8 ? dimensions(size.height, size.width) : size;
}

export function gifHeader(bytes: Uint8Array): RasterHeader {
    if (bytes.length < 13 || !(fourcc(bytes, 0, 'GIF87a') || fourcc(bytes, 0, 'GIF89a'))) throw new Error('Invalid GIF');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = dimensions(view.getUint16(6, true), view.getUint16(8, true));
    let pos = 13 + (bytes[10] & 0x80 ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), frames = 0, ended = false;
    const blocks = (): void => {
        for (;;) {
            if (pos >= bytes.length) throw new Error('Truncated GIF block');
            const n = bytes[pos++];
            if (n === 0) break;
            if (n > bytes.length - pos) throw new Error('Truncated GIF block');
            pos += n;
        }
    };
    while (pos < bytes.length) {
        const marker = bytes[pos++];
        if (marker === 0x3b) { ended = true; break; }
        if (marker === 0x21) {
            if (pos >= bytes.length) throw new Error('Truncated GIF extension');
            pos++;
            blocks();
        } else if (marker === 0x2c) {
            if (pos + 9 > bytes.length) throw new Error('Truncated GIF frame');
            const x = view.getUint16(pos, true), y = view.getUint16(pos + 2, true);
            const width = view.getUint16(pos + 4, true), height = view.getUint16(pos + 6, true);
            dimensions(width, height);
            if (x > size.width - width || y > size.height - height) throw new Error('GIF frame exceeds canvas');
            const packed = bytes[pos + 8];
            pos += 9 + (packed & 0x80 ? 3 * (2 ** ((packed & 7) + 1)) : 0);
            if (pos >= bytes.length) throw new Error('Truncated GIF image');
            pos++;
            blocks();
            frames++;
        } else throw new Error('Invalid GIF block');
    }
    if (!ended || !frames) throw new Error('Truncated GIF');
    return { ...size, animated: frames > 1 };
}

export function webpHeader(bytes: Uint8Array): RasterHeader {
    if (bytes.length < 20 || !fourcc(bytes, 0, 'RIFF') || !fourcc(bytes, 8, 'WEBP')) throw new Error('Invalid WebP');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = view.getUint32(4, true) + 8;
    if (end > bytes.length || end < 20) throw new Error('Truncated WebP');
    const u24 = (pos: number): number => bytes[pos] + bytes[pos + 1] * 256 + bytes[pos + 2] * 65536;
    const frameSize = (pos: number, data: number, n: number): RasterHeader | null => {
        if (fourcc(bytes, pos, 'VP8 ')) {
            if (n < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) throw new Error('Invalid WebP frame');
            return dimensions(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff);
        }
        if (fourcc(bytes, pos, 'VP8L')) {
            if (n < 5 || bytes[data] !== 0x2f) throw new Error('Invalid WebP frame');
            const bits = view.getUint32(data + 1, true);
            return dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
        }
        return null;
    };
    let size: RasterHeader | undefined;
    let animated = false;
    for (let pos = 12; pos + 8 <= end;) {
        const n = view.getUint32(pos + 4, true), data = pos + 8;
        if (n > end - data || n + (n & 1) > end - data) throw new Error('Truncated WebP chunk');
        if (fourcc(bytes, pos, 'VP8X')) {
            if (n !== 10) throw new Error('Invalid WebP canvas');
            size = dimensions(1 + u24(data + 4), 1 + u24(data + 7));
            animated = !!(bytes[data] & 2);
        } else if (fourcc(bytes, pos, 'VP8 ') || fourcc(bytes, pos, 'VP8L')) {
            const frame = frameSize(pos, data, n)!;
            if (size && (frame.width !== size.width || frame.height !== size.height)) throw new Error('WebP frame differs from canvas');
            size ??= frame;
        } else if (fourcc(bytes, pos, 'ANMF')) {
            if (n < 16 || !size) throw new Error('Invalid WebP animation');
            const x = u24(data) * 2, y = u24(data + 3) * 2;
            const width = u24(data + 6) + 1, height = u24(data + 9) + 1;
            dimensions(width, height);
            if (x > size.width - width || y > size.height - height) throw new Error('WebP frame exceeds canvas');
            let found = false;
            for (let sub = data + 16; sub < data + n;) {
                if (sub + 8 > data + n) throw new Error('Truncated WebP frame chunk');
                const length = view.getUint32(sub + 4, true), body = sub + 8;
                if (length + (length & 1) > data + n - body) throw new Error('Truncated WebP frame chunk');
                const inner = frameSize(sub, body, length);
                if (inner) {
                    if (found || inner.width !== width || inner.height !== height) throw new Error('Invalid WebP frame dimensions');
                    found = true;
                }
                sub = body + length + (length & 1);
            }
            if (!found) throw new Error('Missing WebP frame data');
        }
        pos = data + n + (n & 1);
    }
    if (!size) throw new Error('Missing WebP dimensions');
    return { ...size, animated };
}
