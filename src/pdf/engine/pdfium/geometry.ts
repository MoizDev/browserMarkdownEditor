import type { PageGeometry } from '../../../platform/types';
import { PdfEngineError } from '../types';
import type { PdfiumRuntime } from './loader';
import { heapView, withPdfiumMemory } from './memory';

export interface PdfiumPageSize { width: number; height: number }

/** Index-only sizes are estimates until the page's actual display transform is read. */
export function pdfiumPageSize(runtime: PdfiumRuntime, document: number, index: number, maxPoints: number): PdfiumPageSize {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff) throw new PdfEngineError('RangeError', 'Invalid PDF page index');
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) throw new PdfEngineError('EngineBroken', 'Invalid PDF page limit');
    return withPdfiumMemory(runtime, runtime.abi.structs.size.size, pointer => {
        if (!runtime.call('FPDF_GetPageSizeByIndexF', document, index, pointer)) throw new PdfEngineError('PageError', 'PDF page size is unavailable');
        const view = heapView(runtime, pointer, runtime.abi.structs.size.size);
        const offsets = runtime.abi.structs.size.offsets;
        const width = view.getFloat32(offsets.width, true), height = view.getFloat32(offsets.height, true);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
            width > maxPoints || height > maxPoints) throw new PdfEngineError('ResourceLimit', 'PDF page dimensions exceed the supported range');
        return { width, height };
    });
}

/** Exact crop/origin/rotation mapping, obtained from PDFium only for a loaded page. */
export function pdfiumPageGeometry(runtime: PdfiumRuntime, page: number, index: number, size: PdfiumPageSize): PageGeometry & { userUnit: 1 } {
    const quarter = runtime.call('FPDFPage_GetRotation', page);
    if (!Number.isInteger(quarter) || quarter < 0 || quarter > 3) throw new PdfEngineError('PageError', 'Invalid PDF page rotation');
    const rotations = [0, 90, 180, 270] as const;
    const probe = 1024;
    const width = Math.max(1, Math.round(size.width * probe)), height = Math.max(1, Math.round(size.height * probe));
    return withPdfiumMemory(runtime, 16, pointer => {
        const point = (x: number, y: number): readonly [number, number] => {
            if (!runtime.call('FPDF_DeviceToPage', page, 0, 0, width, height, 0, x, y, pointer, pointer + 8)) {
                throw new PdfEngineError('PageError', 'PDF page transform is unavailable');
            }
            const view = heapView(runtime, pointer, 16);
            return [view.getFloat64(0, true), view.getFloat64(8, true)];
        };
        const origin = point(0, 0), x = point(probe, 0), y = point(0, probe);
        const a = x[0] - origin[0], b = x[1] - origin[1], c = y[0] - origin[0], d = y[1] - origin[1];
        if (![...origin, a, b, c, d].every(Number.isFinite) || Math.abs(a * d - b * c) < 1e-12) {
            throw new PdfEngineError('PageError', 'Invalid PDF page transform');
        }
        return { index, width: size.width, height: size.height, rotate: rotations[quarter], userUnit: 1,
            toUserSpace: [a, b, c, d, origin[0], origin[1]] };
    });
}
