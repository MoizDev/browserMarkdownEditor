import { PdfEngineError } from '../types';
import type { PdfiumRuntime } from './loader';
import { heapView, readPdfiumUtf16, withPdfiumMemory } from './memory';

/** This is only PDFium's EmbeddedFiles name tree, not the /AF union. The
 * separate Filespec and Params markers must never silently override each other. */
export interface PdfiumAttachment {
    index: number;
    name: string;
    /** PDFium's public size query decodes the stream; unknown until demanded. */
    size: null;
    description?: string;
    descriptionKnown: boolean;
    paramsMarker?: string;
    paramsKnown: boolean;
}
const MAX_ATTACHMENTS = 10_000, MAX_NAME_UNITS = 1024, MAX_MARKER_BYTES = 256, MAX_DESCRIPTION_UNITS = 8192;

function attachmentHandle(runtime: PdfiumRuntime, document: number, index: number): number {
    const handle = runtime.call('FPDFDoc_GetAttachment', document, index) >>> 0;
    if (!handle) throw new PdfEngineError('FileError', 'PDF attachment is unreadable');
    return handle;
}

function utf16Value(runtime: PdfiumRuntime, operation: string, args: number[], maxUnits: number, optional: boolean): string | undefined {
    const bytes = runtime.call(operation, ...args, 0, 0) >>> 0;
    if (!bytes && optional) return undefined;
    if (bytes < 2 || bytes % 2 || bytes > (maxUnits + 1) * 2) throw new PdfEngineError('ResourceLimit', 'PDF attachment text exceeds the supported range');
    return withPdfiumMemory(runtime, bytes, pointer => {
        if ((runtime.call(operation, ...args, pointer, bytes) >>> 0) !== bytes) throw new PdfEngineError('FileError', 'PDF attachment text is unreadable');
        return readPdfiumUtf16(runtime, pointer, bytes);
    });
}

function attachmentSize(runtime: PdfiumRuntime, handle: number): number {
    return withPdfiumMemory(runtime, 4, pointer => {
        if (!runtime.call('FPDFAttachment_GetFile', handle, 0, 0, pointer)) throw new PdfEngineError('FileError', 'PDF attachment bytes are unreadable');
        return heapView(runtime, pointer, 4).getUint32(0, true);
    });
}

export function pdfiumAttachmentInventory(runtime: PdfiumRuntime, document: number): PdfiumAttachment[] {
    const count = runtime.call('FPDFDoc_GetAttachmentCount', document);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ATTACHMENTS) throw new PdfEngineError('ResourceLimit', 'PDF has too many attachments');
    const key = new TextEncoder().encode('LocalVaultMarker');
    return withPdfiumMemory(runtime, key.length + 1, keyPointer => {
        runtime.HEAPU8.set(key, keyPointer);
        const result: PdfiumAttachment[] = [];
        for (let index = 0; index < count; index++) {
            const handle = attachmentHandle(runtime, document, index);
            const name = utf16Value(runtime, 'FPDFAttachment_GetName', [handle], MAX_NAME_UNITS, false);
            if (name === undefined) throw new PdfEngineError('FileError', 'PDF attachment name is unreadable');
            let description: string | undefined;
            try { description = utf16Value(runtime, 'FPDFAttachment_GetDescription', [handle], MAX_DESCRIPTION_UNITS, true); }
            catch (error) { if (!(error instanceof PdfEngineError) || error.name !== 'ResourceLimit') throw error; }
            let marker: string | undefined;
            try { marker = utf16Value(runtime, 'FPDFAttachment_GetStringValue', [handle, keyPointer], MAX_MARKER_BYTES, true); }
            catch (error) { if (!(error instanceof PdfEngineError) || error.name !== 'ResourceLimit') throw error; }
            const markerValid = marker === undefined || new TextEncoder().encode(marker).length <= MAX_MARKER_BYTES;
            result.push({ index, name, size: null, descriptionKnown: description !== undefined,
                paramsKnown: marker !== undefined && markerValid, ...(description ? { description } : {}),
                ...(marker && markerValid ? { paramsMarker: marker } : {}) });
        }
        return result;
    });
}

export function readPdfiumAttachment(runtime: PdfiumRuntime, document: number, index: number, maxBytes: number): Uint8Array {
    const count = runtime.call('FPDFDoc_GetAttachmentCount', document);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new PdfEngineError('NotFoundError', 'PDF attachment not found');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= 0x80000000) throw new PdfEngineError('RangeError', 'Invalid PDF attachment limit');
    const handle = attachmentHandle(runtime, document, index), size = attachmentSize(runtime, handle);
    if (size > maxBytes || size >= 0x80000000) throw new PdfEngineError('ResourceLimit', 'PDF attachment exceeds the supported range');
    if (size === 0) return new Uint8Array(0);
    return withPdfiumMemory(runtime, 4, lengthPointer => withPdfiumMemory(runtime, size, buffer => {
        if (!runtime.call('FPDFAttachment_GetFile', handle, buffer, size, lengthPointer) ||
            heapView(runtime, lengthPointer, 4).getUint32(0, true) !== size) throw new PdfEngineError('FileError', 'PDF attachment changed while reading');
        const view = heapView(runtime, buffer, size);
        return new Uint8Array(new Uint8Array(view.buffer, view.byteOffset, size));
    }));
}
