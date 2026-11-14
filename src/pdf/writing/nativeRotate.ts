import type { WorkerContext } from '../../platform/workers/serve';
import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import { WriterNativeDocument } from './nativeStage';
import { inventoryNativeAttachments } from './nativeInventory';
import { saveNativePdf } from './nativeSave';
import { validateWriterSource } from './source';
import type { WriterOperations } from './protocol';

type Rotate = WriterOperations['writer.rotate'];

/** Rotation edits an isolated source and returns bytes; App still owns the
 * document's baseline, save queue and versioned disk commit. */
export async function rotateNativePdf(runtime: PdfiumRuntime, args: Rotate['args'], context: WorkerContext): Promise<Rotate['result']> {
    if (args.delta !== 90 && args.delta !== -90) throw new PdfEngineError('RangeError', 'Invalid PDF rotation');
    await validateWriterSource(args.source, () => context.slice());
    if (args.source.pristineFingerprint !== args.source.outerFingerprint) throw new PdfEngineError('NotSupported', 'Annotated PDFs cannot be rotated');
    const doc = await WriterNativeDocument.open(runtime, args.source.pristine);
    let output: Uint8Array;
    try {
        doc.assertEditable();
        const count = doc.pageCount(), attachments = await inventoryNativeAttachments(doc, () => context.slice());
        if (attachments.length) throw new PdfEngineError('NotSupported', 'PDF rotation requires attachment-preserving conversion');
        const indices = args.pageIndices ?? Array.from({ length: count }, (_, i) => i);
        if (new Set(indices).size !== indices.length || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)) throw new PdfEngineError('RangeError', 'Invalid PDF rotation page');
        for (const index of indices) {
            await context.slice();
            const page = runtime.call('FPDF_LoadPage', doc.handle, index) >>> 0;
            if (!page) throw new PdfEngineError('PageError', 'Cannot open PDF page for rotation');
            try {
                const rotation = runtime.call('FPDFPage_GetRotation', page);
                if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) throw new PdfEngineError('PageError', 'Invalid PDF page rotation');
                const next = (rotation + (args.delta === 90 ? 1 : 3)) % 4;
                runtime.call('FPDFPage_SetRotation', page, next);
                if (runtime.call('FPDFPage_GetRotation', page) !== next) throw new PdfEngineError('PageError', 'PDF page rotation did not apply');
            } finally { runtime.call('FPDF_ClosePage', page); }
        }
        await context.slice();
        output = saveNativePdf(doc, () => context.cancelled);
    } finally { doc.close(); }
    await context.slice();
    const check = WriterNativeDocument.openBytes(runtime, output);
    try {
        const count = check.pageCount(), geometries = [];
        for (let i = 0; i < count; i++) {
            await context.slice();
            const size = pdfiumPageSize(runtime, check.handle, i, 14_400), page = runtime.call('FPDF_LoadPage', check.handle, i) >>> 0;
            if (!page) throw new PdfEngineError('PageError', 'Cannot verify rotated PDF page');
            try { geometries.push(pdfiumPageGeometry(runtime, page, i, size)); }
            finally { runtime.call('FPDF_ClosePage', page); }
        }
        return { bytes: output.buffer as ArrayBuffer, sourceFingerprint: args.source.pristineFingerprint, geometries };
    } finally { check.close(); }
}
