import { PdfEngineError } from '../types';
import type { PdfiumRuntime } from './loader';
import { heapView } from './memory';

export interface PdfiumForms { readonly handle: number; close(): void }

/** Form appearance drawing only: no JS platform or action callback is installed. */
export function createPdfiumForms(runtime: PdfiumRuntime, document: number,
    pageFor: (index: number) => number, currentPage: () => number, rotationFor: (page: number) => number): PdfiumForms {
    const layout = runtime.abi.structs.formFillInfo;
    const pointer = runtime.malloc(layout.size), callbacks: number[] = [];
    let handle = 0, closed = false;
    try {
        runtime.HEAPU8.fill(0, pointer, pointer + layout.size);
        const getPage = runtime.addFunction((_self, doc, index) => (doc >>> 0) === document ? pageFor(index) : 0, 'iiii');
        callbacks.push(getPage);
        const getCurrent = runtime.addFunction((_self, doc) => (doc >>> 0) === document ? currentPage() : 0, 'iii');
        callbacks.push(getCurrent);
        const getRotation = runtime.addFunction((_self, page) => rotationFor(page >>> 0), 'iii');
        callbacks.push(getRotation);
        const view = heapView(runtime, pointer, layout.size);
        view.setInt32(layout.offsets.version, 1, true);
        view.setUint32(layout.offsets.FFI_GetPage, getPage, true);
        view.setUint32(layout.offsets.FFI_GetCurrentPage, getCurrent, true);
        view.setUint32(layout.offsets.FFI_GetRotation, getRotation, true);
        handle = runtime.call('FPDFDOC_InitFormFillEnvironment', document, pointer) >>> 0;
        if (!handle) throw new PdfEngineError('PageError', 'PDF form environment is unavailable');
    } catch (error) {
        for (const callback of callbacks) runtime.removeFunction(callback);
        runtime.free(pointer);
        throw error;
    }
    return { handle, close() {
        if (closed) return;
        closed = true;
        if (!runtime.aborted) { try { runtime.call('FPDFDOC_ExitFormFillEnvironment', handle); } catch { /* worker is already unusable */ } }
        for (const callback of callbacks) runtime.removeFunction(callback);
        runtime.free(pointer);
    } };
}
