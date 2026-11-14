import type { WorkerContext } from '../../platform/workers/serve';
import { Sha256 } from '../../utils/sha256';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { PdfEngineError } from '../engine/types';
import { WriterNativeDocument } from './nativeStage';
import { inspectPdfNotebook } from './notebookInspection';
import { validNotebookSourcePath } from './notebookPointer';
import type { WriterOperations } from './protocol';

type Verify = WriterOperations['writer.verifyNotebookOutput'];

/** Runs only in a fresh writer-role instance, independently of the producer. */
export async function verifyNativeNotebook(runtime: PdfiumRuntime, args: Verify['args'], context: WorkerContext): Promise<Verify['result']> {
    if (!(args.bytes instanceof ArrayBuffer) || args.bytes.byteLength < 8 || args.bytes.byteLength >= 0x80000000 ||
        !args.notebookSource || !validNotebookSourcePath(args.notebookSource.path)) throw new PdfEngineError('InvalidPdf', 'Invalid notebook output verification request');
    const bytes = new Uint8Array(args.bytes), digest = new Sha256();
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        await context.slice();
        digest.update(bytes.subarray(offset, offset + 1024 * 1024));
    }
    const sha256 = digest.digest();
    const inspected = await inspectPdfNotebook(new Blob([args.bytes], { type: 'application/pdf' }), args.notebookSource.path, () => context.slice());
    await context.slice();
    const doc = WriterNativeDocument.openBytes(runtime, bytes);
    try {
        const signatures = runtime.call('FPDF_GetSignatureCount', doc.handle);
        if (!Number.isSafeInteger(signatures) || signatures !== 0 || runtime.call('FPDF_GetSecurityHandlerRevision', doc.handle) !== -1) {
            throw new PdfEngineError('InvalidPdf', 'Notebook output is encrypted or signed');
        }
        const count = doc.pageCount(), geometries = [];
        if (count !== inspected.pageCount) throw new PdfEngineError('InvalidPdf', 'Notebook output page count disagrees');
        for (let page = 0; page < count; page++) {
            await context.slice();
            const size = pdfiumPageSize(runtime, doc.handle, page, 14_400), handle = runtime.call('FPDF_LoadPage', doc.handle, page) >>> 0;
            if (!handle) throw new PdfEngineError('PageError', 'Cannot inspect notebook output geometry');
            try { geometries.push(pdfiumPageGeometry(runtime, handle, page, size)); }
            finally { runtime.call('FPDF_ClosePage', handle); }
        }
        await context.slice();
        context.transfer(args.bytes);
        return { bytes: args.bytes, sha256, path: inspected.path, geometries };
    } finally { doc.close(); }
}
