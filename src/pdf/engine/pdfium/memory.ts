import { PdfEngineError } from '../types';
import type { PdfiumRuntime } from './loader';

/** Reacquire after every native call: WASM memory growth detaches old views. */
export function heapView(runtime: PdfiumRuntime, pointer: number, bytes: number): DataView {
    const heap = runtime.HEAPU8;
    if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(bytes) || pointer < 0 || bytes < 0 ||
        pointer > heap.byteLength || bytes > heap.byteLength - pointer) {
        throw new PdfEngineError('EngineBroken', 'Invalid PDFium memory range');
    }
    return new DataView(heap.buffer, heap.byteOffset + pointer, bytes);
}

export function withPdfiumMemory<T>(runtime: PdfiumRuntime, bytes: number, use: (pointer: number) => T): T {
    const pointer = runtime.malloc(bytes);
    try {
        heapView(runtime, pointer, bytes);
        runtime.HEAPU8.fill(0, pointer, pointer + bytes);
        return use(pointer);
    } finally {
        runtime.free(pointer);
    }
}

/** PDFium takes a NUL-terminated UTF-8 password; embedded NUL cannot round-trip. */
export function withPdfiumPassword<T>(runtime: PdfiumRuntime, password: string | undefined, use: (pointer: number) => T): T {
    if (password === undefined) return use(0);
    if (password.includes('\0')) throw new PdfEngineError('UnsupportedSecurity', 'PDF password contains an unsupported NUL');
    const bytes = new TextEncoder().encode(password);
    if (bytes.length > 1024 * 1024) throw new PdfEngineError('ResourceLimit', 'PDF password is too long');
    try {
        return withPdfiumMemory(runtime, bytes.length + 1, pointer => {
            runtime.HEAPU8.set(bytes, pointer);
            try { return use(pointer); }
            finally { if (!runtime.aborted) runtime.HEAPU8.fill(0, pointer, pointer + bytes.length + 1); }
        });
    } finally { bytes.fill(0); }
}

/** Native UTF-16 lengths include the NUL terminator and are always bytes. */
export function readPdfiumUtf16(runtime: PdfiumRuntime, pointer: number, bytes: number): string {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % 2 !== 0) throw new PdfEngineError('EngineBroken', 'Invalid PDFium UTF-16 length');
    const view = heapView(runtime, pointer, bytes);
    let end = bytes;
    if (end >= 2 && view.getUint16(end - 2, true) === 0) end -= 2;
    const owned = new Uint8Array(end);
    owned.set(new Uint8Array(view.buffer, view.byteOffset, end));
    return new TextDecoder('utf-16le').decode(owned);
}
