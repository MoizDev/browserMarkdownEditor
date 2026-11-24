import type { Affine, PageGeometry } from '../../../platform/types';
import type { EngineLimits } from '../types';
import type { PdfiumJbig2Regions } from './imageRegions.types';
import type { PdfiumRuntime } from './loader';
import { pdfiumTransformBox, pdfiumUserToPage } from './geometry';
import { heapView, withPdfiumMemory } from './memory';

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const multiply = (a: Affine, b: Affine): Affine => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

/** Public object/filter metadata only. A candidate is not proof that PDFium
 * missed ink; the host samples already-rendered pixels to form a warning. */
export function pdfiumJbig2Regions(runtime: PdfiumRuntime, page: number, geometry: PageGeometry,
    limits: Readonly<EngineLimits>): PdfiumJbig2Regions {
    const budget = Math.min(limits.maxOutlineNodes, 20_000), maxDepth = Math.min(limits.maxOutlineDepth, 64);
    const regions: Array<{ id: number; box: [number, number, number, number] }> = [];
    let partial = false, visitedCount = 0;
    const transform = pdfiumUserToPage(geometry);
    return withPdfiumMemory(runtime, 128, scratch => {
        const stack: Array<{ object: number; parent: Affine; depth: number }> = [], seen = new Set<number>();
        const enqueue = (parentObject: number, parent: Affine, depth: number) => {
            const count = runtime.call(parentObject ? 'FPDFFormObj_CountObjects' : 'FPDFPage_CountObjects', parentObject || page);
            if (!Number.isSafeInteger(count) || count < 0 || count > budget - visitedCount - stack.length || depth > maxDepth) { partial = true; return; }
            for (let index = count - 1; index >= 0; index--) {
                const object = runtime.call(parentObject ? 'FPDFFormObj_GetObject' : 'FPDFPage_GetObject', parentObject || page, index) >>> 0;
                if (object) stack.push({ object, parent, depth }); else partial = true;
            }
        };
        enqueue(0, IDENTITY, 0);
        while (stack.length) {
            const { object, parent, depth } = stack.pop()!;
            if (seen.has(object) || ++visitedCount > budget) { partial = true; continue; }
            seen.add(object);
            const type = runtime.call('FPDFPageObj_GetType', object);
            if (type === 5) {
                if (!runtime.call('FPDFPageObj_GetMatrix', object, scratch)) { partial = true; continue; }
                const view = heapView(runtime, scratch, 24);
                const local: Affine = [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true),
                    view.getFloat32(12, true), view.getFloat32(16, true), view.getFloat32(20, true)];
                if (!local.every(Number.isFinite)) { partial = true; continue; }
                enqueue(object, multiply(parent, local), depth + 1);
            } else if (type === 3) {
                const count = runtime.call('FPDFImageObj_GetImageFilterCount', object);
                if (!Number.isSafeInteger(count) || count < 0 || count > budget - visitedCount) { partial = true; continue; }
                visitedCount += count;
                let jbig2 = false;
                for (let index = 0; index < count; index++) {
                    const length = runtime.call('FPDFImageObj_GetImageFilter', object, index, 0, 0) >>> 0;
                    if (!length || length > 128 || (runtime.call('FPDFImageObj_GetImageFilter', object, index, scratch, length) >>> 0) !== length) { partial = true; continue; }
                    const name = new TextDecoder().decode(runtime.HEAPU8.subarray(scratch, scratch + length)).replace(/\0$/u, '');
                    if (name === 'JBIG2Decode') jbig2 = true;
                }
                if (!jbig2) continue;
                if (!runtime.call('FPDFPageObj_GetBounds', object, scratch, scratch + 4, scratch + 8, scratch + 12)) { partial = true; continue; }
                const view = heapView(runtime, scratch, 16);
                const coordinates = [view.getFloat32(0, true), view.getFloat32(4, true), view.getFloat32(8, true), view.getFloat32(12, true)];
                if (!coordinates.every(Number.isFinite)) { partial = true; continue; }
                const box = pdfiumTransformBox(multiply(transform, parent), coordinates[0], coordinates[1], coordinates[2], coordinates[3]);
                const clipped: [number, number, number, number] = [Math.max(0, box[0]), Math.max(0, box[1]),
                    Math.min(geometry.width, box[2]), Math.min(geometry.height, box[3])];
                if (clipped[2] > clipped[0] && clipped[3] > clipped[1]) regions.push({ id: visitedCount, box: clipped });
            }
        }
        return { regions, partial };
    });
}
