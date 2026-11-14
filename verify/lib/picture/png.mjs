import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function decodePng(bytes) {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Picture input is not a PNG');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    // A malformed artifact must not allocate the shared machine's memory before it can be
    // reported. Oversized captures are a harness fault, never a comparison pass or a crop.
    if (!width || !height || width * height > 2 ** 24) {
        throw new Error(`Picture exceeds the 2^24-pixel decoder limit: ${width}x${height}`);
    }
    return PNG.sync.read(bytes, { checkCRC: true });
}

export async function writePng(path, image) {
    const bytes = PNG.sync.write(image, { colorType: 6, inputColorType: 6 });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    return { path, sha256: sha256(bytes), bytes: bytes.length };
}

export function differenceImage(expected, actual) {
    const unionWidth = Math.max(expected.width, actual.width);
    const unionHeight = Math.max(expected.height, actual.height);
    const bounded = unionWidth * unionHeight <= 2 ** 24;
    const width = bounded ? unionWidth : expected.width;
    const height = bounded ? unionHeight : expected.height;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const target = (y * width + x) * 4;
            const presentA = x < expected.width && y < expected.height;
            const presentB = x < actual.width && y < actual.height;
            data[target + 3] = 255;
            if (!presentA || !presentB) {
                data[target] = presentA ? 255 : presentB ? 0 : 32;
                data[target + 1] = presentA ? 0 : presentB ? 255 : 32;
                data[target + 2] = presentA || presentB ? 255 : 32;
                continue;
            }
            const a = (y * expected.width + x) * 4;
            const b = (y * actual.width + x) * 4;
            let delta = 0;
            for (let channel = 0; channel < 4; channel++) {
                delta = Math.max(delta, Math.abs(expected.data[a + channel] - actual.data[b + channel]));
            }
            const grey = Math.round((expected.data[a] + expected.data[a + 1] + expected.data[a + 2]) / 12);
            data[target] = delta ? 255 : grey;
            data[target + 1] = delta ? Math.max(0, 220 - delta * 8) : grey;
            data[target + 2] = delta ? 0 : grey;
        }
    }
    return { width, height, data, canvasScope: bounded ? 'union of both captures' : 'expected-size diff; incompatible aspect ratios exceed the allocation limit; full actual/expected PNGs accompany it' };
}
