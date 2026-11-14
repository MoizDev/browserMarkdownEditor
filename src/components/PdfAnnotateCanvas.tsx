import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Tldraw, getSnapshot, createTLStore, loadSnapshot, defaultShapeUtils, defaultBindingUtils, AssetRecordType, createShapeId, Box, inlineBase64AssetStore, react } from 'tldraw';
import type { Editor, TLAssetStore, TLEditorSnapshot, TLShapeId } from 'tldraw';
import 'tldraw/tldraw.css';
import { pageLayout, openPdfPages, PAGE_RENDER_SCALE, type PdfPageSize, type PdfPageSource } from '../utils/pdfAnnotation';
import { setPdfRenderData } from '../utils/pdfRenderCache';
import { revokePdfSource } from '../utils/pdfRole';
import { canvasReadOnlyReason, sniffCanvas } from '../utils/canvasFormat';
import CanvasReadOnlyNotice from './CanvasReadOnlyNotice';
import { isEmptyOverlay, type PageOverlay } from '../utils/pdfOverlay';
import { svgToVectorOps } from '../utils/pdfVector';
import { CANVAS_COMPONENTS, CANVAS_ASSET_URLS, CANVAS_OPTIONS, CANVAS_SHAPE_UTILS, applyCanvasUi, applyPenDefaults, readCanvasUi, type CanvasUiState } from './canvasPen';
import { PaperMainMenu } from './paperCanvas';
import { PAPER_USER } from './paperUser';
import { bindImageInvertKey } from './invertibleImageShape';
import { protectPageBackdrops } from './protectPageBackdrops';
import { bucketSheetsByPage, shapesBySheet, sheetThumbnail } from './pageSheetShapes';
import {
    flushPdfViewPositions, getPdfInverted, readPdfViewPos, readThumbnailsOpen, subscribePdfInverted,
    writePdfViewPos, writeThumbnailsOpen, recordPdfNavigation,
} from '../utils/pdfViewState';
import PdfInvertToggle from './PdfInvertToggle';
import PdfThumbnails, { type PdfThumbnailsHandle } from './PdfThumbnails';
import PageControls, { type PageControlsHandle } from './PageControls';
import { cameraFor, fitWidthZoom, lockCameraToPages, pageAt, watchPageView } from './pagedCanvas';
import { pdfPageGeometry, projectPdfPageV1 } from '../utils/pdfPageText';
import type { PdfDocumentSession } from '../utils/pdfDocumentSession';
import { createClassicPdfHealth, type ClassicPdfHealth } from '../utils/pdfClassicHealth';
import { pdfNativeEmphasisNotice } from '../utils/pdfNativeEmphasis';
import { composePdfCapture } from '../utils/pdfCapture';
import type { PdfNativeEmphasisResult } from '../utils/pdfNativeEmphasis';
import './PdfNativeEmphasis.css';
import { registerView, type PdfViewInfo } from '../utils/viewRegistry';
import { registerPending } from '../utils/unloadCoordinator';
import {
    captureRegion, createCanvasAgentOps, dominantPage, pagesInView, selectedAgentShapeIds, summarizeShapes,
    type CanvasPageModel,
} from './canvasAgentOps';

interface PdfAnnotateCanvasProps {
    /** OpenTab.id from reading.identity, never the mutable file path. */
    documentId?: string;
    emphasisEnabled?: boolean;
    onNativeEmphasisResult?(pageIndex: number, result?: PdfNativeEmphasisResult): void;
    onRenderHealth?(health: ClassicPdfHealth): void;
    filePath: string;
    /** Pristine original PDF bytes (never the stamped ones — see pdfAnnotation.ts). */
    original: Uint8Array;
    /** The pristine document session, shared with the reader when bytes match. */
    session: PdfDocumentSession;
    /** Serialized tldraw snapshot of existing annotations, '' if none yet. */
    snapshot: string;
    /** Path-explicit: a debounced save can land after a tab switch. */
    onContentChange: (path: string, content: string) => void;
    /** Same, but writes to disk immediately — used when the canvas is going away. */
    onFlushNow: (path: string, content: string) => Promise<void>;
    /**
     * Called synchronously as the canvas unmounts with strokes still to write.
     * Exporting them takes a moment, and until it does the tab isn't marked
     * dirty — so without this signal the viewer would briefly show the PDF as it
     * was BEFORE those strokes.
     */
    onFlushStart: () => void;
    onSaveError?: (message: string) => void;
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
const PAPER_COMPONENTS = { ...CANVAS_COMPONENTS, MainMenu: PaperMainMenu };

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

// Export only after the pen is lifted; the prepared revision bypasses the
// ordinary note debounce and enters the versioned save funnel immediately.
const SERIALIZE_DEBOUNCE_MS = 250;
const MAX_PENDING_MS = 2000;

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
    emphasis: boolean;
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

async function pageText(session: PdfDocumentSession, pageNumber: number): Promise<string> {
    const lease = await session.acquirePage(pageNumber - 1, 'agent');
    try {
        const content = await lease.page.getTextContent({ disableNormalization: true, includeMarkedContent: true });
        session.health.assertComplete(pageNumber - 1);
        return projectPdfPageV1(content.items, pdfPageGeometry(lease.page)).text;
    } finally { lease.release(); }
}

/** Decode an image and draw it over the whole `w`×`h` of `ctx`. */
async function drawBlob(ctx: CanvasRenderingContext2D, source: Blob, w: number, h: number): Promise<void> {
    const bitmap = await createImageBitmap(source);
    try {
        ctx.drawImage(bitmap, 0, 0, w, h);
    } finally {
        bitmap.close();
    }
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
        const { ui, ...snapshot } = JSON.parse(content.trim()) as TLEditorSnapshot & { ui?: CanvasUiState };
        return { snapshot: 'document' in snapshot ? snapshot as TLEditorSnapshot : undefined, ui };
    } catch (err) {
        throw new Error('The PDF annotations could not be loaded without losing content.', { cause: err });
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
function AnnotationLoadNotice() {
    return <div className="canvas-readonly-notice" role="alert" onContextMenu={event => event.preventDefault()}><div className="canvas-readonly-card">
        <h2>PDF annotations are read-only</h2>
        <p>The existing annotations could not be loaded safely. Switch to View to read the PDF, or use a compatible version to recover them.</p>
        <p className="canvas-readonly-preserved">The original file has not been changed. No edits will be saved.</p>
    </div></div>;
}

class AnnotationLoadBoundary extends Component<{ original: Uint8Array; children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch() { revokePdfSource(this.props.original); }
    render() { return this.state.failed ? <AnnotationLoadNotice /> : this.props.children; }
}

export default function PdfAnnotateCanvas(props: PdfAnnotateCanvasProps) {
    const sniff = useMemo(() => sniffCanvas(props.snapshot, 'pdf'), [props.snapshot]);
    const reason = canvasReadOnlyReason(sniff);
    useEffect(() => {
        // P-09 owns attachment precedence. This is the final loaded-snapshot
        // guard: no editor, pending serializer or rebuild capability survives it.
        if (reason) revokePdfSource(props.original);
    }, [reason, props.original]);
    return reason ? <CanvasReadOnlyNotice sniff={sniff} /> : <AnnotationLoadBoundary original={props.original}><CheckedPdfAnnotateCanvas {...props} /></AnnotationLoadBoundary>;
}

function CheckedPdfAnnotateCanvas(props: PdfAnnotateCanvasProps) {
    // P-09 validates the envelope; only the library can validate every record
    // and migration. Reject before an editor, listener or save cache exists.
    const [loadable] = useState(() => {
        try {
            const parsed = parseSnapshot(props.snapshot);
            if (parsed.snapshot) {
                const store = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils });
                loadSnapshot(store, parsed.snapshot);
            }
            return true;
        } catch {
            revokePdfSource(props.original);
            return false;
        }
    });
    return loadable ? <LegacyPdfAnnotateCanvas {...props} /> : <AnnotationLoadNotice />;
}

function LegacyPdfAnnotateCanvas({ documentId, filePath, original, session, snapshot, onContentChange, onFlushNow, onFlushStart, onSaveError, emphasisEnabled = false, onNativeEmphasisResult, onRenderHealth }: PdfAnnotateCanvasProps) {
    // Geometry only. The canvas mounts as soon as this lands; the page images
    // stream in afterwards through pageImagesRef.
    const [pages, setPages] = useState<PdfPageSize[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [renderHealth, setRenderHealth] = useState(createClassicPdfHealth);
    const onRenderHealthRef = useRef(onRenderHealth);
    onRenderHealthRef.current = onRenderHealth;
    const renderDiagnostics = useSyncExternalStore(renderHealth.subscribe, renderHealth.getSnapshot);
    const failedPages = useMemo<ReadonlySet<number>>(() => {
        const failed = new Set<number>();
        for (const issue of renderDiagnostics) {
            if (!issue.incomplete) continue;
            if (issue.pageIndex !== undefined) failed.add(issue.pageIndex);
            else {
                for (let index = 0; index < (pages?.length ?? 0); index++) failed.add(index);
                break;
            }
        }
        return failed;
    }, [renderDiagnostics, pages]);
    const onContentChangeRef = useRef(onContentChange);
    useEffect(() => { onContentChangeRef.current = onContentChange; }, [onContentChange]);
    const onFlushNowRef = useRef(onFlushNow);
    useEffect(() => { onFlushNowRef.current = onFlushNow; }, [onFlushNow]);
    const onFlushStartRef = useRef(onFlushStart);
    useEffect(() => { onFlushStartRef.current = onFlushStart; }, [onFlushStart]);
    const onSaveErrorRef = useRef(onSaveError);
    useEffect(() => { onSaveErrorRef.current = onSaveError; }, [onSaveError]);

    // Parsed once, on mount. `snapshot` churns as saves round-trip, but tldraw
    // owns the document from mount on, so re-reading it would be pointless work
    // (and could clobber in-progress strokes). PdfPane keys this component on
    // the file path, so a different file means a fresh mount and a fresh parse.
    const [parsed] = useState(() => parseSnapshot(snapshot));
    const uiRef = useRef<CanvasUiState | undefined>(parsed.ui);
    const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Page images as they arrive, by page index. Read by the asset store. */
    const [nativeNotice, setNativeNotice] = useState('');
    const nativePages = useRef(new Map<number, PdfNativeEmphasisResult>());
    const nativeResult = useRef(onNativeEmphasisResult);
    nativeResult.current = onNativeEmphasisResult;
    const emphasisRef = useRef(emphasisEnabled);
    emphasisRef.current = emphasisEnabled;
    const refreshEmphasis = useRef<(() => void) | undefined>(undefined);
    useEffect(() => { refreshEmphasis.current?.(); }, [emphasisEnabled]);
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
    /** The page under the top edge (0-based) and how far into it, as the view
     *  watch last saw them — the position the agent is told. */
    const viewPosRef = useRef({ top: 0, offset: 0 });

    /** Every page's box on the canvas — the same layout the save path maps
     *  strokes back through. */
    const boxes = useMemo(() => (pages ? pageLayout(pages) : []), [pages]);

    // The page strip and the page box. The page on screen lives in refs and is
    // written straight to the DOM by the view reaction in handleMount, never
    // held in state: a pan would otherwise re-render this component — tldraw
    // included — at every page boundary.
    const [thumbsOpen, setThumbsOpen] = useState(readThumbnailsOpen);
    /** Pages AND ink shown inverted: the filter is on tldraw's shapes layer, so
     *  black ink stays readable on a darkened page. Display only; the export
     *  renders shapes itself and never sees the filter. See index.css. */
    const inverted = useSyncExternalStore(subscribePdfInverted, getPdfInverted);
    useEffect(() => { writeThumbnailsOpen(thumbsOpen); }, [thumbsOpen]);
    /** Where the strip opens: the reader's page on mount, the current one on a toggle. */
    const [thumbsStart, setThumbsStart] = useState(0);
    const thumbsRef = useRef<PdfThumbnailsHandle | null>(null);
    const controlsRef = useRef<PageControlsHandle | null>(null);
    /** 0-based page shown in the page box. */
    const shownPageRef = useRef(0);
    /** The box tldraw lives in, where swipes are caught before tldraw sees them. */
    const canvasWrapRef = useRef<HTMLDivElement | null>(null);

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
                source = await openPdfPages(session, health => {
                    if (cancelled) return;
                    setRenderHealth(health);
                    onRenderHealthRef.current?.(health);
                });
                if (cancelled) { await source.close(); return; }

                // Geometry is enough to lay out and mount the canvas — no need to
                // wait on a single pixel. Set the ref before the state: <Tldraw>
                // mounts the moment `pages` is non-null and immediately asks the
                // asset store to resolve page URLs through this ref.
                pageImagesRef.current = images;
                sourceRef.current = source;
                // The page the reader was on, for the strip to open at. Read
                // here, after an await, rather than while rendering: the reader
                // records its position as it unmounts.
                const start = Math.min(source.sizes.length - 1, readPdfViewPos(filePath)?.page ?? 0);
                nativePages.current.clear();
                setNativeNotice('');
                nativeResult.current?.(start, undefined);
                shownPageRef.current = start;
                setThumbsStart(start);
                setPages(source.sizes);
                // Nothing is rasterized here. It used to be EVERY page, in order,
                // before the first one was needed — on a 300-page book, 300 renders
                // and JPEG encodes to show the one you opened on. Pages are drawn
                // as they come near the view instead; see refinePages.
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
    }, [session, filePath]);

    const handleMount = useCallback((editor: Editor) => {
        if (!pages) return;
        editorRef.current = editor;
        // Measured: a fast mode handoff during font loading produced 32
        // AtomMap errors: tldraw clears FontManager before its load promises
        // update that map. Defer only its bookkeeping cleanup, not the editor
        // or canvas, until the document's in-flight fonts have settled.
        const disposeFonts = editor.fonts.dispose.bind(editor.fonts);
        const fontDocument = editor.getContainer().ownerDocument;
        editor.fonts.dispose = () => { void fontDocument.fonts.ready.then(disposeFonts); };

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
        const reconcileBackdrops = () => editor.run(() => editor.store.mergeRemoteChanges(() => {
            const existing = editor.getCurrentPageShapes().filter(s => s.meta?.pdfPage !== undefined);
            const keep = new Set<TLShapeId>();
            pages.forEach((page, i) => {
                const assetId = AssetRecordType.createId(`pdf-page-${i}`);
                // One document asset is shared by all sheets; deleting it when
                // changing sheets would make the other sheets lose their paper.
                if (!editor.getAsset(assetId)) editor.createAssets([{
                    id: assetId, type: 'image', typeName: 'asset',
                    props: { name: `page-${i + 1}.jpg`, src: `asset:pdf-page-${i}`,
                        w: page.width, h: page.height, mimeType: 'image/jpeg', isAnimated: false },
                    meta: { pdfPage: i },
                }]);
                const found = existing.find(s => s.meta.pdfPage === i && s.type === 'image');
                const legacy = createShapeId(`pdf-page-${i}`);
                const id = found?.id ?? (editor.getShape(legacy) ? createShapeId() : legacy);
                keep.add(id);
                const shape = { id, type: 'image' as const, x: boxes[i].x, y: boxes[i].y,
                    isLocked: true, props: { assetId, w: page.width, h: page.height }, meta: { pdfPage: i } };
                if (found) editor.updateShape(shape);
                else editor.createShapes([shape]);
            });
            const stale = existing.filter(s => !keep.has(s.id)).map(s => s.id);
            if (stale.length) editor.deleteShapes(stale);
            editor.sendToBack([...keep]);
            pageShapeIdsRef.current = keep;
        }), { ignoreShapeLock: true });
        reconcileBackdrops();
        const backdropGuard = protectPageBackdrops(editor, shape => shape.meta?.pdfPage !== undefined);
        let paperSheet = editor.getCurrentPageId();
        const stopSheetWatch = react('pdf paper sheet', () => {
            const sheet = editor.getCurrentPageId();
            if (sheet === paperSheet) return;
            paperSheet = sheet;
            backdropGuard.allow(reconcileBackdrops);
            thumbsRef.current?.invalidate(boxes.map((_, i) => i));
        });

        // Open on the page being READ, at the reader's size — not on the whole
        // document. This used to zoomToFit() on a first open, which on a long PDF
        // is every page at once, too small to read or write on; and a reopen
        // restored the snapshot's camera, which knew nothing of where the reader
        // had got to since. The position record is shared with the reader
        // (utils/pdfViewState.ts), so the two modes hand one page back and forth.
        // Scrolls like a PDF: vertical swipes only, full width edge to edge, and
        // the view cannot leave the document. Shared with notebooks.
        const lock = lockCameraToPages(editor, canvasWrapRef.current, boxes);
        const savedPos = readPdfViewPos(filePath);
        editor.setCamera(cameraFor(
            boxes[Math.min(boxes.length - 1, savedPos?.page ?? 0)],
            editor.getViewportScreenBounds().width,
            fitWidthZoom(editor, boxes) * (savedPos?.zoom ?? 1),
            savedPos?.offset ?? 0,
        ));


        /**
         * Keep the backdrop true to the view: rasterize pages as they come near
         * it, sharpen the ones in it to the zoom they are seen at, and let pages
         * that have been left drop back to the base scale.
         *
         * Nothing is rasterized ahead of need. Pages near the view come first,
         * nearest the middle first, deciding again after EVERY page — so jumping
         * to page 300 renders page 300, not 1 through 299 on the way there.
         *
         * Serialized behind `refining`, not merely started: rasterizing a page is
         * a worker round-trip plus a JPEG encode, and a zoom gesture can queue
         * several passes before the first finishes — which would render the same
         * page at two scales at once and leak whichever URL lost the race.
         */
        let refining = false;
        let refineAgain = false;
        let sharpenWanted = false;
        let closed = false;
        let activePaint: AbortController | undefined;
        const unrenderable = new Set<number>();
        const refinePages = async (sharpen: boolean) => {
            if (sharpen) sharpenWanted = true;
            if (closed) return;
            if (refining) { refineAgain = true; return; }
            const source = sourceRef.current;
            const images = pageImagesRef.current;
            if (!source) return;
            refining = true;
            try {
                do {
                    refineAgain = false;
                    if (closed || pageImagesRef.current !== images) return;
                    const viewport = editor.getViewportPageBounds();
                    const middle = (viewport.minY + viewport.maxY) / 2;
                    const wanted = Math.min(MAX_PAGE_SCALE, Math.max(PAGE_RENDER_SCALE,
                        Math.ceil((editor.getZoomLevel() * window.devicePixelRatio) / PAGE_SCALE_STEP) * PAGE_SCALE_STEP));
                    const emphasis = emphasisRef.current;
                    // Decide again after each await. Visible stale backdrops beat
                    // even missing neighbors; distant cached pages are invalidated
                    // lazily, so a toggle costs the approach window, not visit history.
                    let candidate: { index: number; scale: number; priority: number } | undefined;
                    for (let i = 0; i < boxes.length; i++) {
                        if (unrenderable.has(i)) continue;
                        const box = boxes[i], current = images[i];
                        const visible = box.y < viewport.maxY && box.y + box.height > viewport.minY
                            && box.x < viewport.maxX && box.x + box.width > viewport.minX;
                        const near = box.y <= viewport.maxY + viewport.height && box.y + box.height >= viewport.minY - viewport.height;
                        const scale = visible && sharpenWanted ? wanted : visible && current ? current.scale : PAGE_RENDER_SCALE;
                        const stale = !current || near && current.emphasis !== emphasis;
                        const resize = !!current && (visible ? sharpenWanted && current.scale !== wanted : current.scale !== PAGE_RENDER_SCALE);
                        if ((!near && !resize) || (!stale && !resize)) continue;
                        const priority = (visible ? 0 : near ? 1e9 : 2e9) + Math.abs(box.y + box.height / 2 - middle);
                        if (!candidate || priority < candidate.priority) candidate = { index: i, scale, priority };
                    }
                    if (!candidate) { sharpenWanted = false; continue; }
                    const { index, scale } = candidate;
                    const controller = new AbortController(); activePaint = controller;
                    try {
                        const url = await source.renderPage(index, scale, emphasis, undefined, controller.signal);
                        if (closed || pageImagesRef.current !== images || controller.signal.aborted || emphasis !== emphasisRef.current) {
                            URL.revokeObjectURL(url); refineAgain = true; continue;
                        }
                        const previous = images[index];
                        images[index] = { url, scale, emphasis };
                        refreshPageAsset(editor, index);
                        if (previous) URL.revokeObjectURL(previous.url);
                        if (shownPageRef.current === index) watchShown(index);
                    } catch (err) {
                        if (!controller.signal.aborted) {
                            unrenderable.add(index);
                            console.warn(`Could not render PDF page ${index + 1}:`, err);
                        }
                    } finally { if (activePaint === controller) activePaint = undefined; }
                    refineAgain = true;
                } while (refineAgain);
            } finally { refining = false; }
        };

        let watchedPage = -1;
        let releaseEmphasis: (() => void) | undefined;
        function watchShown(index: number) {
            if (closed || watchedPage === index) return;
            releaseEmphasis?.();
            watchedPage = index;
            const source = sourceRef.current;
            if (!source) return;
            releaseEmphasis = source.watchEmphasis(index, result => {
                if (closed || sourceRef.current !== source || shownPageRef.current !== index) return;
                if (result) nativePages.current.set(index, result); else nativePages.current.delete(index);
                setNativeNotice(pdfNativeEmphasisNotice(result));
                nativeResult.current?.(index, result);
                // An On-first backdrop was deliberately painted unmodified while
                // the proof ran. Replace it without touching ink or history.
                if (result?.supported && result.eligible && emphasisRef.current) {
                    const image = pageImagesRef.current[index];
                    if (image) image.emphasis = false;
                    void refinePages(false);
                }
            });
        }

        // Only remote backdrop assets change; ink, history and camera are retained.
        const refresh = () => { activePaint?.abort(); void refinePages(true); };
        refreshEmphasis.current = refresh;

        // Sharpening waits for the view to settle: a zoom gesture passes through
        // every scale on the way, and rendering each one would be wasted work.
        let refineTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleRefine = () => {
            if (refineTimer) clearTimeout(refineTimer);
            refineTimer = setTimeout(() => { refineTimer = null; void refinePages(true); }, REFINE_DEBOUNCE_MS);
        };

        // Where the view is: for the page box, the strip, and the record the
        // reader reopens from. The record changes in memory on every pass and
        // reaches storage on a debounce; see writePdfViewPos for why memory
        // cannot be the one that lags.
        let persistTimer: ReturnType<typeof setTimeout> | null = null;
        let firstView = true;
        const stopViewWatch = watchPageView(editor, () => boxes, ({ top, offset, shown }) => {
            if (!firstView && (viewPosRef.current.top !== top || viewPosRef.current.offset !== offset)) recordPdfNavigation(filePath, 'annotation');
            viewPosRef.current = { top, offset };
            if (shown !== shownPageRef.current || firstView) {
                firstView = false;
                shownPageRef.current = shown;
                setNativeNotice(pdfNativeEmphasisNotice(nativePages.current.get(shown)));
                nativeResult.current?.(shown, nativePages.current.get(shown));
                controlsRef.current?.setPage(shown);
                thumbsRef.current?.setCurrentPage(shown);
                releaseEmphasis?.();
                releaseEmphasis = undefined;
                watchedPage = -1;
                if (pageImagesRef.current[shown]) watchShown(shown);
            }
            writePdfViewPos(filePath, { page: top, offset, zoom: editor.getZoomLevel() / fitWidthZoom(editor, boxes) }, false);
            if (persistTimer) clearTimeout(persistTimer);
            persistTimer = setTimeout(() => { persistTimer = null; flushPdfViewPositions(); }, 400);
            activePaint?.abort();
            void refinePages(false);
            scheduleRefine();
        });

        /**
         * @param immediate true when the canvas is going away (mode toggle, tab
         *        switch, tab close). The viewer re-reads the file the instant it
         *        appears, so the write cannot sit in a debounce queue.
         */
        let revision = 0;
        let firstPending = 0;
        const activePointers = new Set<number>();
        const flush = async (immediate = false) => {
            serializeTimerRef.current = null;
            const capturedRevision = revision;
            const stagedCache = new Map(overlayCacheRef.current);
            // Cleared up front, not after: a stroke drawn while this is exporting
            // must re-arm the flag rather than be swallowed by it.
            hasUnsavedRef.current = false;
            // Export one transparent overlay per page: everything EXCEPT the page
            // backdrops, clipped to that page's box. Empty pages export nothing,
            // so the builder leaves them untouched.
            const sheets = shapesBySheet(editor, shape => shape.meta?.pdfPage !== undefined);
            // Snapshot the same revision as the overlays before any async
            // export. A later stroke belongs to the next serialized flush.
            uiRef.current = readCanvasUi(editor);
            const json = JSON.stringify({ ...getSnapshot(editor.store), ui: uiRef.current });

            // Collect once across every sheet; the active sheet is only a view.
            const shapesByPage = bucketSheetsByPage(editor, sheets, boxes);

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

                if (!onThisPage.some(shapes => shapes.length)) {
                    stagedCache.set(i, { signature, overlay: undefined });
                    overlays.push(undefined);
                    continue;
                }

                // bounds = exactly the page box, so an export maps 1:1 onto the
                // page when stamped; padding 0 or it would shift.
                const bounds = new Box(box.x, box.y, box.width, box.height);
                const exportOptions = { background: false, bounds, padding: 0, darkMode: false } as const;

                try {
                    const layers: PageOverlay[] = [];
                    for (const shapes of onThisPage) {
                        if (!shapes.length) continue;
                        const overlay: PageOverlay = {};
                        const rasterShapes = shapes.filter(s => RASTER_ONLY_SHAPES.has(s.type));
                        const vectorShapes = shapes.filter(s => !RASTER_ONLY_SHAPES.has(s.type));

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

                        if (!isEmptyOverlay(overlay)) layers.push(overlay);
                    }
                    const result: PageOverlay | undefined = layers.length ? { geometry: pages[i], layers } : undefined;
                    stagedCache.set(i, { signature, overlay: result });
                    overlays.push(result);
                } catch (err) {
                    // A new editable snapshot with an old/missing overlay is a
                    // silent partial PDF save. Keep the old file, then retry the
                    // complete hand-over instead of reporting stale ink as saved.
                    throw new Error(`Could not export annotations for page ${i + 1}.`, { cause: err });
                }
            }

            // The live exporter may have crossed a later edit while awaiting
            // SVG/image work. Never publish a mixed snapshot and overlay, nor
            // poison the unchanged-page cache with that partial export.
            if (capturedRevision !== revision) { hasUnsavedRef.current = true; return; }
            overlayCacheRef.current = stagedCache;
            firstPending = 0;
            setPdfRenderData(filePath, { original, overlays });
            if (immediate) await onFlushNowRef.current(filePath, json);
            else onContentChangeRef.current(filePath, json);
        };

        // The export is async (~150 ms a page), so "nothing pending" also needs
        // no export in flight: its strokes reach the save funnel only at its end.
        let pendingFlush: Promise<void> | null = null;
        let unregisterPending: (() => void) | undefined;
        const hasPendingEdits = () => hasUnsavedRef.current || pendingFlush !== null;
        const reportPending = () => {
            if (hasPendingEdits()) {
                if (documentId && !unregisterPending) {
                    unregisterPending = registerPending({ documentId, hasPendingEdits, flushPending });
                }
            } else {
                unregisterPending?.();
                unregisterPending = undefined;
            }
        };
        const runFlush = (immediate = true): Promise<void> => {
            if (pendingFlush) return pendingFlush.then(() => hasUnsavedRef.current ? runFlush(immediate) : undefined);
            const run = flush(immediate).catch(error => {
                hasUnsavedRef.current = true;
                onSaveErrorRef.current?.('Could not export PDF annotations. The PDF was not changed; keep the tab open and retry saving.');
                throw error;
            }).finally(() => {
                if (pendingFlush === run) {
                    pendingFlush = null;
                    reportPending();
                }
            });
            pendingFlush = run;
            reportPending();
            return run;
        };
        const flushPending = async () => {
            if (serializeTimerRef.current) { clearTimeout(serializeTimerRef.current); serializeTimerRef.current = null; }
            if (pendingFlush) await pendingFlush;
            while (hasUnsavedRef.current) await runFlush();
        };
        const flushInBackground = (immediate = true) => {
            // Coordinator callers get the rejection; timers/unmount have no
            // caller to await them and must not create an unhandled rejection.
            void runFlush(immediate).catch(error => console.error('Could not save PDF annotations:', error));
        };

        // Before applyPenDefaults, whose shape handler reads the width this
        // seeds, and before the listeners attach — restoring what the file
        // already says must not mark it dirty and rewrite the whole PDF.
        applyCanvasUi(editor, uiRef.current);
        const disposePen = applyPenDefaults(editor);
        // `i` inverts a selected picture — see invertibleImageShape.tsx.
        const disposeInvert = bindImageInvertKey(editor);

        // What the agent sees and draws through (utils/viewRegistry.ts). The
        // pages are backdrop: never listed, never touched. Its edits are
        // ordinary user-sourced changes, so the listener below exports them
        // and the save rebuilds from the pristine original like any stroke.
        const model: CanvasPageModel = {
            boxes: () => boxes,
            currentPage: () => dominantPage(boxes, editor.getViewportPageBounds()),
            isBackdrop: id => pageShapeIdsRef.current.has(id),
        };
        const ops = createCanvasAgentOps(editor, model);
        const unregisterView = registerView(filePath, {
            kind: 'pdf-annotate',
            canvas: ops,
            describe(): PdfViewInfo {
                const view = editor.getViewportPageBounds();
                const visible = pagesInView(boxes, view);
                const onScreen = new Set(visible);
                const { shapes, total } = summarizeShapes(editor, model, b => onScreen.has(pageAt(boxes, (b.minY + b.maxY) / 2) + 1));
                return {
                    kind: 'pdf-annotate',
                    surface: 'annotation',
                    pageCount: boxes.length,
                    page: viewPosRef.current.top + 1,
                    offset: viewPosRef.current.offset,
                    zoom: editor.getZoomLevel() / fitWidthZoom(editor, boxes),
                    visiblePages: visible,
                    // The pages are pictures here: there is no text to select.
                    selectedText: null,
                    inverted: getPdfInverted(),
                    shapes,
                    shapesTotal: total,
                    selectedShapeIds: selectedAgentShapeIds(editor, model),
                };
            },
            // The editor exports unfiltered shapes; compose the display filter
            // once, without inverting the surrounding canvas.
            capture: async (maxSide) => {
                const view = editor.getViewportPageBounds();
                const capturedRevision = revision, invert = getPdfInverted(), zoom = editor.getZoomLevel();
                const visible = pagesInView(boxes, view);
                const source = sourceRef.current;
                if (!source || visible.some(page => !pageImagesRef.current[page - 1]?.url)) return null;
                const health = source.health;
                for (const page of visible) health.assertComplete(page - 1);
                const capture = await captureRegion(editor, view, maxSide, zoom * 2, true);
                if (!capture) return null;
                const background = canvasWrapRef.current?.querySelector('.tl-background');
                const colour = background ? getComputedStyle(background).backgroundColor : '#808080';
                const result = await composePdfCapture(capture, invert, colour);
                // An image failure or another edit can arrive while composing.
                for (const page of visible) health.assertComplete(page - 1);
                const now = editor.getViewportPageBounds();
                return sourceRef.current === source && revision === capturedRevision && getPdfInverted() === invert &&
                    editor.getZoomLevel() === zoom && now.x === view.x && now.y === view.y && now.w === view.w && now.h === view.h ? result : null;
            },
            // The page rendered fresh from the ORIGINAL, with this canvas's ink
            // over it — not the backdrop, which may not be rasterized yet (only
            // pages near the view are) and is a JPEG at the view's scale.
            renderPage: async (page, maxSide) => {
                const source = sourceRef.current;
                const box = boxes[page - 1];
                if (!source || !box || !(maxSide > 0) || !Number.isFinite(maxSide)) return null;
                const capturedRevision = revision;
                const scale = Math.min(maxSide, 1568) / Math.max(box.width, box.height);
                const w = Math.max(1, Math.round(box.width * scale));
                const h = Math.max(1, Math.round(box.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                try {
                const url = await source.renderPage(page - 1, scale);
                try {
                    await drawBlob(ctx, await (await fetch(url)).blob(), w, h);
                } finally {
                    URL.revokeObjectURL(url);
                }
                const bounds = new Box(box.x, box.y, box.width, box.height);
                const sheets = bucketSheetsByPage(editor, shapesBySheet(editor, shape => shape.meta?.pdfPage !== undefined), boxes)[page - 1];
                for (const shapes of sheets) {
                    const ink = shapes.filter(s => { const b = editor.getShapePageBounds(s.id); return !!b && Box.Collides(b, bounds); }).map(s => s.id);
                    if (!ink.length) continue;
                    const { blob } = await editor.toImage(ink, {
                        bounds, scale, pixelRatio: 1, padding: 0, background: false, darkMode: false, format: 'png',
                    });
                    await drawBlob(ctx, blob, w, h);
                }
                const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
                canvas.width = 0;
                canvas.height = 0;
                source.health.assertComplete(page - 1);
                return sourceRef.current === source && revision === capturedRevision ? png : null;
                } finally { canvas.width = canvas.height = 0; }
            },
            pdfText: async (pageNumbers) => {
                const doc = await session.acquire();
                try {
                    const out: Array<{ page: number; text: string }> = [];
                    for (const n of pageNumbers) {
                        if (!Number.isInteger(n) || n < 1 || n > doc.document.numPages) continue;
                        out.push({ page: n, text: await pageText(session, n) });
                    }
                    return out;
                } finally { doc.release(); }
            },
            // Strokes in the debounce or mid-export are edits App cannot see yet
            // (App.checkOpenDocs): reloading the PDF from disk over them would
            // lose them, so they make an outside change a conflict instead.
            hasPendingEdits,
            flushPending,
        });

        /* Deliberately document-scope only, unlike a drawing or a notebook,
           which also save when the pen alone changes. A PDF's save REBUILDS THE
           WHOLE DOCUMENT (~150ms per annotated page), so doing that because a
           colour was clicked would stall the pen for nothing. The pen is
           captured by the next stroke's flush instead, which is the moment it
           first matters. */
        const schedule = () => {
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            serializeTimerRef.current = null;
            if (activePointers.size || !hasUnsavedRef.current) return;
            const delay = firstPending && performance.now() - firstPending >= MAX_PENDING_MS ? 0 : SERIALIZE_DEBOUNCE_MS;
            serializeTimerRef.current = setTimeout(() => flushInBackground(), delay);
        };
        const pointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && canvasWrapRef.current?.contains(event.target)) {
                activePointers.add(event.pointerId);
                if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
                serializeTimerRef.current = null;
            }
        };
        const pointerEnd = (event: PointerEvent) => { activePointers.delete(event.pointerId); schedule(); };
        const pointerBlur = () => { activePointers.clear(); schedule(); };
        window.addEventListener('pointerdown', pointerDown, true);
        window.addEventListener('pointerup', pointerEnd, true);
        window.addEventListener('pointercancel', pointerEnd, true);
        window.addEventListener('blur', pointerBlur);
        const markUnsaved = () => {
            revision++;
            hasUnsavedRef.current = true;
            onFlushStartRef.current();
            if (!firstPending) firstPending = performance.now();
            thumbsRef.current?.invalidate(boxes.map((_, i) => i));
            schedule();
            reportPending();
        };
        // store.listen delivers on a later frame: an immediate flush/mode
        // handoff after a shape change previously saw no pending ink. These
        // public side effects mark document changes synchronously. Remote page
        // raster refinements and session/camera records remain display-only.
        const stopDirty = (['shape', 'asset', 'binding', 'page', 'document'] as const).flatMap(type => [
            editor.sideEffects.registerAfterCreateHandler(type, (_record, source) => { if (source === 'user') markUnsaved(); }),
            editor.sideEffects.registerAfterChangeHandler(type, (_before, _after, source) => { if (source === 'user') markUnsaved(); }),
            editor.sideEffects.registerAfterDeleteHandler(type, (_record, source) => { if (source === 'user') markUnsaved(); }),
        ]);

        return () => {
            unregisterView();
            window.removeEventListener('pointerdown', pointerDown, true);
            window.removeEventListener('pointerup', pointerEnd, true);
            window.removeEventListener('pointercancel', pointerEnd, true);
            window.removeEventListener('blur', pointerBlur);
            stopDirty.forEach(stop => stop());
            disposePen();
            disposeInvert();
            stopSheetWatch();
            backdropGuard.dispose();
            closed = true;
            releaseEmphasis?.();
            activePaint?.abort();
            if (refreshEmphasis.current === refresh) refreshEmphasis.current = undefined;
            stopViewWatch();
            lock.dispose();
            if (refineTimer) clearTimeout(refineTimer);
            if (persistTimer) { clearTimeout(persistTimer); flushPdfViewPositions(); }
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            // Write on the way out so the viewer (which re-reads immediately) sees
            // the strokes — but only if there are any. Flushing unconditionally
            // would rewrite the whole PDF every time the mode was toggled.
            if (hasUnsavedRef.current || pendingFlush) {
                onFlushStartRef.current();   // synchronous: beats the viewer's read
                if (hasUnsavedRef.current) flushInBackground(true);
            }
            // An in-flight export can outlive the pane. Its finally releases
            // the registration only after the funnel owns the complete revision.
            reportPending();
        };
    }, [documentId, filePath, original, session, pages, boxes]);

    const renderThumbnail = useCallback(async (index: number, scale: number) => {
        const source = sourceRef.current;
        const editor = editorRef.current;
        const box = boxes[index];
        if (!source || !editor || !box) throw new Error('The PDF is closed');
        const url = await source.renderPage(index, scale);
        try {
            const result = await sheetThumbnail(editor, box, url, scale, shape => shape.meta?.pdfPage !== undefined);
            try { source.health.assertComplete(index); } catch (error) { URL.revokeObjectURL(result); throw error; }
            return result;
        } finally { URL.revokeObjectURL(url); }
    }, [boxes]);

    /** Put page `index` at the top of the view, centred, at the current zoom. */
    const jumpToPage = useCallback((index: number) => {
        const editor = editorRef.current;
        if (!editor || boxes.length === 0) return;
        const box = boxes[Math.min(boxes.length - 1, Math.max(0, index))];
        editor.setCamera(cameraFor(box, editor.getViewportScreenBounds().width, editor.getZoomLevel()));
    }, [boxes]);

    const toggleThumbs = useCallback(() => {
        setThumbsStart(shownPageRef.current);
        setThumbsOpen(open => !open);
    }, []);

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
        <div className={`drawing-pane pdf-annotate-pane${thumbsOpen ? ' has-thumbs' : ''}${inverted ? ' is-inverted' : ''}`} data-legacy-board="">
            {thumbsOpen && (
                <PdfThumbnails
                    ref={thumbsRef}
                    sizes={pages}
                    renderThumbnail={renderThumbnail}
                    failedPages={failedPages}
                    onSelect={jumpToPage}
                    initialPage={thumbsStart}
                />
            )}
            <div className="paged-canvas" ref={canvasWrapRef}>
                <Tldraw
                    snapshot={parsed.snapshot}
                    assets={assetStore}
                    onMount={handleMount}
                    components={PAPER_COMPONENTS}
                    shapeUtils={CANVAS_SHAPE_UTILS}
                    options={CANVAS_OPTIONS}
                assetUrls={CANVAS_ASSET_URLS}
                    colorScheme={ANNOTATE_COLOR_SCHEME}
                    user={PAPER_USER}
                    licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
                />
            </div>
            <PageControls
                ref={controlsRef}
                pageCount={pages.length}
                thumbsOpen={thumbsOpen}
                onToggleThumbs={toggleThumbs}
                onJump={jumpToPage}
            >
                {emphasisEnabled && nativeNotice && <span className="pdf-native-emphasis-notice" role="status">{nativeNotice}</span>}
                <PdfInvertToggle />
            </PageControls>
        </div>
    );
}
