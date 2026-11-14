import { serve } from '../../platform/workers/serve';
import { gifHeader, jpegHeader, pngHeader, webpHeader } from './headers';
import { isoHeader } from './isoHeaders';
import { hashMedia } from './sha256';
import { sniffMedia } from './sniff';
import { webmHeader } from './webmHeader';
import { preflightSvgText } from './svgXmlRuntime';
import { boardHandlers } from '../workers/protocol';

interface DecoderTrack { readonly frameCount: number }
interface DecoderInstance {
    readonly tracks: { readonly ready: Promise<void>; readonly selectedTrack: DecoderTrack | null };
    readonly completed: Promise<void>;
    decode(options: { frameIndex: number }): Promise<{ image: ImageBitmapSource & { readonly duration?: number | null; close(): void } }>;
    close(): void;
}
type DecoderConstructor = new (options: { data: ReadableStream<Uint8Array>; type: string }) => DecoderInstance;

serve({
    protocol: 1,
    buildId: 'whiteboard-media-1',
    handlers: boardHandlers({
        async svgPreflight(args, context) {
            if (!args || typeof args !== 'object' || !((args as { blob?: unknown }).blob instanceof Blob)) throw new Error('Invalid SVG request');
            const blob = (args as { blob: Blob }).blob;
            if (blob.size > 5 * 1024 * 1024) throw new RangeError('SVG files must be at most 5 MiB');
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
            preflightSvgText(text);
            await context.slice();
            return true;
        },
        async hash(args, context) {
            if (!args || typeof args !== 'object' || !((args as { blob?: unknown }).blob instanceof Blob)) throw new Error('Invalid media request');
            const blob = (args as { blob: Blob }).blob;
            if (blob.size > 10 * 1024 * 1024) throw new RangeError('Media files must be at most 10 MiB');
            return hashMedia(blob, undefined, () => context.slice());
        },
        async probe(args, context) {
            if (!args || typeof args !== 'object' || !((args as { blob?: unknown }).blob instanceof Blob)) throw new Error('Invalid media request');
            const { blob, width, height, animated, mime } = args as { blob: Blob; width: number; height: number; animated: boolean; mime: string };
            const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'premultiply' });
            try {
                if (bitmap.width !== width || bitmap.height !== height) throw new Error('Picture dimensions do not match header');
                await context.slice();
            } finally { bitmap.close(); }
            if (animated) {
                const Decoder = (globalThis as unknown as { ImageDecoder?: DecoderConstructor }).ImageDecoder;
                if (!Decoder) throw new Error('Animated picture decoding is unavailable');
                const decoder = new Decoder({ data: blob.stream(), type: mime });
                try {
                    await decoder.tracks.ready;
                    await decoder.completed;
                    if (!decoder.tracks.selectedTrack || decoder.tracks.selectedTrack.frameCount < 1) throw new Error('Invalid animated picture');
                    const frame = await decoder.decode({ frameIndex: 0 });
                    frame.image.close();
                    await context.slice();
                } finally { decoder.close(); }
            }
            return true;
        },
        async raster(args, context) {
            if (!args || typeof args !== 'object') throw new Error('Invalid raster request');
            const value = args as { blob?: unknown; mime?: unknown; frame?: unknown; sourceWidth?: unknown; sourceHeight?: unknown;
                x?: unknown; y?: unknown; width?: unknown; height?: unknown; outputWidth?: unknown; outputHeight?: unknown; animated?: unknown };
            if (!(value.blob instanceof Blob) || typeof value.mime !== 'string' || typeof value.animated !== 'boolean') throw new Error('Invalid raster request');
            const numbers = [value.frame, value.sourceWidth, value.sourceHeight, value.x, value.y, value.width, value.height, value.outputWidth, value.outputHeight];
            if (!numbers.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid raster dimensions');
            const { frame, sourceWidth, sourceHeight, x, y, width, height, outputWidth, outputHeight } = value as {
                frame: number; sourceWidth: number; sourceHeight: number; x: number; y: number; width: number; height: number; outputWidth: number; outputHeight: number };
            if (!width || !height || !outputWidth || !outputHeight || sourceWidth > (2 ** 26) / sourceHeight
                || x > sourceWidth - width || y > sourceHeight - height || outputWidth > 4096 || outputHeight > 4096) throw new Error('Invalid raster dimensions');
            const options: ImageBitmapOptions = { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'premultiply',
                resizeWidth: outputWidth, resizeHeight: outputHeight, resizeQuality: 'high' };
            let bitmap: ImageBitmap, durationMs = 0, frameCount = 1;
            if (value.animated) {
                const Decoder = (globalThis as unknown as { ImageDecoder?: DecoderConstructor }).ImageDecoder;
                if (!Decoder) throw new Error('Animated picture decoding is unavailable');
                const decoder = new Decoder({ data: value.blob.stream(), type: value.mime });
                try {
                    await decoder.tracks.ready;
                    await decoder.completed;
                    const track = decoder.tracks.selectedTrack;
                    if (!track || frame >= track.frameCount) throw new Error('Invalid animation frame');
                    frameCount = track.frameCount;
                    const decoded = await decoder.decode({ frameIndex: frame });
                    durationMs = Math.max(10, (decoded.image.duration ?? 100000) / 1000);
                    try { bitmap = await createImageBitmap(decoded.image, x, y, width, height, options); }
                    finally { decoded.image.close(); }
                } finally { decoder.close(); }
            } else {
                if (frame !== 0) throw new Error('Invalid still picture frame');
                bitmap = await createImageBitmap(value.blob, x, y, width, height, options);
            }
            try {
                await context.slice();
                if (bitmap.width !== outputWidth || bitmap.height !== outputHeight) throw new Error('Unexpected raster size');
                context.transfer(bitmap);
                return { bitmap, durationMs, frameCount };
            } catch (error) { bitmap.close(); throw error; }
        },
        async inspect(args, context) {
            if (!args || typeof args !== 'object' || !(args as { blob?: unknown }).blob || !((args as { blob: unknown }).blob instanceof Blob)) {
                throw new Error('Invalid media request');
            }
            const blob = (args as { blob: Blob }).blob;
            if (blob.size > 10 * 1024 * 1024) throw new RangeError('Media files must be at most 10 MiB');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            await context.slice();
            const mime = sniffMedia(bytes);
            if (!mime) {
                const brand = new TextDecoder().decode(bytes.subarray(4, 32));
                if (/ftyp(?:heic|heix|hevc|hevx|mif1|msf1)/.test(brand)) throw new Error("HEIC pictures can't be placed on a board; export them as JPEG or PNG first");
                throw new Error('Unsupported media format');
            }
            if (mime === 'image/svg+xml') throw new Error('SVG requires the isolated decoder profile');
            const header = mime === 'image/png' ? pngHeader(bytes)
                : mime === 'image/jpeg' ? jpegHeader(bytes)
                    : mime === 'image/gif' ? gifHeader(bytes)
                        : mime === 'image/webp' ? webpHeader(bytes)
                            : mime === 'image/avif' ? isoHeader(bytes, 'avif')
                                : mime === 'video/webm' ? webmHeader(bytes) : isoHeader(bytes, 'video');
            await context.slice();
            const id = await hashMedia(blob, undefined, () => context.slice());
            await context.slice();
            return { id, mime, width: header.width, height: header.height, animated: header.animated,
                decodePixels: header.decodePixels ?? header.width * header.height };
        },
    }),
});
