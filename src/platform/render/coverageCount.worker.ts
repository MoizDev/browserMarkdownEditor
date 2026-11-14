import { serve } from '../workers/serve';
import type { FrameToken } from './types';

interface CoverageFrame {
    readonly frameId: number;
    readonly token: FrameToken;
    readonly cameraEpoch: number;
}

function frameTag(value: unknown): CoverageFrame {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid coverage frame');
    const frame = value as Record<string, unknown>;
    if (!frame.token || typeof frame.token !== 'object') throw new TypeError('Invalid coverage token');
    const token = frame.token as Record<string, unknown>;
    const nonnegative = (number: unknown): number => {
        if (!Number.isSafeInteger(number) || (number as number) < 0) throw new TypeError('Invalid coverage frame number');
        return number as number;
    };
    if (typeof token.documentId !== 'string') throw new TypeError('Invalid coverage document');
    return { frameId: nonnegative(frame.frameId), cameraEpoch: nonnegative(frame.cameraEpoch), token: {
        vaultEpoch: nonnegative(token.vaultEpoch), documentId: token.documentId,
        bytesGeneration: nonnegative(token.bytesGeneration), session: nonnegative(token.session),
        viewLease: nonnegative(token.viewLease), deviceGeneration: nonnegative(token.deviceGeneration),
    } };
}

// This entry is never imported by production code; the build guard also removes its endpoint.
if (__BME_BENCH__) serve({
    protocol: 1,
    buildId: 'coverage-count-1',
    handlers: {
        async count(args, context) {
            if (!args || typeof args !== 'object') throw new TypeError('Invalid coverage request');
            const request = args as Record<string, unknown>;
            if (!(request.bitmap instanceof ImageBitmap)) throw new TypeError('Coverage requires a bitmap');
            const bitmap = request.bitmap;
            let canvas: OffscreenCanvas | null = null;
            try {
                const frame = frameTag(request.frame);
                const width = bitmap.width, height = bitmap.height, pixels = width * height;
                if (!width || !height || !Number.isSafeInteger(pixels * 16)) throw new RangeError('Invalid coverage bitmap size');
                canvas = new OffscreenCanvas(width, height);
                const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
                if (!ctx || ctx.isContextLost()) throw new Error('Coverage canvas unavailable');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(bitmap, 0, 0);
                if (ctx.isContextLost()) throw new Error('Coverage canvas lost');
                const data = ctx.getImageData(0, 0, width, height).data;
                if (ctx.isContextLost()) throw new Error('Coverage canvas lost');
                let outside = 0, hole = 0, standin = 0, current = 0, invalid = 0;
                for (let i = 0; i < data.length; i += 4) {
                    switch (data[i]) {
                        case 0: outside++; break;
                        case 1: hole++; break;
                        case 2: standin++; break;
                        case 3: current++; break;
                        default: invalid++; break;
                    }
                    if (i && i % (65536 * 4) === 0) await context.slice();
                }
                // Nominal canvas reserve (12 B/px) plus ImageData (4 B/px); the caller accounts for the transferred source.
                return { frame, outside, hole, standin, current, invalid, pixels, ownedScratchBytes: pixels * 16 };
            } finally {
                bitmap.close();
                if (canvas) { canvas.width = 0; canvas.height = 0; }
            }
        },
    },
});
