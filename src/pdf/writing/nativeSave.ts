import { PdfEngineError } from '../engine/types';
import type { PdfiumRuntime } from '../engine/pdfium/loader';
import { checkPdfWriteMarkForBoard, sealPdfWriteMark } from '../../utils/pdfWriteMark';
import { join } from './pdfObjects';
import { WriterArena } from './nativeMemory';
import type { WriterNativeDocument } from './nativeStage';
import { pdfiumWriteMark } from './writeIdentity';

const MAX_OUTPUT = 0x7fffffff;

function setParameter(runtime: PdfiumRuntime, attachment: number, key: string, value: string, arena: WriterArena): void {
    if (!runtime.call('FPDFAttachment_SetStringValue', attachment, arena.ascii(key), arena.wide(value))) {
        throw new PdfEngineError('FileError', 'Cannot set PDF attachment metadata');
    }
}

/** Add one app-owned attachment. The caller has already checked its bytes,
 * content hash, role and collision-free name. */
export async function addNativeAttachment(document: WriterNativeDocument, name: string, bytes: Blob, marker: string): Promise<void> {
    if (!(bytes instanceof Blob) || bytes.size >= MAX_OUTPUT) throw new PdfEngineError('ResourceLimit', 'PDF attachment is too large');
    const data = new Uint8Array(await bytes.arrayBuffer());
    addNativeBytes(document, name, data, marker);
}

function addNativeBytes(document: WriterNativeDocument, name: string, data: Uint8Array, marker: string, writeMark?: string): void {
    const runtime = document.runtime, arena = new WriterArena(runtime);
    try {
        const attachment = runtime.call('FPDFDoc_AddAttachment', document.handle, arena.wide(name)) >>> 0;
        if (!attachment) throw new PdfEngineError('FileError', 'Cannot add PDF attachment');
        const ptr = arena.bytes(data);
        if (!runtime.call('FPDFAttachment_SetFile', attachment, document.handle, ptr, data.byteLength)) throw new PdfEngineError('FileError', 'Cannot write PDF attachment');
        setParameter(runtime, attachment, 'LocalVaultMarker', marker, arena);
        if (writeMark !== undefined) setParameter(runtime, attachment, 'VaultWriteMark', writeMark, arena);
    } finally { arena.dispose(); }
}

/** Must be the last native object allocated before save. */
export function addNativeWriteMark(document: WriterNativeDocument, format: string, writeId: string): void {
    const mark = pdfiumWriteMark(format, writeId);
    addNativeBytes(document, mark.name, mark.payload, mark.marker, mark.value);
}

/** FPDF_NO_INCREMENTAL, bounded sink, no filesystem handle. A failed callback,
 * cancelled request or absent/invalid mark can never produce commit-ready bytes. */
export async function saveNativeMarkedPdf(document: WriterNativeDocument, writeId: string,
    cancelled: () => boolean): Promise<Uint8Array> {
    const runtime = document.runtime, arena = new WriterArena(runtime), chunks: Uint8Array[] = [];
    let size = 0, callback = 0, failure: Error | undefined;
    try {
        const layout = runtime.abi.structs.fileWrite, pointer = arena.allocate(layout.size);
        callback = runtime.addFunction((_self, rawData, rawSize) => {
            try {
                if (cancelled()) throw new PdfEngineError('AbortError', 'PDF save cancelled');
                const offset = rawData >>> 0, length = rawSize >>> 0, heap = runtime.HEAPU8;
                if (offset > heap.length || length > heap.length - offset || size + length > MAX_OUTPUT) throw new PdfEngineError('ResourceLimit', 'PDF output exceeds the supported size');
                chunks.push(heap.slice(offset, offset + length));
                size += length;
                return 1;
            } catch (error) {
                failure = error instanceof Error ? error : new Error('PDF output callback failed');
                return 0;
            }
        }, 'iiii');
        const heap = runtime.HEAPU8;
        heap.fill(0, pointer, pointer + layout.size);
        const view = new DataView(heap.buffer, heap.byteOffset + pointer, layout.size);
        view.setUint32(layout.offsets.version, 1, true);
        view.setUint32(layout.offsets.WriteBlock, callback, true);
        if (cancelled()) throw new PdfEngineError('AbortError', 'PDF save cancelled');
        const saved = runtime.call('FPDF_SaveAsCopy', document.handle, pointer, 2);
        if (failure) throw failure;
        if (!saved || cancelled()) throw new PdfEngineError(cancelled() ? 'AbortError' : 'FileError', 'PDFium could not complete the save');
        const bytes = await sealPdfWriteMark(join(chunks));
        const check = await checkPdfWriteMarkForBoard(bytes, writeId);
        if (check.kind !== 'verified') throw new PdfEngineError('FileError', 'PDF write identity could not be verified');
        return bytes;
    } finally {
        if (callback) runtime.removeFunction(callback);
        arena.dispose();
    }
}
