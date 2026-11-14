// Read the editable role of a genuine PDF, and rasterize its validated source.
//
// An annotated PDF is a GENUINE PDF, not a container with a .pdf name:
//
//   <name>.pdf
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

import { bindPdfNativeEmphasis } from './pdfNativeEmphasis';
import type { PdfNativeEmphasisResult } from './pdfNativeEmphasis';
import { version as pdfjsVersion, type PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfDisplayGeometry } from './pdfOverlay';
import { openClassicPdf, loadClassicPdf, closeClassicPdf } from './pdfClassicOpen';
import { createClassicPdfHealth, recordClassicRenderFailure, type ClassicPdfHealth } from './pdfClassicHealth';

// Writing lives in utils/pdfBuild.ts (pdf-lib only, so a worker can load it).
// Role extraction uses the build worker's read-only inventory operation; this
// main-thread module never imports pdf-lib or the writer implementation.
import { authorizePdfRole, rememberPdfOuter } from './pdfRole';
import type { PdfRole } from './pdfRole';
export type { PdfRole } from './pdfRole';

// Page stacking lives in paper.ts, which imports nothing — the notebook canvas
// lays its pages out with the same function and must not pull pdf.js in to do it.
export { PAGE_GAP, pageLayout } from './paper';

/**
 * The scale every page is first rasterized at, and the floor it falls back to.
 *
 * This only affects what you see WHILE annotating. The saved PDF is built by
 * drawing annotations onto the original pages, which are never rasterized — so
 * this number trades render speed and memory against on-screen sharpness and
 * nothing else.
 *
 * Every page of the document is held at this scale for as long as the canvas is
 * open, so raising it is paid for by the whole document at once. Zooming in is
 * served by re-rendering the few VISIBLE pages instead — see
 * PdfAnnotateCanvas's refinement pass.
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

/** A refusal stays tagged through every entry point; it is never null/plain. */
export async function readPdfRole(bytes: Uint8Array, generation = ''): Promise<PdfRole> {
    try {
        const { inspectPdfRoleAsync } = await import('./pdfBuildClient');
        const role = await inspectPdfRoleAsync(bytes, generation);
        rememberPdfOuter(role, bytes);
        authorizePdfRole(role);
        return role;
    } catch (error) {
        return { kind: 'unreadable', generation, alreadyAnnotated: true, attachment: 'attachment inventory',
            reason: error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'workerDeath' };
    }
}

export const readAnnotatedPdf = readPdfRole;

export type PdfPageSize = PdfDisplayGeometry;

export interface PdfPageSource {
    /** Owned by this acquisition, never shared with a cancelled predecessor. */
    readonly health: ClassicPdfHealth;
    /** Every page's geometry, known without rasterizing anything. */
    sizes: PdfPageSize[];
    /**
     * Rasterize one page (0-based) to an object URL. Caller owns the URL.
     *
     * `scale` defaults to PAGE_RENDER_SCALE; a higher one is how a zoomed-in
     * page is re-rendered sharp.
     */
    renderPage(index: number, scale?: number, emphasisEnabled?: boolean, onEmphasisResult?: (result: PdfNativeEmphasisResult) => void, signal?: AbortSignal): Promise<string>;
    /** Release this source; a healthy shared worker remains warm. */
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
export async function openPdfPages(original: Uint8Array, onRenderHealth?: (health: ClassicPdfHealth) => void): Promise<PdfPageSource> {
    // StrictMode can open the same bytes twice before the first task settles.
    // Its late close must not retire the replacement's diagnostics or subscriber.
    const diagnostics = createClassicPdfHealth();
    onRenderHealth?.(diagnostics);
    const task = await openClassicPdf({ bytes: original, purpose: 'annotation-backdrop', diagnostic: diagnostics.record, progress: diagnostics.progress });
    let doc: PDFDocumentProxy;
    const sizes: PdfPageSize[] = [];
    try {
        doc = await loadClassicPdf(task);
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await diagnostics.guard(doc.getPage(i));
            const viewport = page.getViewport({ scale: 1 });
            const [a, b, c, d, e, f] = viewport.transform;
            const determinant = a * d - b * c;
            if (![a, b, c, d, e, f, viewport.width, viewport.height, determinant].every(Number.isFinite) ||
                determinant === 0 || viewport.width <= 0 || viewport.height <= 0) {
                throw new Error(`Invalid display geometry for PDF page ${i}.`);
            }
            sizes.push({
                width: viewport.width, height: viewport.height,
                toUserSpace: [d / determinant, -b / determinant, -c / determinant, a / determinant,
                    (c * f - d * e) / determinant, (b * e - a * f) / determinant],
                rotation: page.rotate, userUnit: page.userUnit, pageIndex: i - 1,
                sourceFingerprint: doc.fingerprints[0] ?? '', engine: `pdfjs/${pdfjsVersion}`,
            });
        }
    } catch (error) {
        recordClassicRenderFailure(diagnostics, error);
        await closeClassicPdf(task);
        throw error;
    }

    return {
        health: diagnostics,
        sizes,
        async renderPage(index: number, scale = PAGE_RENDER_SCALE, emphasisEnabled = false, onEmphasisResult?: (result: PdfNativeEmphasisResult) => void, signal?: AbortSignal) {
            const page = await diagnostics.guard(doc.getPage(index + 1), signal);
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d');
            if (!context) {
                const error = new Error('Could not get a 2D canvas context to render the PDF');
                canvas.width = canvas.height = 0;
                page.cleanup();
                recordClassicRenderFailure(diagnostics, error, index);
                throw error;
            }
            let emphasis: Awaited<ReturnType<typeof bindPdfNativeEmphasis>> | undefined;
            let rendering: import('pdfjs-dist').RenderTask | undefined;
            const cancel = () => rendering?.cancel();
            const current = () => !signal?.aborted;
            signal?.addEventListener('abort', cancel);
            try {
                signal?.throwIfAborted();
                if (emphasisEnabled || onEmphasisResult) emphasis = await diagnostics.guard(bindPdfNativeEmphasis(page, context, emphasisEnabled), signal);
                rendering = page.render({ canvas, canvasContext: context, viewport, operationsFilter: emphasis?.operationsFilter });
                await diagnostics.guard(rendering.promise, signal);
                if (emphasis) await diagnostics.guard(emphasis.verify({ viewport }, task => { rendering = task; }, current), signal);
                diagnostics.assertComplete(index);
                signal?.throwIfAborted();
                if (emphasis) onEmphasisResult?.({ ...emphasis.result });
                const blob = await new Promise<Blob | null>(res =>
                    canvas.toBlob(res, PAGE_IMAGE_TYPE, PAGE_IMAGE_QUALITY));
                signal?.throwIfAborted();
                if (!blob) throw new Error(`Could not rasterize page ${index + 1}`);
                diagnostics.assertComplete(index);
                return URL.createObjectURL(blob);
            } catch (error) {
                recordClassicRenderFailure(diagnostics, error, index);
                throw error;
            } finally {
                signal?.removeEventListener('abort', cancel);
                emphasis?.dispose();
                canvas.width = canvas.height = 0;
                page.cleanup();
            }
        },
        close: () => { const stalled = diagnostics.stalled; diagnostics.close(); return closeClassicPdf(task, stalled); },
    };
}

// The canvas↔save handoff lives in utils/pdfRenderCache.ts — importable without
// pulling this module (and pdf-lib/pdf.js) into the main bundle.
