import { PdfEngineError } from '../types';
import type { EngineLimits, RenderJob, RenderRequest } from '../types';
import type { PageGeometry } from '../../../platform/types';
import type { PdfiumRuntime } from './loader';
import { heapView } from './memory';

// PDFium's tiled glyph raster can otherwise omit ink crossing a tile edge.
// The worker crops this internal bleed to the requested one-pixel apron.
const BLEED_LEFT = 64, BLEED_TOP = 32, BLEED_RIGHT = 16, BLEED_BOTTOM = 64;
const ANNOT = 0x01, REVERSE_BYTE_ORDER = 0x10, BITMAP_BGRA = 4;
const CONTINUE = 1, DONE = 2;

export function createPdfiumRenderJob(runtime: PdfiumRuntime, page: number, form: number,
    geometry: PageGeometry, request: RenderRequest, limits: Readonly<EngineLimits>, onRelease: () => void): RenderJob {
    const { x, y, w, h } = request.rect;
    if (![x, y, w, h].every(Number.isSafeInteger) || w <= 0 || h <= 0 ||
        w + 2 > limits.maxTileEdge || h + 2 > limits.maxTileEdge ||
        !Number.isFinite(request.scale) || request.scale <= 0) throw new PdfEngineError('RangeError', 'Invalid PDF tile geometry');
    const outW = w + 2, outH = h + 2, originX = x - 1, originY = y - 1;
    const pageW = Math.round(geometry.width * request.scale), pageH = Math.round(geometry.height * request.scale);
    const bufferW = outW + BLEED_LEFT + BLEED_RIGHT, bufferH = outH + BLEED_TOP + BLEED_BOTTOM;
    const bufferX = originX - BLEED_LEFT, bufferY = originY - BLEED_TOP, stride = bufferW * 4;
    const outputBytes = outW * outH * 4, bufferBytes = stride * bufferH;
    if (![pageW, pageH, bufferX, bufferY, bufferBytes].every(Number.isSafeInteger) || pageW <= 0 || pageH <= 0 ||
        pageW > 0x7fffffff || pageH > 0x7fffffff || bufferX < -0x7fffffff || bufferX > 0x7fffffff ||
        bufferY < -0x7fffffff || bufferY > 0x7fffffff || outputBytes > limits.maxTileBytes || bufferBytes > 0xffffffff) {
        throw new PdfEngineError('ResourceLimit', 'PDF tile exceeds the supported render range');
    }
    let pixels = 0, pause = 0, callback = 0, bitmap = 0;
    let deadline = 0, started = false, renderClosed = false, finished = false, released = false;
    const flags = (request.annotations ? ANNOT : 0) | REVERSE_BYTE_ORDER;
    const release = () => {
        if (released) return;
        released = true;
        if (started && !renderClosed && !runtime.aborted) {
            try { runtime.call('FPDF_RenderPage_Close', page); } catch { /* Continue releasing owned resources. */ }
            renderClosed = true;
        }
        if (bitmap && !runtime.aborted) { try { runtime.call('FPDFBitmap_Destroy', bitmap); } catch { /* Worker is unusable. */ } }
        if (callback) runtime.removeFunction(callback);
        if (pause) { try { runtime.free(pause); } catch { /* Worker is unusable. */ } }
        if (pixels) { try { runtime.free(pixels); } catch { /* Worker is unusable. */ } }
        onRelease();
    };
    try {
        pixels = runtime.malloc(bufferBytes);
        pause = runtime.malloc(runtime.abi.structs.pause.size);
        callback = runtime.addFunction(() => performance.now() >= deadline ? 1 : 0, 'ii');
        const pauseLayout = runtime.abi.structs.pause;
        const view = heapView(runtime, pause, pauseLayout.size);
        view.setInt32(pauseLayout.offsets.version, 1, true);
        view.setUint32(pauseLayout.offsets.NeedToPauseNow, callback, true);
        view.setUint32(pauseLayout.offsets.user, 0, true);
        bitmap = runtime.call('FPDFBitmap_CreateEx', bufferW, bufferH, BITMAP_BGRA, pixels, stride) >>> 0;
        if (!bitmap) throw new PdfEngineError('ResourceLimit', 'Could not allocate PDF tile bitmap');
        runtime.call('FPDFBitmap_FillRect', bitmap, 0, 0, bufferW, bufferH, 0xffffffff);
    } catch (error) { release(); throw error; }
    return {
        step(budgetMs) {
            if (released) throw new PdfEngineError('AbortError', 'PDF tile was released');
            if (finished) return 'done';
            if (!Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 1000) throw new PdfEngineError('RangeError', 'Invalid PDF render budget');
            deadline = performance.now() + budgetMs;
            try {
                const status = started
                    ? runtime.call('FPDF_RenderPage_Continue', page, pause)
                    : runtime.call('FPDF_RenderPageBitmap_Start', bitmap, page, -bufferX, -bufferY, pageW, pageH, 0, flags, pause);
                started = true;
                if (status === CONTINUE) return 'more';
                runtime.call('FPDF_RenderPage_Close', page);
                renderClosed = true;
                if (status !== DONE) throw new PdfEngineError('PageError', 'PDF page render failed');
                if (request.forms && form) runtime.call('FPDF_FFLDraw', form, bitmap, page, -bufferX, -bufferY, pageW, pageH, 0, flags);
                finished = true;
                return 'done';
            } catch (error) { release(); throw error; }
        },
        result() {
            if (!finished || released) throw new PdfEngineError('PageError', 'PDF tile is not complete');
            const offset = pixels + BLEED_TOP * stride + BLEED_LEFT * 4;
            const length = (outH - 1) * stride + outW * 4;
            const heap = runtime.HEAPU8;
            if (offset > heap.byteLength || length > heap.byteLength - offset) throw new PdfEngineError('EngineBroken', 'PDF tile memory is invalid');
            return { pixels: heap.subarray(offset, offset + length), stride, originX, originY, w: outW, h: outH };
        },
        abort: release,
    };
}
