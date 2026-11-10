// Main-thread handle on the PDF-building worker.
//
// One worker for the whole app, started on first use and kept warm — spinning up
// a worker per save would re-pay module init (pdf-lib is ~400kB) every time.

import type { NotebookPaper } from './paper';
import type { NotebookSource } from './pdfFormat';
import type { PageOverlay } from './pdfOverlay';
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
    overlays: Array<PageOverlay | undefined>,
): Promise<Uint8Array> {
    return dispatch(id => ({ kind: 'annotate', id, original, snapshot, overlays }));
}

/**
 * Write a notebook out as a PDF, off the main thread.
 *
 * Shares the annotated-PDF worker rather than starting a second one: both jobs
 * are pdf-lib, so a separate worker would re-pay ~400kB of module init to do the
 * same work.
 */
export function buildNotebookPdfAsync(
    paper: NotebookPaper,
    overlays: Array<PageOverlay | undefined>,
    source?: NotebookSource,
): Promise<Uint8Array> {
    return dispatch(id => ({ kind: 'notebook', id, paper, overlays, source }));
}

/**
 * Turn a PDF's pages a quarter (`/Rotate`) off the main thread, and get the
 * rewritten file back.
 *
 * `bytes` is TRANSFERRED, not cloned, and is DETACHED (length 0) once this
 * returns: the caller read it fresh for this one gesture and has no further use
 * for it, and a 220MB textbook should not be copied to be turned. A view onto
 * part of a larger buffer is copied out first, since transferring would hand
 * over (and detach) bytes the view does not own.
 */
export function rotatePdfAsync(bytes: Uint8Array, delta: number, pageIndex?: number): Promise<Uint8Array> {
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes.slice();
    return dispatch(id => ({ kind: 'rotate', id, bytes: whole, delta, pageIndex }), [whole.buffer as ArrayBuffer]);
}

function dispatch(build: (id: number) => PdfBuildRequest, transfer: Transferable[] = []): Promise<Uint8Array> {
    const id = nextId++;
    const request = build(id);
    return new Promise<Uint8Array>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage(request, transfer);
    });
}
