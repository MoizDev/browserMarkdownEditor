import { serve } from '../../platform/workers/serve';
import { gifHeader, jpegHeader, pngHeader, webpHeader } from './headers';
import { isoHeader } from './isoHeaders';
import { hashMedia } from './sha256';
import { sniffMedia } from './sniff';
import { webmHeader } from './webmHeader';

serve({
    protocol: 1,
    buildId: 'whiteboard-media-1',
    handlers: {
        async hash(args, context) {
            if (!args || typeof args !== 'object' || !((args as { blob?: unknown }).blob instanceof Blob)) throw new Error('Invalid media request');
            const blob = (args as { blob: Blob }).blob;
            if (blob.size > 10 * 1024 * 1024) throw new RangeError('Media files must be at most 10 MiB');
            return hashMedia(blob, undefined, () => context.slice());
        },
        async probe(args, context) {
            if (!args || typeof args !== 'object' || !((args as { blob?: unknown }).blob instanceof Blob)) throw new Error('Invalid media request');
            const { blob, width, height } = args as { blob: Blob; width: number; height: number };
            const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'premultiply' });
            try {
                if (bitmap.width !== width || bitmap.height !== height) throw new Error('Picture dimensions do not match header');
                await context.slice();
                return true;
            } finally { bitmap.close(); }
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
            return { id, mime, width: header.width, height: header.height, animated: header.animated };
        },
    },
});
