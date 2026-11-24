import { PDFDocument } from 'pdf-lib';
import type { WorkerContext } from '../../platform/workers/serve';
import { inventoryAttachments } from '../../utils/pdfAttachmentTree';
import { inspectPdfDocumentWriteSafety } from '../../utils/pdfWriteSafety';
import { pdfiumPageGeometry, pdfiumPageSize } from '../engine/pdfium/geometry';
import { Sha256 } from '../../utils/sha256';
import { NOTEBOOK_SOURCE_ATTACHMENT } from '../../utils/pdfFormat';
import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { emitDocument } from './emit';
import { validNotebookSourcePath } from './notebookPointer';
import { attachmentMarker } from './attachments';
import { addNativeAttachment, saveNativeMarkedPdf, saveNativePdf } from './nativeSave';
import { pdfiumWriteMark } from './writeIdentity';
import { verifyNotebookGeometry } from './verifyNotebookOutput';
import { WriterNativeDocument } from './nativeStage';
import { inventoryNativeAttachments } from './nativeInventory';
import type { WriterOperations } from './protocol';

type Build = WriterOperations['writer.buildNotebook'];

/** Fresh generated pages only: imported PDFs use the preservation-aware route. */
export async function buildNativeNotebook(runtime: PdfiumRuntime, args: Build['args'], context: WorkerContext): Promise<Build['result']> {
    if (!Number.isSafeInteger(args.revision) || args.revision < 0 || !/^[0-9a-f]{32}$/.test(args.writeId) ||
        !args.notebookSource || !validNotebookSourcePath(args.notebookSource.path) || !Array.isArray(args.pages) || !args.pages.length ||
        args.pages.length > 100_000 || args.pages.some(page => !page || !Number.isFinite(page.width) || page.width <= 0 || page.width > 14_400 ||
            !Number.isFinite(page.height) || page.height <= 0 || page.height > 14_400)) throw new PdfEngineError('InvalidPdf', 'Invalid notebook export source');
    let bytes: Uint8Array;
    if (args.kind === 'pre-emitted') {
        if (Object.keys(args.notebookSource).some(key => key !== 'path') || args.pages.some(page => Object.keys(page).some(key => key !== 'width' && key !== 'height')))
            throw new PdfEngineError('InvalidPdf', 'Invalid emitted notebook page specification');
        if (!(args.pdf instanceof Blob) || typeof File !== 'undefined' && args.pdf instanceof File || args.pdf.size < 8 || args.pdf.size >= 0x80000000)
            throw new PdfEngineError('InvalidPdf', 'Invalid emitted notebook PDF');
        await context.slice();
        bytes = new Uint8Array(await args.pdf.arrayBuffer());
        await context.slice();
        const inspected = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: Infinity, throwOnInvalidObject: true });
        if (inspectPdfDocumentWriteSafety(inspected).kind !== 'safe' || inventoryAttachments(inspected).length !== 0)
            throw new PdfEngineError('InvalidPdf', 'Emitted notebook PDF contains unsupported source authority');
        const opened = WriterNativeDocument.openBytes(runtime, bytes);
        try {
            const count = opened.pageCount(), signatures = runtime.call('FPDF_GetSignatureCount', opened.handle);
            if (count !== args.pages.length || signatures !== 0 || runtime.call('FPDF_GetSecurityHandlerRevision', opened.handle) !== -1 ||
                (await inventoryNativeAttachments(opened, () => context.slice())).length !== 0) throw new PdfEngineError('InvalidPdf', 'Emitted notebook PDF is not a fresh generated document');
            const pages = [];
            for (let index = 0; index < count; index++) {
                await context.slice();
                const size = pdfiumPageSize(runtime, opened.handle, index, 14_400), page = runtime.call('FPDF_LoadPage', opened.handle, index) >>> 0;
                if (!page) throw new PdfEngineError('PageError', 'Cannot inspect emitted notebook page');
                try { pages.push(pdfiumPageGeometry(runtime, page, index, size)); } finally { runtime.call('FPDF_ClosePage', page); }
            }
            verifyNotebookGeometry({ path: args.notebookSource.path, pages: args.pages }, pages);
        } finally { opened.close(); }
    } else {
        if (args.displayListSchema !== 1 || (args.kind !== undefined && args.kind !== 'display')) throw new PdfEngineError('InvalidPdf', 'Invalid notebook display list');
        bytes = (await emitDocument(args.pages, context)).bytes;
    }
    await context.slice();
    const doc = WriterNativeDocument.openBytes(runtime, bytes);
    let output: Uint8Array;
    const pointer = new TextEncoder().encode(JSON.stringify({ path: args.notebookSource.path, exportedAt: Date.now() }));
    const marker = attachmentMarker('notebook-source', 'notebook-source');
    try {
        const mark = args.kind === 'pre-emitted' ? pdfiumWriteMark('notebook-source', args.writeId).value : undefined;
        await addNativeAttachment(doc, NOTEBOOK_SOURCE_ATTACHMENT, new Blob([pointer]), marker, mark);
        await context.slice();
        output = args.kind === 'pre-emitted' ? await saveNativeMarkedPdf(doc, args.writeId, () => context.cancelled) : saveNativePdf(doc, () => context.cancelled);
    } finally { doc.close(); }
    await context.slice();
    const check = WriterNativeDocument.openBytes(runtime, output);
    try {
        const pageCount = check.pageCount(), inventory = await inventoryNativeAttachments(check, () => context.slice());
        const hash = new Sha256().update(pointer).digest();
        if (pageCount !== args.pages.length || inventory.length !== 1 || inventory[0].name !== NOTEBOOK_SOURCE_ATTACHMENT ||
            inventory[0].marker !== marker || inventory[0].sha256 !== hash) throw new PdfEngineError('InvalidPdf', 'Notebook output could not be verified');
        return { bytes: output.buffer as ArrayBuffer, revision: args.revision, writeId: args.writeId,
            verification: { pageCount, attachmentCount: inventory.length } };
    } finally { check.close(); }
}
