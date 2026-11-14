import { PdfEngineError } from '../engine/types';
import type { WriterNativeDocument } from './nativeStage';
import { WriterArena } from './nativeMemory';
import { Sha256 } from '../../utils/sha256';

export interface NativeAttachment {
    index: number;
    name: string;
    sha256: string;
    bytes: Blob;
    /** Only the public EmbeddedFile Params marker, never a guessed Filespec Desc. */
    marker?: string;
}

function readWide(document: WriterNativeDocument, fn: string, handle: number, prefix: number[] = [], limit = 65536, allowAbsent = false): string {
    const runtime = document.runtime, required = runtime.call(fn, handle, ...prefix, 0, 0) >>> 0;
    if (!required && allowAbsent) return '';
    if (!required || required > limit || required % 2) throw new PdfEngineError('InvalidPdf', 'Invalid PDF attachment metadata');
    const arena = new WriterArena(runtime);
    try {
        const ptr = arena.allocate(required), written = runtime.call(fn, handle, ...prefix, ptr, required) >>> 0;
        if (written !== required) throw new PdfEngineError('InvalidPdf', 'PDF attachment metadata changed');
        const bytes = runtime.HEAPU8.slice(ptr, ptr + required);
        if (bytes[required - 1] !== 0 || bytes[required - 2] !== 0) throw new PdfEngineError('InvalidPdf', 'Invalid PDF attachment text');
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(0, required - 2));
    } finally { arena.dispose(); }
}

/** Full bytes are read one attachment at a time; PDFium never receives a path. */
export async function inventoryNativeAttachments(document: WriterNativeDocument,
    cooperate: () => Promise<void>): Promise<NativeAttachment[]> {
    const runtime = document.runtime, count = runtime.call('FPDFDoc_GetAttachmentCount', document.handle);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) throw new PdfEngineError('ResourceLimit', 'PDF attachment inventory is too large');
    const result: NativeAttachment[] = [];
    for (let i = 0; i < count; i++) {
        await cooperate();
        const attachment = runtime.call('FPDFDoc_GetAttachment', document.handle, i) >>> 0;
        if (!attachment) throw new PdfEngineError('InvalidPdf', 'Cannot inspect listed PDF attachment');
        const name = readWide(document, 'FPDFAttachment_GetName', attachment);
        if (!name || name.includes('\0')) throw new PdfEngineError('InvalidPdf', 'Invalid PDF attachment name');
        const arena = new WriterArena(runtime);
        try {
            const key = arena.ascii('LocalVaultMarker');
            const marker = readWide(document, 'FPDFAttachment_GetStringValue', attachment, [key], 514, true);
            const lengthPtr = arena.allocate(4);
            new DataView(runtime.HEAPU8.buffer).setUint32(lengthPtr, 0, true);
            if (!runtime.call('FPDFAttachment_GetFile', attachment, 0, 0, lengthPtr)) throw new PdfEngineError('InvalidPdf', 'Cannot read listed PDF attachment');
            const length = new DataView(runtime.HEAPU8.buffer).getUint32(lengthPtr, true);
            if (length >= 0x80000000) throw new PdfEngineError('ResourceLimit', 'PDF attachment is too large');
            const data = arena.allocate(Math.max(1, length));
            if (!runtime.call('FPDFAttachment_GetFile', attachment, data, length, lengthPtr) ||
                new DataView(runtime.HEAPU8.buffer).getUint32(lengthPtr, true) !== length) throw new PdfEngineError('InvalidPdf', 'PDF attachment changed during read');
            const bytes = runtime.HEAPU8.slice(data, data + length), hash = new Sha256();
            for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
                hash.update(bytes.subarray(offset, offset + 1024 * 1024));
                await cooperate();
            }
            result.push({ index: i, name, sha256: hash.digest(), bytes: new Blob([bytes]), ...(marker ? { marker } : {}) });
        } finally { arena.dispose(); }
    }
    return result;
}
