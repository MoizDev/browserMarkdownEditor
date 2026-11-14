import { PdfEngineError } from '../types';
import type { EngineLimits, PageComplexity } from '../types';
import type { PdfiumRuntime } from './loader';
import { heapView, withPdfiumMemory } from './memory';

/** PDFium's public image metadata may itself parse or decode; the worker heap
 * ceiling remains the backstop for inline images and unobservable masks. */
export function pdfiumComplexity(runtime: PdfiumRuntime, page: number, limits: Readonly<EngineLimits>): PageComplexity {
    const result: PageComplexity = { objects: 0, textObjects: 0, imageObjects: 0, imagePixels: 0, pathObjects: 0, formObjects: 0 };
    const maxObjects = Math.min(limits.maxOutlineNodes, 20_000);
    if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || !Number.isSafeInteger(limits.maxDecodedImageBytes) || limits.maxDecodedImageBytes < 1) {
        throw new PdfEngineError('EngineBroken', 'Invalid PDF image preflight limits');
    }
    return withPdfiumMemory(runtime, runtime.abi.structs.imageMetadata.size, pointer => {
        const stack: Array<{ object: number; depth: number }> = [];
        const seen = new Set<number>();
        const enqueue = (parent: number, count: number, depth: number) => {
            if (!Number.isSafeInteger(count) || count < 0 || count > maxObjects - result.objects - stack.length || depth > 64) {
                throw new PdfEngineError('ResourceLimit', 'PDF page object traversal exceeds its limit');
            }
            for (let i = count - 1; i >= 0; i--) {
                const object = runtime.call(parent ? 'FPDFFormObj_GetObject' : 'FPDFPage_GetObject', parent || page, i) >>> 0;
                if (!object) throw new PdfEngineError('PageError', 'PDF page object is unreadable');
                stack.push({ object, depth });
            }
        };
        enqueue(0, runtime.call('FPDFPage_CountObjects', page), 0);
        while (stack.length) {
            const { object, depth } = stack.pop()!;
            if (seen.has(object)) throw new PdfEngineError('PageError', 'PDF page objects contain a cycle');
            seen.add(object); result.objects++;
            const type = runtime.call('FPDFPageObj_GetType', object);
            if (type === 1) result.textObjects++;
            else if (type === 2) result.pathObjects++;
            else if (type === 3) {
                result.imageObjects++;
                if (!runtime.call('FPDFImageObj_GetImagePixelSize', object, pointer, pointer + 4)) {
                    throw new PdfEngineError('PageError', 'PDF image dimensions are unavailable');
                }
                const dimensions = heapView(runtime, pointer, 8);
                const width = dimensions.getUint32(0, true), height = dimensions.getUint32(4, true);
                if (!width || !height) throw new PdfEngineError('PageError', 'PDF image has invalid dimensions');
                const pixels = BigInt(width) * BigInt(height);
                result.imagePixels = Number(pixels > BigInt(Number.MAX_SAFE_INTEGER - result.imagePixels)
                    ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(result.imagePixels) + pixels);
                const layout = runtime.abi.structs.imageMetadata;
                runtime.HEAPU8.fill(0, pointer, pointer + layout.size);
                let bpp = 32;
                if (runtime.call('FPDFImageObj_GetImageMetadata', object, page, pointer)) {
                    const metadata = heapView(runtime, pointer, layout.size);
                    const reportedWidth = metadata.getUint32(layout.offsets.width, true);
                    const reportedHeight = metadata.getUint32(layout.offsets.height, true);
                    const reported = metadata.getUint32(layout.offsets.bits_per_pixel, true);
                    if (reportedWidth !== width || reportedHeight !== height) {
                        throw new PdfEngineError('PageError', 'PDF image dimensions changed during preflight');
                    }
                    // GetImageMetadata returns CPDF_DIB's decoded format, not PDF
                    // BitsPerComponent. Only formats emitted by the pinned DIB are
                    // known; an unavailable or unfamiliar format uses 32 bpp.
                    if (reported === 1 || reported === 8 || reported === 24 || reported === 32) bpp = reported;
                }
                const row = ((BigInt(width) * BigInt(bpp) + 7n) / 8n + 3n) & ~3n;
                // Public metadata loads with bHasMask=false: separate soft masks,
                // decoder auxiliaries and inline images remain unknown, not zero.
                if (row * BigInt(height) > BigInt(limits.maxDecodedImageBytes)) {
                    throw new PdfEngineError('ResourceLimit', 'PDF image is too large to draw');
                }
            } else if (type === 5) {
                result.formObjects++;
                enqueue(object, runtime.call('FPDFFormObj_CountObjects', object), depth + 1);
            }
        }
        return result;
    });
}
