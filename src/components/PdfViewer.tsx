import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readJSON, writeJSON } from '../utils/storage';

// Same assignment as utils/pdfAnnotation.ts — whichever module loads first
// wins, and both hand pdf.js the identical bundled worker URL.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * The view half of a PDF: a pdf.js-rendered continuous scroll of pages.
 *
 * This replaced the browser's own viewer in an <iframe> for one reason the
 * native viewer can never satisfy: it is a closed box — the embedding page
 * cannot ask it what page the user is on, so neither "reopen where I left off"
 * nor keeping the position across tab switches was possible. Rendering the
 * pages ourselves makes the scroll position ours to read, persist and restore.
 *
 * What keeps parity with the native viewer:
 * - Text is selectable/copyable via pdf.js's TextLayer (transparent spans over
 *   the canvas), and ⌘F works because text layers are built for EVERY page of
 *   ordinarily-sized documents, not just the visible ones.
 * - Scrolling is a real DOM scroller (wheel, trackpad, PgUp/PgDn, arrows).
 * - Fit-width by default, plus simple zoom controls.
 *
 * Memory discipline: canvas BITMAPS are the expensive part (a page at 2x DPR is
 * ~10MB), so only pages near the viewport hold one — scrolled-away canvases are
 * freed (width=0) and re-rendered on approach. Text layers are cheap DOM and are
 * kept once built.
 *
 * The current position is tracked as {page, offset-within-page}, which survives
 * zoom, container resizes and reloads of the underlying bytes (an annotated
 * save swaps `data`; the ref carries the position onto the new document).
 * Persisted (debounced) to localStorage 'pdfViewPositions' keyed by vault path.
 */

interface PdfViewerProps {
    /** Vault path — the persistence key for page position + zoom. */
    filePath: string;
    /** The PDF bytes to display. A new array identity reloads the document. */
    data: Uint8Array;
}

interface PdfViewPos {
    /** 0-based index of the page under the top edge of the viewport. */
    page: number;
    /** How far into that page the top edge sits, as a fraction of its height. */
    offset: number;
    /** Zoom factor on top of fit-width (1 = fit width). */
    zoom?: number;
}

interface DocState {
    doc: PDFDocumentProxy;
    /** Per-page size at scale 1, in PDF points. */
    dims: Array<{ w: number; h: number }>;
    /** Monotonic load counter — keys the page DOM and guards stale async work. */
    gen: number;
}

interface PageState {
    pagePromise?: Promise<PDFPageProxy>;
    renderTask?: RenderTask;
    /** Scale of the bitmap currently in this page's canvas. */
    renderedScale?: number;
    /** Scale the in-flight render is producing (to avoid cancelling it needlessly). */
    renderingScale?: number;
    /** Latest scale the window pass asked for; the render loop chases it. */
    wantScale?: number;
    /** False once evicted — tells an in-flight render loop to stop. */
    wantRender?: boolean;
    /** A render loop is currently running for this page. */
    busy?: boolean;
    textStarted?: boolean;
    textPromise?: Promise<void>;
}

const STORAGE_KEY = 'pdfViewPositions';
/** Vertical padding above the first / below the last page, px. */
const PAD_V = 20;
/** Gap between pages, px. */
const PAGE_GAP = 14;
/** Horizontal breathing room subtracted from the container for fit-width. */
const SIDE_GUTTER = 28;
/** Render canvases this many pages beyond the visible range. */
const RENDER_AHEAD = 1;
/** Keep already-rendered canvases until this many pages out of view. */
const EVICT_BEYOND = 3;
/** Build text layers for the whole document up to this page count, so ⌘F can
 *  find text anywhere. Beyond it (rare, book-sized), text follows the canvas
 *  window instead of bloating the DOM with hundreds of thousands of spans. */
const TEXT_EAGER_LIMIT = 300;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

function PdfViewer({ filePath, data }: PdfViewerProps) {
    // Read once per mount: where this file was last left, and at what zoom.
    const [saved] = useState<PdfViewPos | undefined>(
        () => readJSON<Record<string, PdfViewPos>>(STORAGE_KEY, {})[filePath]
    );
    const [zoom, setZoom] = useState<number>(() => clampZoom(saved?.zoom ?? 1));
    const [docState, setDocState] = useState<DocState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const canvasElsRef = useRef<Array<HTMLCanvasElement | null>>([]);
    const textElsRef = useRef<Array<HTMLDivElement | null>>([]);
    const pageStatesRef = useRef<Map<number, PageState>>(new Map());
    const textLayersRef = useRef<Set<InstanceType<typeof pdfjs.TextLayer>>>(new Set());
    const docStateRef = useRef<DocState | null>(null);
    const docGenRef = useRef(0);
    const zoomRef = useRef(zoom);

    /** The live position, updated on every scroll pass. Seeded from storage so
     *  the first layout restores it; a data swap (annotated save) reuses it so
     *  the reloaded document opens on the same page. */
    const currentPosRef = useRef<{ page: number; offset: number }>({
        page: saved?.page ?? 0,
        offset: saved?.offset ?? 0,
    });

    // ── Position persistence (debounced) ───────────────────────────────────
    const persistTimerRef = useRef<number | null>(null);
    const persistNow = useCallback(() => {
        persistTimerRef.current = null;
        const all = readJSON<Record<string, PdfViewPos>>(STORAGE_KEY, {});
        const { page, offset } = currentPosRef.current;
        all[filePath] = { page, offset: Math.round(offset * 1000) / 1000, zoom: zoomRef.current };
        writeJSON(STORAGE_KEY, all);
    }, [filePath]);

    const schedulePersist = useCallback(() => {
        if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
        persistTimerRef.current = window.setTimeout(persistNow, 400);
    }, [persistNow]);

    // A pending write must not die with the pane (tab closed mid-scroll).
    useEffect(() => () => {
        if (persistTimerRef.current !== null) {
            clearTimeout(persistTimerRef.current);
            persistNow();
        }
    }, [persistNow]);

    useEffect(() => {
        zoomRef.current = zoom;
        schedulePersist();
    }, [zoom, schedulePersist]);

    // ── Document loading ────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        setError(null);
        const gen = ++docGenRef.current;
        // The containers themselves are created once and never replaced, so
        // capturing them here for the cleanup is safe (and keeps lint honest).
        const textLayers = textLayersRef.current;
        const pageStates = pageStatesRef.current;
        // pdf.js takes ownership of (and detaches) the buffer it's handed —
        // always give it a copy so `data` stays readable for the next load.
        const task = pdfjs.getDocument({ data: data.slice() });

        (async () => {
            try {
                const doc = await task.promise;
                const dims: Array<{ w: number; h: number }> = [];
                for (let i = 1; i <= doc.numPages; i++) {
                    const page = await doc.getPage(i);
                    if (cancelled) return;
                    const vp = page.getViewport({ scale: 1 });
                    dims.push({ w: vp.width, h: vp.height });
                }
                if (cancelled) return;
                const ds: DocState = { doc, dims, gen };
                // Set the ref synchronously: the re-anchor layout effect (which
                // kicks the first window pass) runs before passive effects would
                // have mirrored it.
                docStateRef.current = ds;
                canvasElsRef.current = [];
                textElsRef.current = [];
                setDocState(ds);
            } catch (err) {
                if (!cancelled) {
                    console.error('Could not open PDF for viewing:', err);
                    setError(err instanceof Error ? err.message : String(err));
                }
            }
        })();

        return () => {
            cancelled = true;
            for (const layer of textLayers) layer.cancel();
            textLayers.clear();
            for (const st of pageStates.values()) {
                st.wantRender = false;
                st.renderTask?.cancel();
            }
            pageStates.clear();
            docStateRef.current = null;
            setDocState(null);
            void task.destroy();
        };
    }, [data]);

    // ── Fit-width layout ─────────────────────────────────────────────────────
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            const w = Math.round(entries[0].contentRect.width);
            setContainerWidth(prev => (Math.abs(prev - w) < 1 ? prev : w));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const layout = useMemo(() => {
        if (!docState || containerWidth <= 0) return null;
        const avail = Math.max(120, containerWidth - SIDE_GUTTER * 2);
        const maxW = Math.max(...docState.dims.map(d => d.w));
        const scale = Math.min(8, Math.max(0.05, (avail / maxW) * zoom));
        const pages = docState.dims.map(d => ({ w: d.w * scale, h: d.h * scale }));
        const tops: number[] = [];
        let y = PAD_V;
        for (const p of pages) {
            tops.push(y);
            y += p.h + PAGE_GAP;
        }
        return { gen: docState.gen, scale, pages, tops };
    }, [docState, containerWidth, zoom]);
    const layoutRef = useRef<typeof layout>(null);

    // ── Page rendering (windowed) ───────────────────────────────────────────
    const getState = useCallback((i: number): PageState => {
        let st = pageStatesRef.current.get(i);
        if (!st) {
            st = {};
            pageStatesRef.current.set(i, st);
        }
        return st;
    }, []);

    const getPage = useCallback((i: number): Promise<PDFPageProxy> => {
        const st = getState(i);
        st.pagePromise ??= docStateRef.current!.doc.getPage(i + 1);
        return st.pagePromise;
    }, [getState]);

    const clearCanvas = useCallback((i: number) => {
        const canvas = canvasElsRef.current[i];
        if (canvas && canvas.width > 0) {
            canvas.width = 0;
            canvas.height = 0;
        }
    }, []);

    /** Build the selectable-text overlay for one page. Geometry is stored in
     *  page-percentages and font sizes ride the --scale-factor CSS variable, so
     *  a text layer is built ONCE per page and zoom rescales it for free. */
    const ensureText = useCallback((i: number): Promise<void> => {
        const st = getState(i);
        if (st.textStarted) return st.textPromise ?? Promise.resolve();
        const container = textElsRef.current[i];
        if (!container || !docStateRef.current) return Promise.resolve();
        st.textStarted = true;
        const gen = docGenRef.current;
        st.textPromise = (async () => {
            try {
                const page = await getPage(i);
                if (docGenRef.current !== gen || textElsRef.current[i] !== container) return;
                const layer = new pdfjs.TextLayer({
                    textContentSource: page.streamTextContent(),
                    container,
                    viewport: page.getViewport({ scale: 1 }),
                });
                textLayersRef.current.add(layer);
                try {
                    await layer.render();
                } finally {
                    textLayersRef.current.delete(layer);
                }
            } catch (err) {
                // Teardown mid-build (tab closed, document reloaded) cancels
                // the stream — that's shutdown, not a failure.
                if ((err as Error)?.name !== 'AbortException') {
                    console.error(`Could not build the text layer for PDF page ${i + 1}:`, err);
                }
            }
        })();
        return st.textPromise;
    }, [getState, getPage]);

    /** Render one page's canvas, chasing wantScale until it matches (a zoom
     *  mid-render cancels the task and the loop goes again at the new scale). */
    const renderLoop = useCallback(async (i: number, st: PageState) => {
        st.busy = true;
        const gen = docGenRef.current;
        try {
            while (st.wantRender && st.wantScale !== undefined && st.renderedScale !== st.wantScale) {
                const scale = st.wantScale;
                const page = await getPage(i);
                if (docGenRef.current !== gen || !st.wantRender) return;
                const canvas = canvasElsRef.current[i];
                if (!canvas) return;

                const vp = page.getViewport({ scale });
                // Cap the backing-store multiplier: past 2x the sharpness gain is
                // invisible but the bitmap cost doubles again.
                const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
                canvas.width = Math.max(1, Math.floor(vp.width * dpr));
                canvas.height = Math.max(1, Math.floor(vp.height * dpr));
                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                const task = page.render({
                    canvas,
                    canvasContext: ctx,
                    viewport: vp,
                    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
                });
                st.renderTask = task;
                st.renderingScale = scale;
                try {
                    await task.promise;
                    st.renderedScale = scale;
                } catch (err) {
                    if (!(err instanceof pdfjs.RenderingCancelledException)) throw err;
                } finally {
                    st.renderTask = undefined;
                    st.renderingScale = undefined;
                }
                if (docGenRef.current !== gen) return;
            }
            void ensureText(i);
        } catch (err) {
            console.error(`Could not render PDF page ${i + 1}:`, err);
        } finally {
            st.busy = false;
            if (!st.wantRender) {
                clearCanvas(i);
                st.renderedScale = undefined;
            }
        }
    }, [getPage, ensureText, clearCanvas]);

    const ensurePage = useCallback((i: number) => {
        const L = layoutRef.current;
        if (!L) return;
        const st = getState(i);
        st.wantScale = L.scale;
        st.wantRender = true;
        if (st.busy) {
            // Already rendering: if it's producing a stale scale, cancel so the
            // loop re-runs at the right one.
            if (st.renderTask && st.renderingScale !== st.wantScale) st.renderTask.cancel();
            return;
        }
        if (st.renderedScale === st.wantScale) {
            void ensureText(i);
            return;
        }
        void renderLoop(i, st);
    }, [getState, renderLoop, ensureText]);

    const evictPage = useCallback((i: number) => {
        const st = pageStatesRef.current.get(i);
        if (!st || (!st.wantRender && st.renderedScale === undefined)) return;
        st.wantRender = false;
        st.renderTask?.cancel();
        if (!st.busy) {
            clearCanvas(i);
            st.renderedScale = undefined;
        }
    }, [clearCanvas]);

    /** One pass over the viewport: render pages near it, free pages far from
     *  it, and record the current {page, offset} for persistence. */
    const updateWindow = useCallback(() => {
        const el = scrollRef.current;
        const L = layoutRef.current;
        if (!el || !L || !docStateRef.current) return;
        const n = L.pages.length;
        if (n === 0) return;
        const top = el.scrollTop;
        const bottom = top + el.clientHeight;

        let first = 0;
        while (first < n - 1 && L.tops[first] + L.pages[first].h + PAGE_GAP <= top) first++;
        let last = first;
        while (last < n - 1 && L.tops[last + 1] < bottom) last++;

        const renderFrom = Math.max(0, first - RENDER_AHEAD);
        const renderTo = Math.min(n - 1, last + RENDER_AHEAD);
        const keepFrom = Math.max(0, first - EVICT_BEYOND);
        const keepTo = Math.min(n - 1, last + EVICT_BEYOND);
        for (let i = 0; i < n; i++) {
            if (i >= renderFrom && i <= renderTo) ensurePage(i);
            else if (i < keepFrom || i > keepTo) evictPage(i);
        }

        // The position anchor is the top edge: restore sets scrollTop so that
        // the same fraction of the same page sits under it again.
        currentPosRef.current = { page: first, offset: (top - L.tops[first]) / L.pages[first].h };
        schedulePersist();
    }, [ensurePage, evictPage, schedulePersist]);

    const scrollRafRef = useRef(0);
    const scheduleWindowUpdate = useCallback(() => {
        if (scrollRafRef.current) return;
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = 0;
            updateWindow();
        });
    }, [updateWindow]);
    useEffect(() => () => cancelAnimationFrame(scrollRafRef.current), []);

    // Re-anchor whenever geometry changes (first layout, zoom, resize, reload):
    // put the remembered {page, offset} back under the viewport's top edge,
    // then render around it. Layout effect so the restored position paints
    // first — no flash of page 1.
    useLayoutEffect(() => {
        layoutRef.current = layout;
        const el = scrollRef.current;
        if (!layout || !el) return;
        const n = layout.pages.length;
        const pos = currentPosRef.current;
        const page = Math.min(Math.max(0, Math.floor(pos.page)), n - 1);
        el.scrollTop = layout.tops[page] + pos.offset * layout.pages[page].h;
        updateWindow();
    }, [layout, updateWindow]);

    // Build text layers for the whole document (bounded), so ⌘F finds matches
    // on pages that were never scrolled into view. Sequential, with a yield
    // between pages, so it never competes with the visible-page renders.
    useEffect(() => {
        if (!docState || !layout || docState.dims.length > TEXT_EAGER_LIMIT) return;
        let cancelled = false;
        (async () => {
            for (let i = 0; i < docState.dims.length && !cancelled; i++) {
                await ensureText(i);
                await new Promise(r => setTimeout(r, 0));
            }
        })();
        return () => { cancelled = true; };
    }, [docState, layout, ensureText]);

    if (error) {
        return <div className="pdf-pane-message">Could not display this PDF: {error}</div>;
    }

    return (
        <div className="pdf-viewer">
            <div
                className="pdf-viewer-scroll"
                ref={scrollRef}
                onScroll={scheduleWindowUpdate}
                tabIndex={-1}
            >
                {layout && docState ? (
                    <div
                        className="pdf-viewer-inner"
                        style={{
                            padding: `${PAD_V}px 0`,
                            // Drives the text layers' size and font scaling
                            // (pdf.js contract), so zoom never rebuilds them.
                            '--scale-factor': String(layout.scale),
                        } as React.CSSProperties}
                    >
                        {layout.pages.map((p, i) => (
                            <div
                                key={`${docState.gen}:${i}`}
                                className="pdf-viewer-page"
                                style={{ width: p.w, height: p.h, marginBottom: PAGE_GAP }}
                            >
                                <canvas width={0} height={0} ref={el => { canvasElsRef.current[i] = el; }} />
                                <div className="textLayer" ref={el => { textElsRef.current[i] = el; }} />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="pdf-pane-message">Loading PDF…</div>
                )}
            </div>
            {layout && (
                <div className="pdf-viewer-zoom">
                    <button onClick={() => setZoom(z => clampZoom(z / 1.2))} title="Zoom out" aria-label="Zoom out">−</button>
                    <button onClick={() => setZoom(clampZoom(1))} title="Reset to fit width" aria-label="Reset zoom">
                        {Math.round(zoom * 100)}%
                    </button>
                    <button onClick={() => setZoom(z => clampZoom(z * 1.2))} title="Zoom in" aria-label="Zoom in">+</button>
                </div>
            )}
        </div>
    );
}

// Memoized: the parent re-renders on every keystroke anywhere in the app, but
// this only needs to re-render when its document or its own state changes.
export default React.memo(PdfViewer);
