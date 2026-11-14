import type { WorkerContext } from '../../platform/workers/serve';
import { alphaRunSteps } from '../render/alphaMask';

/** One owned source: an ImageBitmap copy the producer transferred here, or the PNG bytes of a raster fallback tile. */
export interface AlphaTraceRequest {
    readonly bitmap?: ImageBitmap;
    readonly png?: Uint8Array;
    /** True when full opacity makes alpha 255 occlude exactly; false when an inherited alpha below 1 makes every pixel partial. */
    readonly opaqueAlpha: boolean;
    readonly maxRects: number;
}
export interface AlphaTraceReply {
    readonly width: number;
    readonly height: number;
    /** Flat [x0, y0, x1, y1] rectangles of fully opaque pixels; null when the budget was exceeded. */
    readonly opaque: number[] | null;
    /** Flat [x0, y0, x1, y1] rectangles of nonzero, non-occluding pixels; null when the budget was exceeded. */
    readonly partial: number[] | null;
}

const MAX_RECTS = 1 << 20;

async function drain(steps: Generator<void, number[] | null, void>, context: WorkerContext): Promise<number[] | null> {
    for (;;) {
        if (context.cancelled) throw new DOMException('Alpha trace cancelled', 'AbortError');
        context.signal.throwIfAborted();
        const next = steps.next();
        if (next.done) return next.value;
        await context.slice();
    }
}

async function decodeOwnedPng(png: Uint8Array | undefined): Promise<ImageBitmap> {
    if (!png) throw new TypeError('Alpha trace needs a source');
    // The tile's bytes are already charged as part of the raster tile; slice() gives the Blob an exactly typed buffer.
    return createImageBitmap(new Blob([png.slice()], { type: 'image/png' }));
}

/** Reads the alpha of an owned source inside the worker and traces it. Only the worker's own copy is closed here. */
export async function alphaTrace(args: unknown, context: WorkerContext): Promise<AlphaTraceReply> {
    const request = args as AlphaTraceRequest | null;
    if (!request || typeof request.opaqueAlpha !== 'boolean' || !Number.isSafeInteger(request.maxRects)
        || request.maxRects < 1 || request.maxRects > MAX_RECTS) throw new TypeError('Invalid alpha trace request');
    if ((request.bitmap === undefined) === (request.png === undefined)) throw new TypeError('Alpha trace needs exactly one source');
    const bitmap = request.bitmap ?? await decodeOwnedPng(request.png);
    try {
        const { width, height } = bitmap;
        if (!Number.isSafeInteger(width * height) || width < 1 || height < 1) throw new RangeError('Alpha trace source is empty');
        const canvas = new OffscreenCanvas(width, height), draw = canvas.getContext('2d', { willReadFrequently: true });
        if (!draw) throw new Error('Alpha canvas is unavailable');
        let alpha: Uint8Array;
        try {
            draw.drawImage(bitmap, 0, 0);
            const data = draw.getImageData(0, 0, width, height).data;
            alpha = new Uint8Array(width * height);
            for (let index = 0; index < alpha.length; index++) {
                alpha[index] = data[index * 4 + 3];
                if (index % 65536 === 65535) await context.slice();
            }
        } finally { canvas.width = 0; canvas.height = 0; }
        const mask = { width, height, alpha };
        const opaqueTable = new Uint8Array(256), partialTable = new Uint8Array(256);
        for (let value = 1; value < 256; value++) partialTable[value] = request.opaqueAlpha && value === 255 ? 0 : 1;
        if (request.opaqueAlpha) opaqueTable[255] = 1;
        const opaque = await drain(alphaRunSteps(mask, opaqueTable, request.maxRects), context);
        const partial = await drain(alphaRunSteps(mask, partialTable, request.maxRects), context);
        return { width, height, opaque, partial };
    } finally { bitmap.close(); }
}
