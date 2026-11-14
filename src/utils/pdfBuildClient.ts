// Main-thread handle on the PDF-building worker.
//
// One worker for the whole app, started on first use and kept warm — spinning up
// a worker per save would re-pay module init (pdf-lib is ~400kB) every time.

import type { NotebookPaper } from './paper';
import type { NotebookSource } from './pdfFormat';
import type { PageOverlay } from './pdfOverlay';
import type { PdfBuildRequest, PdfBuildResponse } from './pdfBuild.worker';
import type { PdfRole } from './pdfRole';
import { PdfBuildRefused, pdfSnapshotRefusal } from './pdfBuildRefusal';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
const rolePending = new Map<number, { resolve: (role: PdfRole) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function failWorker(error: Error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    for (const entry of rolePending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    rolePending.clear();
    if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
    }
    worker = null;
}

function getWorker(): Worker {
    if (worker) return worker;
    worker = new Worker(new URL('./pdfBuild.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PdfBuildResponse>) => {
        const { id, bytes, error, role, refusal } = e.data;
        const inspection = rolePending.get(id);
        if (inspection) {
            clearTimeout(inspection.timer);
            rolePending.delete(id);
            if (error !== undefined || !role) inspection.reject(new Error(error ?? 'Missing PDF role response'));
            else inspection.resolve(role);
            return;
        }
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (refusal) entry.reject(new PdfBuildRefused(refusal));
        else if (error !== undefined || !bytes) entry.reject(new Error(error ?? 'Missing PDF build response'));
        else entry.resolve(bytes);
    };
    worker.onerror = (e) => {
        // A worker-level failure kills every in-flight build; fail them all
        // rather than leave saves hanging forever.
        failWorker(new Error(`PDF worker failed: ${e.message}`));
    };
    worker.onmessageerror = () => failWorker(new Error('PDF worker response could not be read'));
    return worker;
}

/** Read-only union inventory in the same warm worker as the assembler. */
export function inspectPdfRoleAsync(bytes: Uint8Array, generation: string): Promise<PdfRole> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        // A dead/stalled inventory is a refusal, never permission to draw on
        // stamped outer pages. Terminating also releases an unbounded decoder.
        const timer = setTimeout(() => failWorker(new Error('PDF role read timed out')), 30000);
        rolePending.set(id, { resolve, reject, timer });
        try { getWorker().postMessage({ kind: 'inspect-role', id, bytes, generation } satisfies PdfBuildRequest); }
        catch (error) { failWorker(error instanceof Error ? error : new Error(String(error))); }
    });
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
    const refusal = pdfSnapshotRefusal(snapshot);
    if (refusal) return Promise.reject(new PdfBuildRefused(refusal));
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
