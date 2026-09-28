// Pasted, dropped and attached pictures, made ready to send.
//
// Every image is decoded and re-encoded through a canvas, never passed on as
// the bytes it arrived with:
//   · re-encoding drops EXIF — a phone photo's GPS position and camera serial
//     would otherwise go to the model provider with it;
//   · anything Chrome can decode (BMP, AVIF, an ICO, …) comes out as one of the
//     four types every agent accepts;
//   · the long side is capped, since models downscale past ~1.5k px anyway and
//     a 12 MP screenshot would only cost upload time and tokens.

import { MAX_IMAGE_BYTES } from '../../../shared/vaultAgentProtocol';
import type { PreparedImage } from './chatStore';

/** Past this long side the models see no more detail, only more tokens. */
const MAX_LONG_SIDE = 2048;
/** Decoding a huge file just to reject it afterwards would stall the tab. */
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
const JPEG_QUALITY = 0.9;

export class ImagePrepError extends Error {}

/** Whether a dropped/pasted file is worth trying at all. */
export function looksLikeImage(file: File): boolean {
    return file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}

function base64Of(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export async function prepareImage(file: File): Promise<PreparedImage> {
    const name = file.name || 'Pasted image';
    if (!looksLikeImage(file)) throw new ImagePrepError(`${name} isn't an image.`);
    if (file.size > MAX_INPUT_BYTES) throw new ImagePrepError(`${name} is too large.`);

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new ImagePrepError(`${name} couldn't be read as an image.`);
    }
    try {
        const scale = Math.min(1, MAX_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new ImagePrepError(`${name} couldn't be processed.`);
        ctx.drawImage(bitmap, 0, 0, width, height);
        // A photo stays a JPEG (a PNG of one is several times larger);
        // everything else — screenshots, diagrams, anything with alpha — PNG.
        const mimeType: PreparedImage['mimeType'] = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        let blob = await canvas.convertToBlob(mimeType === 'image/jpeg' ? { type: mimeType, quality: JPEG_QUALITY } : { type: mimeType });
        let finalType = mimeType;
        if (blob.size > MAX_IMAGE_BYTES && mimeType === 'image/png') {
            blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
            finalType = 'image/jpeg';
        }
        if (blob.size > MAX_IMAGE_BYTES) {
            throw new ImagePrepError(`${name} is larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB even after compressing.`);
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {
            id: crypto.randomUUID(),
            mimeType: finalType,
            data: base64Of(bytes),
            url: URL.createObjectURL(blob),
            name,
            bytes: blob.size,
        };
    } finally {
        bitmap.close();
    }
}
