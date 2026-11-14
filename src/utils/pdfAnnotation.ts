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

import { bindPdfNativeEmphasis, makePdfEmphasisPlan } from './pdfNativeEmphasis';
import { completedClassicDisplayList } from './pdfClassicDisplayList';
import { classicEmphasisPageKey, classicEmphasisPlanKey } from './pdfEmphasisProfile';
import { getPdfEmphasisPlan, rememberPdfEmphasisPlan } from './pdfEmphasisPlanCache';
import { watchPdfEmphasis } from './pdfEmphasisWatch';
import type { PdfNativeEmphasisResult } from './pdfNativeEmphasis';
import type { PdfDocumentSession } from './pdfDocumentSession';
import type { PdfDisplayGeometry } from './pdfOverlay';
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
    /** The shown pristine page's proof outlives any single raster request. */
    watchEmphasis(index: number, publish: (result: PdfNativeEmphasisResult | undefined) => void): () => void;
    /** Release this source's document lease, not the pane-owned session. */
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
export async function openPdfPages(session: PdfDocumentSession, onRenderHealth?: (health: ClassicPdfHealth) => void): Promise<PdfPageSource> {
    // Each mount owns its subscriber: a cancelled StrictMode predecessor must
    // not close the replacement's status, even though both share a session.
    const diagnostics = createClassicPdfHealth();
    onRenderHealth?.(diagnostics);
    const forward = () => { for (const issue of session.health.getSnapshot()) diagnostics.record(issue); };
    const unsubscribe = session.health.subscribe(forward);
    forward();
    let docLease: Awaited<ReturnType<PdfDocumentSession['acquire']>> | undefined;
    let sizes: PdfPageSize[];
    try {
        docLease = await session.acquire();
        sizes = await session.geometry();
    } catch (error) {
        recordClassicRenderFailure(diagnostics, error);
        docLease?.release(); unsubscribe(); diagnostics.close();
        throw error;
    }
    let closed = false;
    const watches = new Set<() => void>();
    const scales = new Map<number, number>();

    return {
        health: diagnostics,
        sizes,
        watchEmphasis(index, publish) {
            if (closed) return () => {};
            const stop = watchPdfEmphasis(session, session.emphasisIdentity, index, publish);
            const release = () => { watches.delete(release); stop(); };
            watches.add(release);
            return release;
        },
        async renderPage(index: number, scale = PAGE_RENDER_SCALE, emphasisEnabled = false, _onEmphasisResult?: (result: PdfNativeEmphasisResult) => void, signal?: AbortSignal) {
            if (closed) throw new DOMException('PDF source closed', 'AbortError');
            const previousScale = scales.get(index);
            scales.set(index, scale);
            if (previousScale !== undefined && previousScale !== scale) session.emphasisVerdicts.yieldProbes();
            const lease = await session.acquireRender(index, signal);
            const page = lease.page;
            let emphasis: ReturnType<typeof bindPdfNativeEmphasis> | undefined;
            const canvas = document.createElement('canvas');
            let rendering: import('pdfjs-dist').RenderTask | undefined;
            const cancel = () => rendering?.cancel();
            const current = () => !closed && !signal?.aborted;
            signal?.addEventListener('abort', cancel);
            try {
                if (!current()) throw new DOMException('PDF source closed', 'AbortError');
                session.markRendered(index);
                const viewport = page.getViewport({ scale });
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Could not get a 2D canvas context to render the PDF');
                const key = classicEmphasisPageKey(session.emphasisIdentity.token, index, page);
                const verdict = session.emphasisVerdicts.getVerdict(key);
                const useOn = emphasisEnabled && verdict.kind === 'verified' && verdict.result.supported && verdict.result.eligible > 0;
                let plan = useOn ? getPdfEmphasisPlan(page, classicEmphasisPlanKey(key)) : undefined;
                if (plan) emphasis = bindPdfNativeEmphasis(page, context, plan);
                signal?.throwIfAborted();
                if (!current()) throw new DOMException('PDF source closed', 'AbortError');
                rendering = page.render({ canvas, canvasContext: context, viewport, operationsFilter: emphasis?.operationsFilter });
                await diagnostics.guard(rendering.promise, signal);
                diagnostics.assertComplete(index);
                if (useOn && !plan) {
                    const list = completedClassicDisplayList(rendering);
                    if (!list) session.emphasisVerdicts.rejectPlan(key, 'renderer-version');
                    else {
                        plan = makePdfEmphasisPlan(list, undefined, key.locale || undefined);
                        const reason = !plan.result.supported ? plan.result.reason ?? 'glyph-data'
                            : !rememberPdfEmphasisPlan(page, plan, classicEmphasisPlanKey(key)) ? 'page-budget' : undefined;
                        if (reason) session.emphasisVerdicts.rejectPlan(key, reason);
                        else {
                            emphasis = bindPdfNativeEmphasis(page, context, plan);
                            rendering = page.render({ canvas, canvasContext: context, viewport, operationsFilter: emphasis.operationsFilter });
                            await diagnostics.guard(rendering.promise, signal);
                            diagnostics.assertComplete(index);
                        }
                    }
                }
                signal?.throwIfAborted();
                if (!current()) throw new DOMException('PDF source closed', 'AbortError');
                const blob = await new Promise<Blob | null>(res =>
                    canvas.toBlob(res, PAGE_IMAGE_TYPE, PAGE_IMAGE_QUALITY));
                signal?.throwIfAborted();
                if (!current()) throw new DOMException('PDF source closed', 'AbortError');
                if (!blob) throw new Error(`Could not rasterize page ${index + 1}`);
                diagnostics.assertComplete(index);
                return URL.createObjectURL(blob);
            } catch (error) {
                recordClassicRenderFailure(diagnostics, error, index);
                throw error;
            } finally {
                signal?.removeEventListener('abort', cancel);
                if (rendering) { rendering.cancel(); await rendering.promise.catch(() => {}); }
                emphasis?.dispose();
                canvas.width = canvas.height = 0;
                lease.release();
            }
        },
        async close() { if (!closed) { closed = true; for (const release of watches) release(); unsubscribe(); diagnostics.close(); docLease?.release(); } },
    };
}

// The canvas↔save handoff lives in utils/pdfRenderCache.ts — importable without
// pulling this module (and pdf-lib/pdf.js) into the main bundle.
