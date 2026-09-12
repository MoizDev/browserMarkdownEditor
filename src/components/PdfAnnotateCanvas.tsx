import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tldraw, getSnapshot, AssetRecordType, createShapeId, Box, inlineBase64AssetStore } from 'tldraw';
import type { Editor, TLAssetId, TLAssetStore, TLEditorSnapshot, TLImageShape, TLShapeId } from 'tldraw';
import 'tldraw/tldraw.css';
import { pageLayout, openPdfPages, PAGE_RENDER_SCALE, type PdfPageSize, type PdfPageSource } from '../utils/pdfAnnotation';
import { setPdfRenderData } from '../utils/pdfRenderCache';
import { isEmptyOverlay, type PageOverlay } from '../utils/pdfOverlay';
import { svgToVectorOps } from '../utils/pdfVector';
import { CANVAS_COMPONENTS, CANVAS_SHAPE_UTILS, applyCanvasUi, applyPenDefaults, readCanvasUi, type CanvasUiState } from './canvasPen';

interface PdfAnnotateCanvasProps {
    filePath: string;
    /** Pristine original PDF bytes (never the stamped ones — see pdfAnnotation.ts). */
    original: Uint8Array;
    /** Serialized tldraw snapshot of existing annotations, '' if none yet. */
    snapshot: string;
    /** Path-explicit: a debounced save can land after a tab switch. */
    onContentChange: (path: string, content: string) => void;
    /** Same, but writes to disk immediately — used when the canvas is going away. */
    onFlushNow: (path: string, content: string) => void;
    /**
     * Called synchronously as the canvas unmounts with strokes still to write.
     * Exporting them takes a moment, and until it does the tab isn't marked
     * dirty — so without this signal the viewer would briefly show the PDF as it
     * was BEFORE those strokes.
     */
    onFlushStart: () => void;
}

/**
 * ANNOTATING A PDF IS ALWAYS A LIGHT-MODE JOB, whatever theme the app is in.
 *
 * tldraw resolves a shape's colour NAME through the active theme at render time,
 * and its dark theme maps 'black' to #f2f2f2 — near-white. The backdrop here is
 * the real page, which is white in either theme, so following the app's theme
 * put near-white ink on a white page: invisible on screen, and stamped that way
 * into the saved PDF, where it stayed invisible in every other viewer too.
 *
 * The files are unharmed — a snapshot stores 'black', not a hex value, so
 * strokes drawn in dark mode reappear correctly once this is pinned. A .tldraw
 * whiteboard is the opposite case and rightly still follows the theme: it draws
 * its own background, so it has no white page to contrast against.
 */
const ANNOTATE_COLOR_SCHEME = 'light';

/**
 * Shape types that cannot become paths in the saved PDF, so their pages carry a
 * bitmap overlay as well.
 *
 * A DENY list, not an allow list, and deliberately so: an unfamiliar shape type
 * is tried as vector first, and `svgToVectorOps` rejecting the export is the
 * real gate — it returns null for anything it cannot draw exactly (embedded
 * fonts, <pattern> fills, clip paths), which sends the page down this same
 * raster route. So the list is a fast path for the obvious cases, and being
 * wrong about a new tldraw shape type costs correctness nothing.
 */
const RASTER_ONLY_SHAPES = new Set(['text', 'note', 'image', 'video', 'bookmark', 'embed']);

/**
 * Deliberately far longer than DrawingPane's 400ms.
 *
 * A drawing's save is a JSON.stringify. A PDF's save rasterizes every annotated
 * page and then rebuilds the entire document — tens to hundreds of milliseconds
 * on the main thread, which is the same thread the pen is drawing on. At 400ms
 * an ordinary pause to think fires a full export, so the next stroke stutters.
 *
 * 1.5s idle means the export lands between thoughts rather than between strokes.
 * The app's own 1s save debounce then follows, so a stroke reaches disk ~2.5s
 * after you stop — still well inside the "close the tab and it's saved" flush.
 */
const SERIALIZE_DEBOUNCE_MS = 1500;

/* ── Keeping the backdrop sharp when you zoom in ──────────────────────────
 *
 * A page is a rasterized image, so at 400% a 2x backdrop is showing each of its
 * pixels four screen pixels wide and the text under your pen goes to mush —
 * while the ink drawn over it, being vector, stays perfectly crisp. The mismatch
 * is what makes it look broken rather than merely soft.
 *
 * pdf.js cannot help here: its SVG backend was removed in v4, so there is no
 * resolution-independent page to fall back on. Re-rasterizing is the only
 * answer, and it is bounded to the pages you can actually SEE — every page of
 * the document is held at PAGE_RENDER_SCALE for the canvas's whole life, so
 * refining all of them would multiply the largest memory item in the pane by the
 * square of the zoom.
 * ───────────────────────────────────────────────────────────────────────── */

/** How sharp a page may get. 6x a Letter page is ~3670x4750 — around 70MB
 *  decoded, which is why this is a hard ceiling and not a function of zoom. */
const MAX_PAGE_SCALE = 6;

/** Re-render only in whole steps, so a slow pinch doesn't re-rasterize every
 *  visible page at 2.1x, then 2.2x, then 2.3x. */
const PAGE_SCALE_STEP = 1;

/** Long enough that a pinch or a wheel burst refines once, at the scale it
 *  settles on, rather than at every value it passed through. */
const REFINE_DEBOUNCE_MS = 350;

/** One page's rasterized backdrop, and how sharp it currently is. */
interface PageImage {
    url: string;
    scale: number;
}

/**
 * Tell tldraw an asset's image changed.
 *
 * `mergeRemoteChanges` marks the edit as 'remote', so the 'user'-scoped save
 * listener ignores it — without that, merely opening a file (or zooming in on
 * one) would mark the tab dirty and rewrite the PDF. The bumped `rev` is what
 * makes the asset record actually differ, so the resolver is asked again.
 */
function refreshPageAsset(editor: Editor | null, index: number): void {
    if (!editor) return;
    const assetId = AssetRecordType.createId(`pdf-page-${index}`);
    const asset = editor.getAsset(assetId);
    if (!asset) return;
    editor.store.mergeRemoteChanges(() => {
        editor.updateAssets([{
            ...asset,
            meta: { ...asset.meta, pdfPage: index, rev: (Number(asset.meta?.rev) || 0) + 1 },
        }]);
    });
}

/**
 * The snapshot embedded in an annotated PDF, plus the `ui` block beside it.
 *
 * tldraw's snapshots carry no styles at all (see CanvasUiState), so without
 * this an annotated PDF reopened with the default colour and width however it
 * was left — unlike a drawing or a notebook, which have always saved theirs.
 * A file written before this block existed simply yields `ui: undefined`.
 */
function parseSnapshot(content: string): { snapshot?: TLEditorSnapshot; ui?: CanvasUiState } {
    if (!content.trim()) return {};
    try {
        const { ui, ...snapshot } = JSON.parse(content) as TLEditorSnapshot & { ui?: CanvasUiState };
        return { snapshot: 'document' in snapshot ? snapshot as TLEditorSnapshot : undefined, ui };
    } catch (err) {
        console.error('Could not parse PDF annotations (leaving the file untouched):', err);
        return {};
    }
}

/**
 * The annotate half of a PDF: pages rasterized onto the canvas as locked image
 * shapes, with tldraw's normal tools on top.
 *
 * The pages are backdrop, not content — locked so a stray drag can't shift a
 * page out from under its annotations, and excluded from the exported overlay
 * so a save stamps only the strokes.
 */
export default function PdfAnnotateCanvas({ filePath, original, snapshot, onContentChange, onFlushNow, onFlushStart }: PdfAnnotateCanvasProps) {
    // Geometry only. The canvas mounts as soon as this lands; the page images
    // stream in afterwards through pageImagesRef.
    const [pages, setPages] = useState<PdfPageSize[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const onContentChangeRef = useRef(onContentChange);
    useEffect(() => { onContentChangeRef.current = onContentChange; }, [onContentChange]);
    const onFlushNowRef = useRef(onFlushNow);
    useEffect(() => { onFlushNowRef.current = onFlushNow; }, [onFlushNow]);
    const onFlushStartRef = useRef(onFlushStart);
    useEffect(() => { onFlushStartRef.current = onFlushStart; }, [onFlushStart]);

    // Parsed once, on mount. `snapshot` churns as saves round-trip, but tldraw
    // owns the document from mount on, so re-reading it would be pointless work
    // (and could clobber in-progress strokes). PdfPane keys this component on
    // the file path, so a different file means a fresh mount and a fresh parse.
    const [parsed] = useState(() => parseSnapshot(snapshot));
    const uiRef = useRef<CanvasUiState | undefined>(parsed.ui);
    const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Page images as they arrive, by page index. Read by the asset store. */
    const pageImagesRef = useRef<Array<PageImage | undefined>>([]);
    /** The open document, so a zoomed-in page can be re-rendered sharper. */
    const sourceRef = useRef<PdfPageSource | null>(null);
    /** The live editor, so streamed pages can refresh their assets. */
    const editorRef = useRef<Editor | null>(null);
    /** Shape ids of the page backdrops — never exported, never saved as strokes. */
    const pageShapeIdsRef = useRef<Set<TLShapeId>>(new Set());
    /** Last exported overlay per page index, keyed by that page's shape signature. */
    const overlayCacheRef = useRef<Map<number, { signature: string; overlay: PageOverlay | undefined }>>(new Map());
    /** Whether the user has drawn anything not yet handed to the save path. */
    const hasUnsavedRef = useRef(false);

    /**
     * Page images are resolved at render time rather than stored.
     *
     * tldraw validates `asset.props.src` and rejects blob: outright ("invalid
     * protocol" — it allows only http/https/data/asset). data: would pass, but
     * assets are serialized into the snapshot, and that snapshot is embedded in
     * the PDF — so base64 page images would add megabytes to every save.
     *
     * Instead the snapshot stores a stable `asset:pdf-page-N` reference and this
     * resolver hands back the current session's blob URL. Cheap on disk, and the
     * reference can't go stale across sessions the way a blob URL does.
     */
    const assetStore = useMemo<TLAssetStore>(() => ({
        upload: inlineBase64AssetStore.upload,     // images the user pastes in
        resolve(asset, ctx) {
            const page = asset.meta?.pdfPage;
            // null while this page is still rasterizing — it renders blank at the
            // right size, and refreshes when its image arrives.
            if (typeof page === 'number') return pageImagesRef.current[page]?.url ?? null;
            return inlineBase64AssetStore.resolve?.(asset, ctx) ?? asset.props.src;
        },
    }), []);

    // Open the PDF and stream its pages in. Always the pristine original:
    // rendering the stamped pages would show baked-in strokes behind their own
    // editable copies.
    useEffect(() => {
        let cancelled = false;
        const images: Array<PageImage | undefined> = [];
        let source: PdfPageSource | null = null;

        (async () => {
            try {
                source = await openPdfPages(original);
                if (cancelled) { await source.close(); return; }

                // Geometry is enough to lay out and mount the canvas — no need to
                // wait on a single pixel. Set the ref before the state: <Tldraw>
                // mounts the moment `pages` is non-null and immediately asks the
                // asset store to resolve page URLs through this ref.
                pageImagesRef.current = images;
                sourceRef.current = source;
                setPages(source.sizes);

                for (let i = 0; i < source.sizes.length; i++) {
                    const url = await source.renderPage(i);
                    if (cancelled) { URL.revokeObjectURL(url); return; }
                    images[i] = { url, scale: PAGE_RENDER_SCALE };
                    refreshPageAsset(editorRef.current, i);
                }
            } catch (err) {
                console.error('Could not render PDF pages:', err);
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            }
        })();

        return () => {
            cancelled = true;
            pageImagesRef.current = [];
            sourceRef.current = null;
            for (const image of images) if (image) URL.revokeObjectURL(image.url);
            void source?.close();
        };
    }, [original]);

    const handleMount = useCallback((editor: Editor) => {
        if (!pages) return;
        editorRef.current = editor;
        const boxes = pageLayout(pages);

        // Add the page backdrops ONLY if the snapshot didn't already bring them.
        //
        // Do NOT recreate them on every mount. `createShapes` appends to the top
        // of the z-order, so re-adding pages on a reopen lays them OVER existing
        // annotations — which leaves the strokes present and selectable but
        // completely hidden behind an opaque page.
        //
        // Restoring them from the snapshot is safe: `props.src` is a stable
        // `asset:pdf-page-N` reference, resolved to this session's blob URL by
        // assetStore above, so nothing about them can go stale between sessions.
        //
        // All of this runs BEFORE the store listener is attached, so none of it
        // marks the file dirty.
        const existing = editor.getCurrentPageShapes().filter(s => s.meta?.pdfPage !== undefined);
        const backdropMatchesFile = existing.length === pages.length;

        if (!backdropMatchesFile) {
            // Either a first open, or the PDF's page count changed under us —
            // rebuild from scratch rather than leave a half-matching backdrop.
            if (existing.length) {
                editor.deleteShapes(existing.map(s => s.id));
                const staleAssets = existing
                    .map(s => (s as TLImageShape).props.assetId)
                    .filter((id): id is TLAssetId => !!id);
                if (staleAssets.length) editor.deleteAssets(staleAssets);
            }

            const pageShapeIds = pages.map((_, i) => createShapeId(`pdf-page-${i}`));
            editor.createShapes(pages.map((page, i) => {
                // Deterministic ids so a rebuild replaces these in place rather
                // than piling up a fresh copy of every page.
                const assetId = AssetRecordType.createId(`pdf-page-${i}`);
                editor.createAssets([{
                    id: assetId,
                    type: 'image',
                    typeName: 'asset',
                    props: {
                        name: `page-${i + 1}.jpg`,
                        // Not a blob URL: see assetStore above. `meta.pdfPage` is
                        // what the resolver keys on.
                        src: `asset:pdf-page-${i}`,
                        w: page.width,
                        h: page.height,
                        mimeType: 'image/jpeg',
                        isAnimated: false,
                    },
                    meta: { pdfPage: i },
                }]);
                return {
                    id: pageShapeIds[i],
                    type: 'image' as const,
                    x: boxes[i].x,
                    y: boxes[i].y,
                    isLocked: true,
                    props: { assetId, w: page.width, h: page.height },
                    meta: { pdfPage: i },
                };
            }));
            // Belt and braces: pages are backdrop and must sit beneath every
            // annotation, whatever order they were added in.
            editor.sendToBack(pageShapeIds);
        }

        // Frame the document only on a first-ever open. On a reopen the snapshot
        // restores the camera, and fitting would throw away where the user was.
        if (!parsed.snapshot) editor.zoomToFit();

        for (const shape of editor.getCurrentPageShapes()) {
            if (shape.meta?.pdfPage !== undefined) pageShapeIdsRef.current.add(shape.id);
        }

        /**
         * Bring the pages you can see up to the zoom you are looking at them at,
         * and let the ones you have left go back to the base scale.
         *
         * Serialized behind `refining`, not merely started: rasterizing a page is
         * a worker round-trip plus a JPEG encode, and a zoom gesture can queue
         * several passes before the first finishes — which would render the same
         * page at two scales at once and leak whichever URL lost the race.
         */
        let refining = false;
        let refineAgain = false;
        const refinePages = async () => {
            if (refining) { refineAgain = true; return; }
            const source = sourceRef.current;
            const images = pageImagesRef.current;
            if (!source || !images.length) return;

            refining = true;
            try {
                do {
                    refineAgain = false;
                    // Zoom is CSS pixels per page unit; the display adds its own
                    // ratio on top, and it is the product that a raster has to
                    // match to look sharp.
                    const wanted = Math.min(
                        MAX_PAGE_SCALE,
                        Math.max(
                            PAGE_RENDER_SCALE,
                            Math.ceil((editor.getZoomLevel() * window.devicePixelRatio) / PAGE_SCALE_STEP) * PAGE_SCALE_STEP,
                        ),
                    );
                    const viewport = editor.getViewportPageBounds();

                    for (let i = 0; i < boxes.length; i++) {
                        const box = boxes[i];
                        const current = images[i];
                        // Not yet rasterized at all — the streaming load owns it.
                        if (!current) continue;

                        const visible = box.y < viewport.maxY && box.y + box.height > viewport.minY
                            && box.x < viewport.maxX && box.x + box.width > viewport.minX;
                        const target = visible ? wanted : PAGE_RENDER_SCALE;
                        if (current.scale === target) continue;

                        // Dropping back to base is a re-render too, but a cheap
                        // one, and it is what returns the memory a zoomed-in page
                        // borrowed.
                        const url = await source.renderPage(i, target);
                        // The canvas may have gone away mid-render; the cleanup
                        // has already emptied the array, so this URL is ours to
                        // drop rather than ours to install.
                        if (pageImagesRef.current !== images) { URL.revokeObjectURL(url); return; }
                        URL.revokeObjectURL(current.url);
                        images[i] = { url, scale: target };
                        refreshPageAsset(editor, i);
                    }
                } while (refineAgain);
            } catch (err) {
                // A failed refinement leaves the previous image in place, which is
                // merely less sharp — never worth breaking the canvas over.
                console.warn('Could not re-render PDF pages for the current zoom:', err);
            } finally {
                refining = false;
            }
        };

        let refineTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleRefine = () => {
            if (refineTimer) clearTimeout(refineTimer);
            refineTimer = setTimeout(() => { refineTimer = null; void refinePages(); }, REFINE_DEBOUNCE_MS);
        };
        // Session scope is where the camera lives, and it is deliberately a
        // different listener from the save one below: a pan or a zoom must
        // refine the backdrop WITHOUT marking the file dirty.
        const unlistenCamera = editor.store.listen(scheduleRefine, { scope: 'session' });
        scheduleRefine();   // the snapshot may have restored a zoomed-in camera

        /**
         * @param immediate true when the canvas is going away (mode toggle, tab
         *        switch, tab close). The viewer re-reads the file the instant it
         *        appears, so the write cannot sit in a debounce queue.
         */
        const flush = async (immediate = false) => {
            serializeTimerRef.current = null;
            // Cleared up front, not after: a stroke drawn while this is exporting
            // must re-arm the flag rather than be swallowed by it.
            hasUnsavedRef.current = false;
            // Export one transparent overlay per page: everything EXCEPT the page
            // backdrops, clipped to that page's box. Empty pages export nothing,
            // so the builder leaves them untouched.
            const annotations = editor.getCurrentPageShapes()
                .filter(s => !pageShapeIdsRef.current.has(s.id));

            // Bucket the shapes by page ONCE, rather than re-filtering the whole
            // annotation set per page. The old form called getShapePageBounds
            // for every shape on every page — pages x shapes lookups (600k on a
            // 300-page document with 2000 strokes) on the same main thread the
            // pen draws on, every 1.5s while annotating.
            const shapesByPage: Array<typeof annotations> = boxes.map(() => []);
            for (const shape of annotations) {
                const b = editor.getShapePageBounds(shape.id);
                if (!b) continue;
                for (let i = 0; i < boxes.length; i++) {
                    const box = boxes[i];
                    // Pages are stacked downward, so once a box starts below the
                    // shape's bottom edge no later box can overlap it either.
                    if (box.y >= b.maxY) break;
                    if (b.minY < box.y + box.height) shapesByPage[i].push(shape);
                }
            }

            const overlays: Array<PageOverlay | undefined> = [];
            for (let i = 0; i < boxes.length; i++) {
                const box = boxes[i];
                const onThisPage = shapesByPage[i];

                // Re-export a page only when its own annotations actually changed.
                // Exporting is main-thread work (it needs the DOM, so unlike the
                // PDF build it can't be moved off), and a stroke on page 1 must not
                // cost a re-export of pages 2..N. The signature covers every shape
                // on the page, so a moved or recoloured stroke still invalidates.
                const signature = JSON.stringify(onThisPage);
                const cached = overlayCacheRef.current.get(i);
                if (cached?.signature === signature) { overlays.push(cached.overlay); continue; }

                if (!onThisPage.length) {
                    overlayCacheRef.current.set(i, { signature, overlay: undefined });
                    overlays.push(undefined);
                    continue;
                }

                // bounds = exactly the page box, so an export maps 1:1 onto the
                // page when stamped; padding 0 or it would shift.
                const bounds = new Box(box.x, box.y, box.width, box.height);
                const exportOptions = { background: false, bounds, padding: 0, darkMode: false } as const;

                try {
                    const overlay: PageOverlay = {};
                    const rasterShapes = onThisPage.filter(s => RASTER_ONLY_SHAPES.has(s.type));
                    const vectorShapes = onThisPage.filter(s => !RASTER_ONLY_SHAPES.has(s.type));

                    // Strokes as paths: sharp at any zoom in the saved PDF, and
                    // an order of magnitude smaller than the equivalent PNG.
                    if (vectorShapes.length) {
                        const svg = await editor.getSvgString(vectorShapes.map(s => s.id), {
                            ...exportOptions,
                            // Positions are read back out of the viewBox, which is
                            // in page units — so keep the two the same and no
                            // scale has to be undone later.
                            scale: 1,
                        });
                        const ops = svg ? svgToVectorOps(svg.svg) : null;
                        // Anything that cannot be drawn exactly as paths falls
                        // back to pixels, which is where this code came from —
                        // never a wrong drawing, just a softer one.
                        if (ops) overlay.vector = ops;
                        else rasterShapes.push(...vectorShapes);
                    }

                    if (rasterShapes.length) {
                        const image = await editor.toImage(rasterShapes.map(s => s.id), {
                            ...exportOptions,
                            format: 'png',
                            scale: 2,
                        });
                        overlay.raster = new Uint8Array(await image.blob.arrayBuffer());
                    }

                    const result = isEmptyOverlay(overlay) ? undefined : overlay;
                    overlayCacheRef.current.set(i, { signature, overlay: result });
                    overlays.push(result);
                } catch (err) {
                    console.error(`Could not export annotations for page ${i + 1}:`, err);
                    // Reuse the last good overlay rather than dropping this page's
                    // annotations out of the file on a transient export failure.
                    overlays.push(cached?.overlay);
                }
            }

            // Hand the binary to the save path, then report the snapshot as this
            // tab's content — that marks it dirty and triggers the write.
            setPdfRenderData(filePath, { original, overlays });
            uiRef.current = readCanvasUi(editor);
            const json = JSON.stringify({ ...getSnapshot(editor.store), ui: uiRef.current });
            if (immediate) onFlushNowRef.current(filePath, json);
            else onContentChangeRef.current(filePath, json);
        };

        // Before applyPenDefaults, whose shape handler reads the width this
        // seeds, and before the listeners attach — restoring what the file
        // already says must not mark it dirty and rewrite the whole PDF.
        applyCanvasUi(editor, uiRef.current);
        const disposePen = applyPenDefaults(editor);

        /* Deliberately document-scope only, unlike a drawing or a notebook,
           which also save when the pen alone changes. A PDF's save REBUILDS THE
           WHOLE DOCUMENT (~150ms per annotated page), so doing that because a
           colour was clicked would stall the pen for nothing. The pen is
           captured by the next stroke's flush instead, which is the moment it
           first matters. */
        const unlisten = editor.store.listen(() => {
            hasUnsavedRef.current = true;
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            serializeTimerRef.current = setTimeout(() => { void flush(); }, SERIALIZE_DEBOUNCE_MS);
        }, { source: 'user', scope: 'document' });

        return () => {
            unlisten();
            disposePen();
            unlistenCamera();
            if (refineTimer) clearTimeout(refineTimer);
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            // Write on the way out so the viewer (which re-reads immediately) sees
            // the strokes — but only if there are any. Flushing unconditionally
            // would rewrite the whole PDF every time the mode was toggled.
            if (hasUnsavedRef.current) {
                onFlushStartRef.current();   // synchronous: beats the viewer's read
                void flush(true);
            }
        };
    }, [filePath, original, pages, parsed.snapshot]);

    if (error) {
        return (
            <div className="drawing-pane drawing-pane-loading">
                Could not open this PDF for annotation: {error}
            </div>
        );
    }
    if (!pages) {
        // Brief now: this waits only on page geometry, not on rasterizing.
        return <div className="drawing-pane drawing-pane-loading">Opening PDF…</div>;
    }

    return (
        <div className="drawing-pane pdf-annotate-pane">
            <Tldraw
                snapshot={parsed.snapshot}
                assets={assetStore}
                onMount={handleMount}
                components={CANVAS_COMPONENTS}
                shapeUtils={CANVAS_SHAPE_UTILS}
                colorScheme={ANNOTATE_COLOR_SCHEME}
                licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
            />
        </div>
    );
}
