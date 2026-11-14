import type { WorkerContext } from '../../platform/workers/serve';
import { Sha256 } from '../../utils/sha256';
import { NOTEBOOK_SOURCE_ATTACHMENT } from '../../utils/pdfFormat';
import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { emitDocument } from './emit';
import { validNotebookSourcePath } from './notebookPointer';
import { attachmentMarker } from './attachments';
import { addNativeAttachment, saveNativePdf } from './nativeSave';
import { WriterNativeDocument } from './nativeStage';
import { inventoryNativeAttachments } from './nativeInventory';
import type { WriterOperations } from './protocol';

type Build = WriterOperations['writer.buildNotebook'];

/** Fresh generated pages only: imported PDFs use the preservation-aware route. */
export async function buildNativeNotebook(runtime: PdfiumRuntime, args: Build['args'], context: WorkerContext): Promise<Build['result']> {
    if (args.displayListSchema !== 1 || !Number.isSafeInteger(args.revision) || args.revision < 0 || !/^[0-9a-f]{32}$/.test(args.writeId) ||
        !args.notebookSource || !validNotebookSourcePath(args.notebookSource.path)) throw new PdfEngineError('InvalidPdf', 'Invalid notebook export source');
    const generated = await emitDocument(args.pages, context);
    await context.slice();
    const doc = WriterNativeDocument.openBytes(runtime, generated.bytes);
    let output: Uint8Array;
    const pointer = new TextEncoder().encode(JSON.stringify({ path: args.notebookSource.path, exportedAt: Date.now() }));
    const marker = attachmentMarker('notebook-source', 'notebook-source');
    try {
        await addNativeAttachment(doc, NOTEBOOK_SOURCE_ATTACHMENT, new Blob([pointer]), marker);
        await context.slice();
        output = saveNativePdf(doc, () => context.cancelled);
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
