import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readRecord, flushRecord } from '../utils/storage';
import { readPageLinks, resolveDestination } from '../utils/pdfLinks';
import type { PdfLink, PdfLinkTarget } from '../utils/pdfLinks';

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
 * - The PDF's own links work: a table of contents jumps to its chapter, an
 *   external URL opens in a new tab (see utils/pdfLinks.ts).
 * - The current page is shown, and can be typed into to jump.
 *
 * Memory discipline: canvas BITMAPS are the expensive part (a page at 2x DPR is
 * ~10MB), so only pages near the viewport hold one — scrolled-away canvases are
 * freed (width=0) and re-rendered on approach. Text and link layers are cheap
 * DOM and are kept once built.
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
    /** True while this viewer's tab is in front. Gates the +/- zoom keys —
     *  several viewers stay mounted (hidden) at once, and only the visible
     *  one may respond to the keyboard. */
    isActive: boolean;
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
    /** True once this page's pdf.js state has been released (see cleanupPage);
     *  cleared when it re-enters the render window. */
    cleaned?: boolean;
    textStarted?: boolean;
    textPromise?: Promise<void>;
    linksStarted?: boolean;
    linksPromise?: Promise<void>;
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
/**
 * Release a page's pdf.js state (parsed operator list + decoded images) once it
 * is this far out of view.
 *
 * Deliberately much wider than EVICT_BEYOND. Freeing the canvas is cheap to
 * undo — the bitmap is redrawn from an operator list pdf.js still holds — but
 * cleanup() throws that list away too, so coming back costs a worker round-trip
 * to re-parse the page. At 3 pages that would tax ordinary back-scrolling; at 12
 * it only touches pages the reader has genuinely left behind.
 */
const CLEANUP_BEYOND = 12;
/** Build text layers for the whole document up to this page count, so ⌘F can
 *  find text anywhere. Beyond it (rare, book-sized), text follows the canvas
 *  window instead of bloating the DOM with hundreds of thousands of spans. */
const TEXT_EAGER_LIMIT = 300;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;

// Rounded finely (not to 2dp): a pinch step near MIN_ZOOM is ~0.4%, and a
// coarser rounding would swallow it and leave the gesture stuck.
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10000) / 10000));

/** One-shot scroll anchor for a zoom step: keep the document point
 *  {page, frac, fracX} under the same viewport point {vx, vy} — i.e. the spot
 *  under the cursor stays put while everything scales around it. */
interface ZoomAnchor {
    page: number;
    frac: number;
    vy: number;
    fracX: number;
    vx: number;
}

/** A pinch (ctrl+wheel burst) in flight. While it lasts, zoom is a pure CSS
 *  transform on the page column — compositor work, no relayout — and only
 *  when it settles does the accumulated factor commit to a real layout. */
interface PinchGesture {
    /** Accumulated scale factor relative to the committed layout. */
    k: number;
    /** The pinned point in content coordinates (= the transform-origin). */
    originX: number;
    originY: number;
    /** Where that point sits in the viewport (scroller-relative). */
    vx: number;
    vy: number;
    timer: number | null;
}

function PdfViewer({ filePath, data, isActive }: PdfViewerProps) {
    // Read once per mount: where this file was last left, and at what zoom.
    const [saved] = useState<PdfViewPos | undefined>(
        () => readRecord<PdfViewPos>(STORAGE_KEY)[filePath]
    );
    const [zoom, setZoom] = useState<number>(() => clampZoom(saved?.zoom ?? 1));
    const [docState, setDocState] = useState<DocState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
    const gestureRef = useRef<PinchGesture | null>(null);
    const canvasElsRef = useRef<Array<HTMLCanvasElement | null>>([]);
    const textElsRef = useRef<Array<HTMLDivElement | null>>([]);
    const linkElsRef = useRef<Array<HTMLDivElement | null>>([]);
    /** Uncontrolled on purpose: the page number is written straight into the
     *  input on every scroll pass. Holding it in React state would re-render the
     *  whole page column each time the top edge crossed a page boundary. */
    const pageInputRef = useRef<HTMLInputElement | null>(null);
    /** What the box read the moment it took focus. While it is focused the
     *  scroll pass deliberately leaves it alone, so its number goes stale as
     *  soon as the user scrolls — and the blur path must not treat that stale
     *  number as something they asked for. */
    const pageInputFocusValueRef = useRef('');
    /** The 0-based page the box is displaying. Usually the page under the top
     *  edge, but not at the document's bottom — see updateWindow. */
    const shownPageRef = useRef(0);
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
        // The record is held parsed in memory — mutate and write, no re-parse.
        const all = readRecord<PdfViewPos>(STORAGE_KEY);
        const { page, offset } = currentPosRef.current;
        all[filePath] = { page, offset: Math.round(offset * 1000) / 1000, zoom: zoomRef.current };
        flushRecord(STORAGE_KEY);
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
                linkElsRef.current = [];
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
        return { gen: docState.gen, scale, pages, tops, maxPageW: maxW * scale };
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

    /**
     * Put a page under the viewport's top edge — the one way to move to a page,
     * shared by the page-number box and by link destinations.
     *
     * @param offset how far into the page to land, in scale-1 page units.
     *
     * Deliberately does NOT call updateWindow: the scroll it causes fires the
     * container's own handler a frame later, which renders the newly-visible
     * pages and refreshes the page number. Calling it here instead would make
     * this depend on updateWindow — and updateWindow already (transitively)
     * depends on the link layer, which depends on this.
     */
    const scrollToPage = useCallback((pageIndex: number, offset = 0) => {
        const el = scrollRef.current;
        const L = layoutRef.current;
        if (!el || !L || L.pages.length === 0) return;
        const i = Math.min(Math.max(0, pageIndex), L.pages.length - 1);
        // ROUNDED UP, and never down. Page tops are fractional (page height ×
        // a fit-width scale) but the browser snaps scrollTop to whole device
        // pixels — so asking for tops[i] can land a fraction of a pixel ABOVE
        // page i, where "which page is under the top edge" still answers i-1.
        // Jumping to page 9 would then leave the box reading 8.
        el.scrollTop = Math.ceil(L.tops[i] + offset * L.scale);
    }, []);

    /** Act on a clicked link: jump to its destination, or run its named action.
     *  External URLs are excluded by the type — those are plain <a href>
     *  elements, and the browser opens them without our help. */
    const followLink = useCallback(async (target: Exclude<PdfLinkTarget, { kind: 'url' }>) => {
        const doc = docStateRef.current?.doc;
        const L = layoutRef.current;
        if (!doc || !L) return;
        try {
            if (target.kind === 'action') {
                const page = currentPosRef.current.page;
                switch (target.action) {
                    case 'FirstPage': scrollToPage(0); break;
                    case 'LastPage': scrollToPage(L.pages.length - 1); break;
                    case 'NextPage': scrollToPage(page + 1); break;
                    case 'PrevPage': scrollToPage(page - 1); break;
                    // GoBack/GoForward and the rest are viewer-history actions
                    // this viewer has no equivalent for — ignore rather than
                    // guess at something surprising.
                    default: break;
                }
                return;
            }
            const dest = await resolveDestination(doc, target.dest, getPage);
            if (dest) scrollToPage(dest.pageIndex, dest.offset);
        } catch (err) {
            console.error('Could not follow this PDF link:', err);
        }
    }, [getPage, scrollToPage]);

    /** One clickable element for one link box. An external URL is a real <a> so
     *  it gets the browser's own affordances (middle-click, copy link address);
     *  an in-document jump is a <button>, which is focusable and keyboard-
     *  activatable without inventing a URL for a destination that has none. */
    const createLinkElement = useCallback((link: PdfLink): HTMLElement => {
        let el: HTMLElement;
        if (link.target.kind === 'url') {
            const anchor = document.createElement('a');
            anchor.href = link.target.url;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            el = anchor;
        } else {
            const button = document.createElement('button');
            button.type = 'button';
            // The box is empty (the words it covers belong to the text layer),
            // so without this it reads as an unnamed button. Not `title`: a
            // tooltip on every entry of a table of contents is just noise.
            button.setAttribute('aria-label', 'Follow link');
            const { target } = link;
            button.addEventListener('click', () => { void followLink(target); });
            el = button;
        }
        el.className = 'pdf-link';
        if (link.title) el.title = link.title;
        el.style.left = `${link.left}%`;
        el.style.top = `${link.top}%`;
        el.style.width = `${link.width}%`;
        el.style.height = `${link.height}%`;
        return el;
    }, [followLink]);

    /** Build the clickable-link overlay for one page. Like the text layer, the
     *  geometry is in page-percentages, so it is built ONCE per page and every
     *  zoom rescales it for free. */
    const ensureLinks = useCallback((i: number): Promise<void> => {
        const st = getState(i);
        if (st.linksStarted) return st.linksPromise ?? Promise.resolve();
        const container = linkElsRef.current[i];
        if (!container || !docStateRef.current) return Promise.resolve();
        st.linksStarted = true;
        const gen = docGenRef.current;
        st.linksPromise = (async () => {
            try {
                const links = await readPageLinks(await getPage(i));
                if (docGenRef.current !== gen || linkElsRef.current[i] !== container) return;
                for (const link of links) container.append(createLinkElement(link));
            } catch (err) {
                console.error(`Could not read the links on PDF page ${i + 1}:`, err);
            }
        })();
        return st.linksPromise;
    }, [getState, getPage, createLinkElement]);

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
            void ensureLinks(i);
        } catch (err) {
            console.error(`Could not render PDF page ${i + 1}:`, err);
        } finally {
            st.busy = false;
            if (!st.wantRender) {
                clearCanvas(i);
                st.renderedScale = undefined;
            }
        }
    }, [getPage, ensureText, ensureLinks, clearCanvas]);

    const ensurePage = useCallback((i: number) => {
        const L = layoutRef.current;
        if (!L) return;
        const st = getState(i);
        st.wantScale = L.scale;
        st.wantRender = true;
        // Back in the window — eligible to be released again once it leaves.
        st.cleaned = false;
        if (st.busy) {
            // Already rendering: if it's producing a stale scale, cancel so the
            // loop re-runs at the right one.
            if (st.renderTask && st.renderingScale !== st.wantScale) st.renderTask.cancel();
            return;
        }
        if (st.renderedScale === st.wantScale) {
            void ensureText(i);
            void ensureLinks(i);
            return;
        }
        void renderLoop(i, st);
    }, [getState, renderLoop, ensureText, ensureLinks]);

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

    /**
     * Hand a far-away page's memory back to pdf.js.
     *
     * Freeing the canvas is only half of what a page costs: the PDFPageProxy
     * keeps its parsed operator list and its decoded images (a full-page scan is
     * tens of MB) until asked, and every page ever scrolled past kept both for
     * the life of the document. This is exactly what pdf.js's own viewer does in
     * PDFPageView.destroy().
     *
     * cleanup() self-guards — it no-ops while a render task is live or the
     * operator list is still streaming — so it can't interrupt a paint, and it
     * touches nothing the already-built text or link layers depend on.
     */
    const cleanupPage = useCallback((i: number) => {
        const st = pageStatesRef.current.get(i);
        if (!st || !st.pagePromise || st.cleaned || st.busy || st.wantRender) return;
        const gen = docGenRef.current;
        st.cleaned = true;
        void st.pagePromise.then(page => {
            // The window pass may have asked for this page back while we awaited.
            if (docGenRef.current !== gen || st.busy || st.wantRender) return;
            page.cleanup();
        }).catch(() => { /* teardown races — nothing to release */ });
    }, []);

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
        const cleanFrom = Math.max(0, first - CLEANUP_BEYOND);
        const cleanTo = Math.min(n - 1, last + CLEANUP_BEYOND);
        for (let i = 0; i < n; i++) {
            if (i >= renderFrom && i <= renderTo) ensurePage(i);
            else {
                if (i < keepFrom || i > keepTo) evictPage(i);
                if (i < cleanFrom || i > cleanTo) cleanupPage(i);
            }
        }

        // The position anchor is the top edge: restore sets scrollTop so that
        // the same fraction of the same page sits under it again.
        currentPosRef.current = { page: first, offset: (top - L.tops[first]) / L.pages[first].h };
        // The page SHOWN is the one under the top edge, except at the very
        // bottom of the document: a short final page plus padding may not fill
        // the viewport, so its top can never reach the top edge. Without this,
        // typing the last page number scrolls as far as it can and the box then
        // snaps back to the page before it.
        const maxScroll = el.scrollHeight - el.clientHeight;
        const shown = maxScroll > 1 && top >= maxScroll - 1 ? last : first;
        shownPageRef.current = shown;
        // Written straight to the DOM rather than through state — see
        // pageInputRef. Never while it's focused: that would fight the typing.
        const input = pageInputRef.current;
        if (input && document.activeElement !== input) input.value = String(shown + 1);
        schedulePersist();
    }, [ensurePage, evictPage, cleanupPage, schedulePersist]);

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
    // first — no flash of page 1. A pinch/ctrl-wheel zoom leaves a one-shot
    // cursor anchor instead, so the point under the pointer stays put.
    useLayoutEffect(() => {
        layoutRef.current = layout;
        const el = scrollRef.current;
        // A pinch commit's transform is cleared HERE, pre-paint and in the same
        // frame the new layout lands, so there is never a visible snap between
        // the transformed old layout and the committed new one. Any gesture
        // still marked in-flight at this point was overtaken by another layout
        // change (pill click, resize) — drop it.
        if (innerRef.current) {
            innerRef.current.style.transform = '';
            innerRef.current.style.transformOrigin = '';
        }
        if (gestureRef.current) {
            if (gestureRef.current.timer !== null) clearTimeout(gestureRef.current.timer);
            gestureRef.current = null;
        }
        if (!layout || !el) return;
        const n = layout.pages.length;
        const anchor = zoomAnchorRef.current;
        zoomAnchorRef.current = null;
        if (anchor) {
            const page = Math.min(Math.max(0, anchor.page), n - 1);
            el.scrollTop = layout.tops[page] + anchor.frac * layout.pages[page].h - anchor.vy;
            // Pages are centered in the inner column; anchor horizontally too
            // so zooming into a page edge doesn't slide it away.
            const innerW = Math.max(el.clientWidth, layout.maxPageW);
            const pageLeft = (innerW - layout.pages[page].w) / 2;
            el.scrollLeft = pageLeft + anchor.fracX * layout.pages[page].w - anchor.vx;
        } else {
            const pos = currentPosRef.current;
            const page = Math.min(Math.max(0, Math.floor(pos.page)), n - 1);
            // Rounded up for the same reason as scrollToPage: landing a
            // fraction of a pixel short would re-read as the previous page,
            // and that reading is what gets persisted for next time.
            el.scrollTop = Math.ceil(layout.tops[page] + pos.offset * layout.pages[page].h);
        }
        updateWindow();
    }, [layout, updateWindow]);

    /** One zoom step, anchored at the viewport top edge — the pill buttons and
     *  the +/- keys share this so they behave identically. */
    const nudgeZoom = useCallback((factor: number) => {
        setZoom(z => clampZoom(z * factor));
    }, []);

    /** Show whatever page the document is actually on — used to undo a typed
     *  number that was abandoned or nonsense. */
    const resetPageInput = useCallback(() => {
        const input = pageInputRef.current;
        if (input) input.value = String(shownPageRef.current + 1);
    }, []);

    /**
     * Jump to the typed page. Out-of-range numbers are clamped rather than
     * rejected — "999" in a 40-page document plainly means "the end".
     *
     * @param onlyIfChanged for the blur path. Clicking into the box and back
     *        out must leave the view alone — and "unchanged" is measured
     *        against what the box read when it took focus, NOT against the page
     *        currently on screen: scrolling while the box is focused leaves it
     *        showing a stale number, and committing that would yank the view
     *        back to wherever the user was when they clicked in. Enter passes
     *        false, so re-typing the current page IS a way to jump to its top.
     */
    const commitPageInput = useCallback((onlyIfChanged = false) => {
        const input = pageInputRef.current;
        const total = layoutRef.current?.pages.length ?? 0;
        if (!input || total === 0) return;
        if (onlyIfChanged && input.value === pageInputFocusValueRef.current) {
            resetPageInput();       // nothing was typed — just re-sync the box
            return;
        }
        const typed = parseInt(input.value.trim(), 10);
        if (!Number.isFinite(typed)) {
            resetPageInput();
            return;
        }
        const page = Math.min(Math.max(1, typed), total);
        if (onlyIfChanged && page === shownPageRef.current + 1) {
            resetPageInput();       // undoes a clamp the user can't have meant
            return;
        }
        scrollToPage(page - 1);
        // Record the DISPLAYED page now rather than waiting for the scroll pass
        // a frame later: a blur landing in between (Enter blurs the box itself)
        // would otherwise redisplay the page we just left. Only this ref, never
        // currentPosRef — that one anchors persistence and is written from the
        // scroll we actually got, which is not always the one we asked for (the
        // browser clamps at the end of the document).
        shownPageRef.current = page - 1;
        input.value = String(page);
        pageInputFocusValueRef.current = input.value;
    }, [scrollToPage, resetPageInput]);

    const handlePageInputBlur = useCallback(() => commitPageInput(true), [commitPageInput]);

    const handlePageInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        // Never let a page number reach the app's shortcuts (or this viewer's
        // own +/- zoom keys, which ignore inputs but not every key does).
        e.stopPropagation();
        if (e.key === 'Enter') {
            commitPageInput();
            // Hand the keyboard back so scrolling and the zoom keys work again.
            e.currentTarget.blur();
        } else if (e.key === 'Escape') {
            resetPageInput();
            e.currentTarget.blur();
        }
    }, [commitPageInput, resetPageInput]);

    /** Land the accumulated pinch factor as a real zoom commit: one relayout,
     *  one window re-render — instead of one per wheel event, which is what
     *  made pinching stutter (every tick relaid out every page, restyled every
     *  text-layer span and restarted the visible pdf.js rasterizations). */
    const commitGesture = useCallback(() => {
        const g = gestureRef.current;
        gestureRef.current = null;
        if (!g) return;
        if (g.timer !== null) clearTimeout(g.timer);
        const el = scrollRef.current;
        const L = layoutRef.current;
        const inner = innerRef.current;
        // Nothing to commit (or nowhere to commit it): drop the transform now.
        if (!el || !L || !inner || Math.abs(g.k - 1) < 0.001) {
            if (inner) {
                inner.style.transform = '';
                inner.style.transformOrigin = '';
            }
            return;
        }
        // Whatever now sits under the gesture's viewport point must stay there
        // after the commit. Under transform scale(k) with origin O, the visual
        // position of content point q is O + (q − O)·k − scroll, so invert:
        const qY = g.originY + (el.scrollTop + g.vy - g.originY) / g.k;
        const qX = g.originX + (el.scrollLeft + g.vx - g.originX) / g.k;
        const n = L.pages.length;
        let page = 0;
        while (page < n - 1 && L.tops[page] + L.pages[page].h + PAGE_GAP <= qY) page++;
        const frac = (qY - L.tops[page]) / L.pages[page].h;
        const innerW = Math.max(el.clientWidth, L.maxPageW);
        const pageLeft = (innerW - L.pages[page].w) / 2;
        const fracX = (qX - pageLeft) / L.pages[page].w;
        zoomAnchorRef.current = { page, frac, vy: g.vy, fracX, vx: g.vx };
        // The layout effect clears the transform in the same pre-paint pass
        // that applies the new sizes, so the handoff never flashes.
        setZoom(z => clampZoom(z * g.k));
    }, []);

    // Trackpad pinches arrive as wheel events with ctrlKey set (the browser
    // convention, also produced by ctrl/⌃ + a mouse wheel). Zoom the DOCUMENT,
    // not the app: preventDefault stops the browser's own page zoom, which
    // needs a NATIVE non-passive listener — React's synthetic onWheel can't
    // guarantee that. Plain (ctrl-less) wheels fall through to normal scrolling.
    //
    // While the pinch is in flight the zoom is only a CSS transform pinned at
    // the cursor (transform-origin = the point under it), which the compositor
    // applies for free; the expensive relayout + re-rasterization happens once,
    // when the burst goes quiet for SETTLE_MS.
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const SETTLE_MS = 180;
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const el = scrollRef.current;
            const L = layoutRef.current;
            const inner = innerRef.current;
            if (!el || !L || !inner || L.pages.length === 0) return;

            let g = gestureRef.current;
            if (!g) {
                // Pin the content point under the cursor for the whole gesture
                // (moving the origin mid-gesture would make the view jump).
                const rect = el.getBoundingClientRect();
                const vx = e.clientX - rect.left;
                const vy = e.clientY - rect.top;
                g = gestureRef.current = {
                    k: 1,
                    originX: el.scrollLeft + vx,
                    originY: el.scrollTop + vy,
                    vx,
                    vy,
                    timer: null,
                };
                inner.style.transformOrigin = `${g.originX}px ${g.originY}px`;
            }

            // Pinch deltas are small pixel increments; a discrete mouse-wheel
            // notch is ±100+. Clamp so one notch can't triple the scale, and
            // clamp the TARGET so the transform never overshoots MIN/MAX zoom.
            const d = Math.max(-50, Math.min(50, e.deltaY));
            const target = clampZoom(zoomRef.current * g.k * Math.exp(-d * 0.01));
            g.k = target / zoomRef.current;
            inner.style.transform = `scale(${g.k})`;

            if (g.timer !== null) clearTimeout(g.timer);
            g.timer = window.setTimeout(commitGesture, SETTLE_MS);
        };
        root.addEventListener('wheel', onWheel, { passive: false });
        return () => root.removeEventListener('wheel', onWheel);
    }, [commitGesture]);

    // +/- (and =, its unshifted key) step the zoom exactly like the pill
    // buttons — but only for the front tab's viewer, never while typing in an
    // input/editor, and never with modifiers held (⌘± stays browser zoom).
    useEffect(() => {
        if (!isActive) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                nudgeZoom(1.2);
            } else if (e.key === '-') {
                e.preventDefault();
                nudgeZoom(1 / 1.2);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isActive, nudgeZoom]);

    // A drag that starts on the page is a text selection, and must be able to
    // sweep straight across a link instead of stopping dead at its edge. Links
    // sit above the text layer (they'd never be clickable otherwise), so the
    // drag has to switch them off for its duration — the same trick pdf.js's
    // own viewer uses. A drag that STARTS on a link is a click, and is left
    // alone. Plain DOM listeners: this must not re-render anything.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onPointerDown = (e: PointerEvent) => {
            if (!(e.target as Element | null)?.closest?.('.pdf-link')) el.classList.add('pdf-selecting');
        };
        const onPointerUp = () => el.classList.remove('pdf-selecting');
        el.addEventListener('pointerdown', onPointerDown);
        // On the window, not the container: a drag routinely ends outside it.
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            el.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
    }, []);

    // Build text layers for the whole document (bounded), so ⌘F finds matches
    // on pages that were never scrolled into view. Sequential, with a yield
    // between pages, so it never competes with the visible-page renders.
    // Keyed on WHETHER a layout exists, never on the layout itself: `layout` is a
    // fresh object on every zoom step and every container resize, which cancelled
    // and restarted this 300-iteration pass (and its 300 setTimeout yields) each
    // time. ensureText is idempotent so nothing was rebuilt, but a single pinch
    // commit scheduled hundreds of pointless macrotasks. This boolean flips false
    // → true once per document and then stays put.
    const hasLayout = layout !== null;
    useEffect(() => {
        if (!docState || !hasLayout || docState.dims.length > TEXT_EAGER_LIMIT) return;
        let cancelled = false;
        (async () => {
            for (let i = 0; i < docState.dims.length && !cancelled; i++) {
                await ensureText(i);
                await new Promise(r => setTimeout(r, 0));
            }
        })();
        return () => { cancelled = true; };
    }, [docState, hasLayout, ensureText]);

    if (error) {
        return (
            <div className="pdf-viewer" ref={rootRef}>
                <div className="pdf-pane-message">Could not display this PDF: {error}</div>
            </div>
        );
    }

    return (
        <div className="pdf-viewer" ref={rootRef}>
            <div
                className="pdf-viewer-scroll"
                ref={scrollRef}
                onScroll={scheduleWindowUpdate}
                tabIndex={-1}
            >
                {layout && docState ? (
                    <div
                        ref={innerRef}
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
                                {/* Above the text layer, or its links could
                                    never be clicked; see .pdf-selecting. */}
                                <div className="pdf-link-layer" ref={el => { linkElsRef.current[i] = el; }} />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="pdf-pane-message">Loading PDF…</div>
                )}
            </div>
            {layout && (
                <div className="pdf-viewer-controls">
                    <div className="pdf-viewer-pill pdf-viewer-pages">
                        <input
                            ref={pageInputRef}
                            className="pdf-viewer-page-input"
                            // Not type="number": the spinner arrows are far too
                            // heavy for a control this size. inputMode still
                            // gets the numeric keypad on touch.
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                            // Sized to the document's widest page number, so the
                            // pill never resizes as you scroll past page 9 —
                            // but never below two digits, or a short document
                            // would give you a slot too cramped to type in.
                            style={{ width: `${Math.max(2, String(layout.pages.length).length)}ch` }}
                            title="Current page — type a number and press Enter to jump"
                            aria-label="Page number"
                            onFocus={e => {
                                pageInputFocusValueRef.current = e.currentTarget.value;
                                e.currentTarget.select();
                            }}
                            onKeyDown={handlePageInputKeyDown}
                            onBlur={handlePageInputBlur}
                        />
                        <span className="pdf-viewer-page-total">/ {layout.pages.length}</span>
                    </div>
                    <div className="pdf-viewer-pill pdf-viewer-zoom">
                        <button onClick={() => nudgeZoom(1 / 1.2)} title="Zoom out (-)" aria-label="Zoom out">−</button>
                        <button onClick={() => setZoom(clampZoom(1))} title="Reset to fit width" aria-label="Reset zoom">
                            {Math.round(zoom * 100)}%
                        </button>
                        <button onClick={() => nudgeZoom(1.2)} title="Zoom in (+)" aria-label="Zoom in">+</button>
                    </div>
                </div>
            )}
        </div>
    );
}

// Memoized: the parent re-renders on every keystroke anywhere in the app, but
// this only needs to re-render when its document or its own state changes.
export default React.memo(PdfViewer);
