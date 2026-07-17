// Main-thread handle on the PDF-building worker.
//
// One worker for the whole app, started on first use and kept warm — spinning up
// a worker per save would re-pay module init (pdf-lib is ~400kB) every time.

import type { PdfBuildRequest, PdfBuildResponse } from './pdfBuild.worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./pdfBuild.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PdfBuildResponse>) => {
        const { id, bytes, error } = e.data;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (error !== undefined) entry.reject(new Error(error));
        else entry.resolve(bytes);
    };
    worker.onerror = (e) => {
        // A worker-level failure kills every in-flight build; fail them all
        // rather than leave saves hanging forever.
        const err = new Error(`PDF worker failed: ${e.message}`);
        for (const [, entry] of pending) entry.reject(err);
        pending.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}

/**
 * Build an annotated PDF off the main thread.
 *
 * `original` and `overlays` are structured-cloned (copied), NOT transferred:
 * the caller's copy of `original` lives in the render cache and is reused by
 * every subsequent save, and transferring would detach it.
 */
export function buildAnnotatedPdfAsync(
    original: Uint8Array,
    snapshot: string,
    overlays: Array<Uint8Array | undefined>,
): Promise<Uint8Array> {
    const id = nextId++;
    const request: PdfBuildRequest = { id, original, snapshot, overlays };
    return new Promise<Uint8Array>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage(request);
    });
}
