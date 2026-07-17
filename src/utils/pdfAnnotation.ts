// The on-disk format for "<name> (annotated).pdf", and the reading/writing of it.
//
// An annotated PDF is a GENUINE PDF, not a container with a .pdf name:
//
//   <name> (annotated).pdf
//   ├── the original pages, intact          ← text stays selectable
//   ├── a transparent stroke overlay/page   ← the annotations, stamped in
//   └── two embedded attachments:
//       ├── original.pdf                    ← pristine, no strokes
//       └── tldraw-snapshot.json            ← so strokes stay editable
//
// It therefore opens correctly in Chrome/Preview/Obsidian *and* reopens here
// as live, editable tldraw shapes.
//
// THE LOAD-BEARING RULE: every save rebuilds from the embedded pristine
// original, never from the currently-stamped pages. Rebuilding from stamped
// pages would re-stamp strokes on top of already-stamped strokes, so each save
// would darken and duplicate the annotations and inflate the file. Verified: 4
// save cycles leave the embedded original byte-identical and the size flat.

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Vite bundles the worker as a separate chunk; hand pdf.js its real URL.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Writing lives in utils/pdfBuild.ts (pdf-lib only, so a worker can load it).
// The shared names come from pdfFormat.ts rather than from pdfBuild directly —
// importing pdfBuild here would pull pdf-lib into this main-thread module.
import { ORIGINAL_ATTACHMENT, SNAPSHOT_ATTACHMENT } from './pdfFormat';

/**
 * Pages are rasterized at 2x so strokes sit against a crisp backdrop.
 *
 * This only affects what you see WHILE annotating. The saved PDF is built by
 * stamping overlays onto the original pages, which are never rasterized — so
 * this number trades render speed against on-screen sharpness and nothing else.
 */
export const PAGE_RENDER_SCALE = 2;

/**
 * Backdrops are encoded as JPEG, not PNG.
 *
 * PNG encoding a ~1200x1600 canvas is one of the slowest steps in opening a
 * document, and lossless fidelity buys nothing here: this is a backdrop to draw
 * on, and it never reaches the saved file. Transparency isn't needed either —
 * pages are opaque. The overlays, which DO reach the file, stay PNG.
 */
const PAGE_IMAGE_TYPE = 'image/jpeg';
const PAGE_IMAGE_QUALITY = 0.82;

/** Vertical gap between pages on the annotate canvas, in PDF points. */
export const PAGE_GAP = 24;

export interface AnnotatedPdfContents {
    /** The pristine original, with no strokes stamped in. */
    original: Uint8Array;
    /** Serialized tldraw snapshot, or '' for an annotated file with no strokes yet. */
    snapshot: string;
}

/**
 * Open `bytes`, hand the document to `read`, and always tear the worker down
 * afterwards. destroy() lives on the loading task, not the document, and
 * skipping it leaks a worker per PDF opened.
 */
async function withPdf<T>(bytes: Uint8Array, read: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
    // pdf.js takes ownership of (and detaches) the buffer it is handed, which
    // would corrupt a caller still holding the same bytes. Always give it a copy.
    const task = pdfjs.getDocument({ data: bytes.slice() });
    try {
        return await read(await task.promise);
    } finally {
        await task.destroy();
    }
}

/**
 * Pull the pristine original and the tldraw snapshot back out of an annotated
 * PDF. Returns null if this file wasn't produced by us (no attachments), which
 * is how a plain PDF is distinguished from one of ours regardless of its name.
 */
export async function readAnnotatedPdf(bytes: Uint8Array): Promise<AnnotatedPdfContents | null> {
    return withPdf(bytes, async doc => {
        const attachments = await doc.getAttachments();
        // NB: a Map, not a plain object — Object.keys() on it is always empty.
        if (!attachments?.has(ORIGINAL_ATTACHMENT)) return null;

        // pdf.js 6 lists attachments without their bytes; content is a 2nd call,
        // and it yields null if the attachment is present but unreadable.
        const original = await doc.getAttachmentContent(ORIGINAL_ATTACHMENT);
        if (!original) return null;

        let snapshot = '';
        if (attachments.has(SNAPSHOT_ATTACHMENT)) {
            const raw = await doc.getAttachmentContent(SNAPSHOT_ATTACHMENT);
            if (raw) snapshot = new TextDecoder().decode(raw);
        }
        return { original: new Uint8Array(original), snapshot };
    });
}

export interface PdfPageSize {
    /** Page size in PDF points — the coordinate space annotations live in. */
    width: number;
    height: number;
}

export interface PdfPageSource {
    /** Every page's geometry, known without rasterizing anything. */
    sizes: PdfPageSize[];
    /** Rasterize one page (0-based) to an object URL. Caller owns the URL. */
    renderPage(index: number): Promise<string>;
    /** Tear down the pdf.js worker. */
    close(): Promise<void>;
}

/**
 * Open a PDF for display on the annotate canvas.
 *
 * Streams rather than returning everything at once. Page GEOMETRY is cheap —
 * pdf.js gives it without touching a pixel — while rasterizing is the expensive
 * part, and a reader only ever looks at one page at a time. Handing back sizes
 * immediately lets the canvas lay out and appear at once, with pages filling in
 * behind it, instead of blocking on a full render of a document you haven't
 * scrolled to yet.
 *
 * Always feed this the PRISTINE original — rendering the stamped pages would
 * show strokes baked into the backdrop while the editable copies of those same
 * strokes load on top, i.e. everything doubled.
 */
export async function openPdfPages(original: Uint8Array): Promise<PdfPageSource> {
    // Not withPdf(): the document must outlive this call so pages can be
    // rasterized on demand. close() is the caller's responsibility.
    const task = pdfjs.getDocument({ data: original.slice() });
    const doc = await task.promise;

    const sizes: PdfPageSize[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const { width, height } = page.getViewport({ scale: 1 });
        sizes.push({ width, height });
    }

    return {
        sizes,
        async renderPage(index: number) {
            const page = await doc.getPage(index + 1);
            const viewport = page.getViewport({ scale: PAGE_RENDER_SCALE });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Could not get a 2D canvas context to render the PDF');
            await page.render({ canvas, canvasContext: context, viewport }).promise;

            const blob = await new Promise<Blob | null>(res =>
                canvas.toBlob(res, PAGE_IMAGE_TYPE, PAGE_IMAGE_QUALITY));
            page.cleanup();
            if (!blob) throw new Error(`Could not rasterize page ${index + 1}`);
            return URL.createObjectURL(blob);
        },
        close: () => task.destroy(),
    };
}

/**
 * Where each page sits on the annotate canvas: stacked vertically, left-aligned,
 * in PDF point space. Shared by the canvas layout and the save path so a stroke's
 * canvas position maps back to the correct page and offset.
 */
export function pageLayout(pages: Array<{ width: number; height: number }>) {
    let y = 0;
    return pages.map(p => {
        const box = { x: 0, y, width: p.width, height: p.height };
        y += p.height + PAGE_GAP;
        return box;
    });
}

// The canvas↔save handoff lives in utils/pdfRenderCache.ts — importable without
// pulling this module (and pdf-lib/pdf.js) into the main bundle.
