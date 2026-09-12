// One pdf.js worker for the whole app.
//
// pdf.js spawns a worker PER `getDocument` unless it is handed one, and a
// loading task only tears down a worker it created itself — so passing a shared
// one is both safe and the whole fix. Opening a single PDF used to start two:
// PdfPane probes the file's role (attachments) before it knows which view to
// show, then the viewer opens the same bytes again. Each boot loads and
// compiles ~1MB of worker script before a byte of the document is read.
//
// One worker is also what pdf.js's own viewer does. The cost is that documents
// share a thread, which for an app that shows one or two PDFs at a time is far
// cheaper than the boots it replaces.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Vite bundles the worker as a separate chunk; hand pdf.js its real URL. This
// module is the one place that says so — importing it is how the PDF modules
// get the assignment.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfWorker = InstanceType<typeof pdfjs.PDFWorker>;

let shared: PdfWorker | null = null;

/**
 * The shared worker, started on first use.
 *
 * Pass it as `worker` to every `getDocument` call: without it pdf.js creates
 * its own and `loadingTask.destroy()` takes it down again, so nothing is ever
 * reused. Re-created if it was ever destroyed, which only a teardown race can
 * do — a dead worker would fail every subsequent load with "Worker was
 * destroyed".
 */
export function pdfWorker(): PdfWorker {
    if (!shared || shared.destroyed) shared = new pdfjs.PDFWorker();
    return shared;
}
