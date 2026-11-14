import { createPdfiumFileAccess } from '../engine/pdfium/fileAccess';
import type { PdfiumFileAccess } from '../engine/pdfium/fileAccess';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { PdfEngineError } from '../engine/types';
import type { PageGeometry } from '../../platform/types';
import type { EmittedInk } from './protocol';
import { inkPlacements } from './placement';
import { WriterArena } from './nativeMemory';

/** Writer-private native ownership. Neither this handle nor its source crosses C5. */
export class WriterNativeDocument {
    private closed = false;
    private constructor(readonly runtime: PdfiumRuntime, readonly handle: number, private readonly access: PdfiumFileAccess) {}

    static async open(runtime: PdfiumRuntime, blob: Blob): Promise<WriterNativeDocument> {
        if (runtime.role !== 'writer') throw new PdfEngineError('EngineBroken', 'PDF mutation requires a writer instance');
        if (!(blob instanceof Blob) || !blob.size || blob.size >= 0x80000000) throw new PdfEngineError('ResourceLimit', 'PDF source exceeds the supported byte range');
        return WriterNativeDocument.openBytes(runtime, new Uint8Array(await blob.arrayBuffer()));
    }

    static openBytes(runtime: PdfiumRuntime, bytes: Uint8Array): WriterNativeDocument {
        if (runtime.role !== 'writer') throw new PdfEngineError('EngineBroken', 'PDF mutation requires a writer instance');
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length >= 0x80000000) throw new PdfEngineError('ResourceLimit', 'PDF source exceeds the supported byte range');
        const access = createPdfiumFileAccess(runtime, { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) });
        try {
            const handle = runtime.call('FPDF_LoadCustomDocument', access.pointer, 0) >>> 0;
            if (!handle || access.failed) {
                if (handle) runtime.call('FPDF_CloseDocument', handle);
                throw new PdfEngineError('InvalidPdf', 'PDFium could not open the source');
            }
            return new WriterNativeDocument(runtime, handle, access);
        } catch (error) { access.dispose(); throw error; }
    }

    pageCount(): number {
        const count = this.runtime.call('FPDF_GetPageCount', this.handle);
        if (!Number.isSafeInteger(count) || count < 1 || count > 100_000 || this.access.failed) throw new PdfEngineError('InvalidPdf', 'PDF page inventory failed');
        return count;
    }

    /** v2 marks are raw PDF strings, so an encrypted saved output cannot carry
     * an inspectable mark. Refuse instead of silently dropping its security. */
    assertEditable(): void {
        if (this.runtime.call('FPDF_GetSecurityHandlerRevision', this.handle) !== -1) throw new PdfEngineError('UnsupportedSecurity', 'Encrypted PDF cannot be safely rebuilt by this writer');
        const signatures = this.runtime.call('FPDF_GetSignatureCount', this.handle);
        if (signatures < 0) throw new PdfEngineError('InvalidPdf', 'Cannot inspect PDF signatures');
        if (signatures > 0) throw new PdfEngineError('NotSupported', 'Signed PDF cannot be safely rebuilt');
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try { this.runtime.call('FPDF_CloseDocument', this.handle); }
        finally { this.access.dispose(); }
    }
}

/** Import each generated ink page as a Form on the pristine, never on a prior
 * stamped output. Every transferred native handle is closed on every exit. */
export async function stampNativeInk(destination: WriterNativeDocument, ink: EmittedInk,
    geometries: readonly PageGeometry[], cooperate: () => Promise<void>): Promise<void> {
    const runtime = destination.runtime;
    destination.assertEditable();
    const bytes = new Uint8Array(await ink.pdf.arrayBuffer());
    const placements = inkPlacements(geometries, { schema: ink.schema, bytes, pages: ink.pages });
    if (destination.pageCount() !== geometries.length) throw new PdfEngineError('InvalidPdf', 'Source page geometry changed');
    const source = WriterNativeDocument.openBytes(runtime, bytes);
    try {
        const count = source.pageCount();
        if (count !== ink.pages.length) throw new PdfEngineError('InvalidPdf', 'Ink page count does not match its map');
        for (const placement of placements) {
            await cooperate();
            if (placement.inkPage >= count) throw new PdfEngineError('InvalidPdf', 'Ink page is missing');
            const page = runtime.call('FPDF_LoadPage', destination.handle, placement.sourcePage) >>> 0;
            if (!page) throw new PdfEngineError('PageError', 'Cannot open source page for annotation');
            let xobject = 0, form = 0;
            const arena = new WriterArena(runtime);
            try {
                xobject = runtime.call('FPDF_NewXObjectFromPage', destination.handle, source.handle, placement.inkPage) >>> 0;
                if (!xobject) throw new PdfEngineError('PageError', 'Cannot import the ink page');
                form = runtime.call('FPDF_NewFormObjectFromXObject', xobject) >>> 0;
                if (!form) throw new PdfEngineError('PageError', 'Cannot create an ink Form');
                if (!runtime.call('FPDFPageObj_SetMatrix', form, arena.matrix(placement.matrix))) throw new PdfEngineError('PageError', 'Cannot place the ink Form');
                // Insert takes ownership on success and frees the object on failure.
                const inserted = runtime.call('FPDFPage_InsertObject', page, form);
                form = 0;
                if (!inserted || !runtime.call('FPDFPage_GenerateContent', page)) throw new PdfEngineError('PageError', 'Cannot finish annotated page content');
            } finally {
                if (form) runtime.call('FPDFPageObj_Destroy', form);
                if (xobject) runtime.call('FPDF_CloseXObject', xobject);
                arena.dispose();
                runtime.call('FPDF_ClosePage', page);
            }
        }
    } finally { source.close(); }
}
