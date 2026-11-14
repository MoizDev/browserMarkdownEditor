import type { ByteSource } from '../types';
import { PdfEngineError } from '../types';
import type { PdfiumRuntime } from './loader';

export interface PdfiumFileAccess {
    readonly pointer: number;
    /** A callback failure is sticky: a short read must never become a plain PDF. */
    readonly failed: boolean;
    /** Call only after PDFium has closed every document using this source. */
    dispose(): void;
}

/** The source remains in the runtime's bounded byte cache, not the WASM heap. */
export function createPdfiumFileAccess(runtime: PdfiumRuntime, source: ByteSource): PdfiumFileAccess {
    if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size >= 0x80000000) {
        throw new PdfEngineError('ResourceLimit', 'PDF source exceeds the supported byte range');
    }
    const layout = runtime.abi.structs.fileAccess;
    const pointer = runtime.malloc(layout.size);
    let callback = 0;
    let failed = false;
    let disposed = false;
    try {
        callback = runtime.addFunction((_param, rawPosition, rawDestination, rawSize) => {
            try {
                const position = rawPosition >>> 0, destination = rawDestination >>> 0, size = rawSize >>> 0;
                const heap = runtime.HEAPU8;
                if (disposed || position > source.size || size > source.size - position ||
                    destination > heap.byteLength || size > heap.byteLength - destination) throw new Error('Invalid PDFium source range');
                const bytes = source.read(position, size);
                if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) throw new Error('Short PDF source read');
                // read() may grow the engine heap through application callbacks;
                // never retain the old view across it.
                const current = runtime.HEAPU8;
                if (destination > current.byteLength || size > current.byteLength - destination) throw new Error('Invalid PDFium destination');
                current.set(bytes, destination);
                return 1;
            } catch {
                failed = true;
                return 0;
            }
        }, 'iiiii');
        const heap = runtime.HEAPU8;
        if (pointer % 4 || pointer + layout.size > heap.byteLength) throw new PdfEngineError('EngineBroken', 'Invalid PDFium file-access allocation');
        heap.fill(0, pointer, pointer + layout.size);
        const view = new DataView(heap.buffer, heap.byteOffset + pointer, layout.size);
        view.setUint32(layout.offsets.m_FileLen, source.size, true);
        view.setUint32(layout.offsets.m_GetBlock, callback, true);
        view.setUint32(layout.offsets.m_Param, 0, true);
    } catch (error) {
        if (callback) runtime.removeFunction(callback);
        runtime.free(pointer);
        throw error;
    }
    return {
        pointer,
        get failed() { return failed; },
        dispose() {
            if (disposed) return;
            disposed = true;
            runtime.removeFunction(callback);
            runtime.free(pointer);
        },
    };
}
