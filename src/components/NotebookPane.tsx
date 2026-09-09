import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tldraw, getSnapshot, AssetRecordType, createShapeId, Box, inlineBase64AssetStore } from 'tldraw';
import type { Editor, TLAssetStore, TLShape, TLShapeId } from 'tldraw';
import 'tldraw/tldraw.css';
import {
    pageLayout, paperDataUri, paperPageSize, MAX_PAGES,
    type NotebookPaper,
} from '../utils/paper';
import { parseNotebookFile, serializeNotebookFile, type NotebookUiState } from '../utils/notebookFile';
import { isEmptyOverlay, type PageOverlay } from '../utils/pdfOverlay';
import { svgToVectorOps } from '../utils/pdfVector';
import { setNotebookRenderData } from '../utils/notebookRenderCache';
import { CANVAS_COMPONENTS, applyPenDefaults } from './canvasPen';

interface NotebookPaneProps {
    /** The notebook's vault path. Every change is reported against it explicitly
     *  (never "the active tab") so a save landing after a tab switch cannot
     *  write notebook JSON into another file's buffer. */
    filePath: string;
    /** The file's text. See utils/notebookFile.ts. */
    content: string;
    onContentChange: (path: string, content: string) => void;
    /** The app's own confirm, for the one action here that destroys writing. */
    onConfirm: (question: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;
}

/**
 * A NOTEBOOK IS ALWAYS LIGHT, whatever theme the app is in — for the same
 * reason the PDF annotator is (see PdfAnnotateCanvas): tldraw resolves colour
 * NAMES through the live theme, and its dark theme maps 'black' to near-white.
 * Paper is white here and white in the PDF this exports to, so a dark variant
 * would be an appearance the export could not reproduce.
 */
const NOTEBOOK_COLOR_SCHEME = 'light';

/** See PdfAnnotateCanvas: a deny list, with `svgToVectorOps` as the real gate. */
const RASTER_ONLY_SHAPES = new Set(['text', 'note', 'image', 'video', 'bookmark', 'embed']);

/** Drawing a single stroke fires a burst of store transactions. Coalesce, then
 *  hand off to the app's own 1s save debounce. Shorter than the PDF annotator's
 *  1500ms because a notebook's save is a JSON.stringify — the pages are
 *  generated, so nothing is exported until you actually ask for a PDF. */
const SERIALIZE_DEBOUNCE_MS = 400;

/** Up to this many shapes on a page, zoomed-out strokes keep their full ink
 *  rendering; past it, tldraw's low-zoom thin-line LOD applies as designed. */
const FULL_INK_SHAPE_LIMIT = 1000;

/**
 * Append a page once ink reaches within this much of the last page's bottom.
 *
 * Not "past the bottom": by the time you notice there is nowhere left to write
 * you have already run out, so the next page has to exist before you get there.
 * A fifth of a page is roughly the last few lines.
 */
const APPEND_MARGIN_FRACTION = 0.2;

/**
 * Space left around the page when a notebook is first framed.
 *
 * tldraw takes this off each AXIS, not each side, so the gap actually seen is
 * half of it — measured: 64 left ~29px above the page and put the paper toolbar
 * on its first rules. 128 gives the ~64px that clears the toolbar.
 */
const FIT_INSET = 128;

function pageShapeId(index: number): TLShapeId {
    return createShapeId(`notebook-page-${index}`);
}

/**
 * A tldraw canvas laid out as a stack of ruled pages, bound to one `.notebook`.
 *
 * The pages are backdrop, not content: locked so a stray drag cannot shift one
 * out from under the writing on it, excluded from the PDF export, and reconciled
 * against `paper` by shape id on every open — so changing the ruling re-papers
 * the strokes already there instead of rewriting the document, and no page ever
 * gets re-created on top of the writing it belongs under.
 */
export default function NotebookPane({ filePath, content, onContentChange, onConfirm }: NotebookPaneProps) {
    // Parsed once per FILE, not per render: `content` changes on every save
    // round-trip, but tldraw owns the document after mount, so re-reading it
    // would be pointless work (and could clobber in-progress edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const parsed = useMemo(() => parseNotebookFile(content), [filePath]);

    // Paper IS state, unlike the snapshot: the toolbar changes it, and pages are
    // appended as you write, so the canvas has to re-lay-out when it moves.
    const [paper, setPaper] = useState<NotebookPaper>(parsed.paper);
    const paperRef = useRef(paper);
    useEffect(() => { paperRef.current = paper; }, [paper]);

    const onContentChangeRef = useRef(onContentChange);
    useEffect(() => { onContentChangeRef.current = onContentChange; }, [onContentChange]);
    const onConfirmRef = useRef(onConfirm);
    useEffect(() => { onConfirmRef.current = onConfirm; }, [onConfirm]);

    const editorRef = useRef<Editor | null>(null);
    const uiRef = useRef<NotebookUiState | undefined>(parsed.ui);
    const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Shape ids of the page backdrops — never exported, never counted as ink. */
    const pageShapeIdsRef = useRef<Set<TLShapeId>>(new Set());

    /**
     * The paper as one SVG data URI, shared by every page.
     *
     * SVG, not a raster: a notebook's pages are drawn by this app rather than
     * decoded from a document, so unlike the PDF annotator's backdrops they are
     * resolution-independent — crisp at any zoom, with no re-render pass and no
     * per-zoom memory. One asset serves all pages because they are identical.
     */
    const paperUri = useMemo(() => paperDataUri(paper), [paper]);
    const paperUriRef = useRef(paperUri);
    useEffect(() => { paperUriRef.current = paperUri; }, [paperUri]);

    const assetStore = useMemo<TLAssetStore>(() => ({
        upload: inlineBase64AssetStore.upload,     // images the user pastes in
        resolve(asset, ctx) {
            // Resolved rather than stored, exactly as PdfAnnotateCanvas does it:
            // the snapshot keeps a stable `asset:notebook-paper` reference, so
            // re-ruling the notebook swaps what that resolves to instead of
            // rewriting an asset record — and the file never carries the markup.
            if (asset.meta?.notebookPaper) return paperUriRef.current;
            return inlineBase64AssetStore.resolve?.(asset, ctx) ?? asset.props.src;
        },
    }), []);

    /**
     * Write the whole file: paper, snapshot and pickers together.
     *
     * One funnel for all three because they share a file — changing the ruling
     * has to save the ink alongside it, or the next load would re-paper a
     * document whose strokes had not been written down yet.
     */
    const persist = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) return;
        onContentChangeRef.current(filePath, serializeNotebookFile({
            paper: paperRef.current,
            snapshot: getSnapshot(editor.store),
            ui: uiRef.current,
        }));
    }, [filePath]);

    /** Everything the user has written: every shape that is not a page. */
    const inkShapes = useCallback((editor: Editor): TLShape[] =>
        editor.getCurrentPageShapes().filter(s => !pageShapeIdsRef.current.has(s.id)), []);

    /**
     * Rebuild the page backdrops to match `paper`.
     *
     * Runs inside `mergeRemoteChanges` so re-papering never marks the file dirty
     * on its own — the paper block is saved by whoever changed it, and merely
     * opening a notebook must not rewrite it.
     */
    const layOutPages = useCallback((editor: Editor, next: NotebookPaper) => {
        const size = paperPageSize(next);
        const boxes = pageLayout(Array.from({ length: next.pageCount }, () => size));
        const assetId = AssetRecordType.createId('notebook-paper');

        // `ignoreShapeLock`, and it is load-bearing: the pages are locked so a
        // stray drag cannot shift one out from under the writing on it, and
        // `updateShape`/`deleteShapes` SILENTLY SKIP locked shapes. Without this
        // the artwork re-generated at the new size while every page box kept the
        // old one — which is what "landscape doesn't rotate them" looked like.
        editor.run(() => editor.store.mergeRemoteChanges(() => {
            // A COMPLETE record either way, never a partial one. tldraw
            // validates an updated asset in full, so passing only the props that
            // changed fails on the ones left out ("props.name: expected string,
            // got undefined") — and spreading the existing props instead runs
            // into TLAsset being a union whose members have different props.
            // Every field is known here, so state them all and be done.
            const existing = editor.getAsset(assetId);
            const record = {
                id: assetId,
                type: 'image' as const,
                typeName: 'asset' as const,
                props: {
                    name: 'paper.svg',
                    // Not the markup: see assetStore above.
                    src: 'asset:notebook-paper',
                    // A re-ruling can change the page SIZE, and the asset's own
                    // dimensions are what tldraw measures an image shape against.
                    w: size.width,
                    h: size.height,
                    mimeType: 'image/svg+xml',
                    isAnimated: false,
                },
                // The bumped rev is what makes the record differ, so the
                // resolver is asked again and the new ruling actually appears.
                meta: { notebookPaper: true, rev: (Number(existing?.meta?.rev) || 0) + 1 },
            };
            if (existing) editor.updateAssets([record]);
            else editor.createAssets([record]);

            const wanted = boxes.map((_, i) => pageShapeId(i));
            const present = new Set(editor.getCurrentPageShapes()
                .filter(s => s.meta?.notebookPage !== undefined)
                .map(s => s.id));

            // Pages beyond the new count go; the rest are updated in place, so a
            // re-ruling never re-creates a page and lands it OVER the writing on
            // it (createShapes appends to the top of the z-order).
            const stale = [...present].filter(id => !wanted.includes(id));
            if (stale.length) editor.deleteShapes(stale);

            const create = [];
            for (let i = 0; i < boxes.length; i++) {
                const id = wanted[i];
                const shape = {
                    id,
                    type: 'image' as const,
                    x: boxes[i].x,
                    y: boxes[i].y,
                    isLocked: true,
                    props: { assetId, w: boxes[i].width, h: boxes[i].height },
                    meta: { notebookPage: i },
                };
                if (present.has(id)) editor.updateShape(shape);
                else create.push(shape);
            }
            if (create.length) editor.createShapes(create);

            editor.sendToBack(wanted);
            pageShapeIdsRef.current = new Set(wanted);
        }), { ignoreShapeLock: true });
    }, []);

    /**
     * Grow the notebook when writing reaches the bottom of the last page.
     *
     * Pages are only ever ADDED here. Removing one because it looks empty would
     * throw away a page the user deliberately left blank — and, worse, could do
     * it while they were still on their way to it.
     */
    const growIfNeeded = useCallback((editor: Editor) => {
        const current = paperRef.current;
        if (current.pageCount >= MAX_PAGES) return;

        const size = paperPageSize(current);
        const boxes = pageLayout(Array.from({ length: current.pageCount }, () => size));
        const last = boxes[boxes.length - 1];
        const trigger = last.y + last.height * (1 - APPEND_MARGIN_FRACTION);

        let deepest = -Infinity;
        for (const shape of inkShapes(editor)) {
            const bounds = editor.getShapePageBounds(shape.id);
            if (bounds) deepest = Math.max(deepest, bounds.maxY);
        }
        if (deepest < trigger) return;

        // How many pages the writing has actually run past, so one long paste
        // lands on enough paper rather than one page per debounce tick.
        const overflow = deepest - trigger;
        const add = Math.max(1, Math.ceil(overflow / (size.height + 24)));
        const next = { ...current, pageCount: Math.min(MAX_PAGES, current.pageCount + add) };
        paperRef.current = next;
        setPaper(next);
        layOutPages(editor, next);
    }, [inkShapes, layOutPages]);

    const handleMount = useCallback((editor: Editor) => {
        editorRef.current = editor;

        // Below 50% zoom tldraw degrades draw-shapes to a thin centerline (an
        // LOD for huge boards). Fidelity beats that perf saving at this app's
        // scale — the same clamp DrawingPane applies, and for the same reason.
        const realEfficientZoom = editor.getEfficientZoomLevel.bind(editor);
        editor.getEfficientZoomLevel = () =>
            editor.getCurrentPageShapeIds().size > FULL_INK_SHAPE_LIMIT
                ? realEfficientZoom()
                : Math.max(0.5, realEfficientZoom());

        const disposePen = applyPenDefaults(editor);

        // Everything below runs BEFORE the listeners attach, so none of it marks
        // a just-opened file dirty.
        layOutPages(editor, paperRef.current);

        const ui = uiRef.current;
        if (ui) {
            try {
                if (ui.stylesForNextShape) editor.updateInstanceState({ stylesForNextShape: ui.stylesForNextShape });
                if (ui.toolId) editor.setCurrentTool(ui.toolId);
            } catch (err) {
                // A tool or style saved by a newer build — the defaults are a
                // fine fallback and the writing itself is intact.
                console.warn('Could not restore notebook UI state:', err);
            }
        } else {
            // A new notebook opens ready to write on, not ready to select.
            editor.setCurrentTool('draw');
        }

        // Frame the first page on a first-ever open; a reopen restores the
        // camera from the snapshot, and fitting would throw away where the user
        // had got to.
        if (!parsed.snapshot) {
            const size = paperPageSize(paperRef.current);
            editor.zoomToBounds(new Box(0, 0, size.width, size.height), { inset: FIT_INSET });
        }

        const readUi = (): NotebookUiState => ({
            toolId: editor.getCurrentToolId(),
            stylesForNextShape: editor.getInstanceState().stylesForNextShape,
        });
        let lastUi = JSON.stringify(readUi());

        const flush = () => {
            serializeTimerRef.current = null;
            // Before serializing, not after: a page appended here has to be in
            // the same write as the stroke that called for it.
            growIfNeeded(editor);
            const ui = readUi();
            lastUi = JSON.stringify(ui);
            uiRef.current = ui;
            persist();
        };

        const schedule = () => {
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            serializeTimerRef.current = setTimeout(flush, SERIALIZE_DEBOUNCE_MS);
        };

        // source: 'user'    → a programmatic load or a re-papering never dirties.
        // scope: 'document' → panning and zooming do not either.
        const unlistenDoc = editor.store.listen(schedule, { source: 'user', scope: 'document' });
        // The pickers live in session scope alongside camera noise that must NOT
        // dirty the file, so compare just the slice that gets persisted.
        const unlistenSession = editor.store.listen(() => {
            if (JSON.stringify(readUi()) !== lastUi) schedule();
        }, { source: 'user', scope: 'session' });

        return () => {
            editorRef.current = null;
            disposePen();
            unlistenDoc();
            unlistenSession();
            // Unmounting mid-debounce (tab switch, tab close) must not drop the
            // last strokes — flush them while the editor is still alive.
            if (serializeTimerRef.current) {
                clearTimeout(serializeTimerRef.current);
                flush();
            }
        };
    }, [growIfNeeded, layOutPages, parsed.snapshot, persist]);

    /**
     * Park what an export needs where the app's export handler can pick it up.
     *
     * The same shape as the PDF annotator's handoff, and for the same reason:
     * only the live canvas can turn shapes into page overlays, but the write
     * happens in App. Kept outside React state — these are binary and must never
     * enter a re-render path.
     */
    useEffect(() => {
        setNotebookRenderData(filePath, async () => {
            const editor = editorRef.current;
            if (!editor) return null;
            const current = paperRef.current;
            const size = paperPageSize(current);
            const boxes = pageLayout(Array.from({ length: current.pageCount }, () => size));

            // Bucket ink by page ONCE, rather than re-filtering per page —
            // the same O(pages x shapes) trap PdfAnnotateCanvas hit.
            const byPage: TLShape[][] = boxes.map(() => []);
            for (const shape of inkShapes(editor)) {
                const b = editor.getShapePageBounds(shape.id);
                if (!b) continue;
                for (let i = 0; i < boxes.length; i++) {
                    // Pages stack downward, so once a box starts below the
                    // shape's bottom edge no later box can overlap it either.
                    if (boxes[i].y >= b.maxY) break;
                    if (b.minY < boxes[i].y + boxes[i].height) byPage[i].push(shape);
                }
            }

            const overlays: Array<PageOverlay | undefined> = [];
            for (let i = 0; i < boxes.length; i++) {
                const shapes = byPage[i];
                if (!shapes.length) { overlays.push(undefined); continue; }
                const box = boxes[i];
                const options = {
                    background: false,
                    bounds: new Box(box.x, box.y, box.width, box.height),
                    padding: 0,
                    darkMode: false,
                } as const;

                const overlay: PageOverlay = {};
                const raster = shapes.filter(s => RASTER_ONLY_SHAPES.has(s.type));
                const vector = shapes.filter(s => !RASTER_ONLY_SHAPES.has(s.type));
                if (vector.length) {
                    const svg = await editor.getSvgString(vector.map(s => s.id), { ...options, scale: 1 });
                    const ops = svg ? svgToVectorOps(svg.svg) : null;
                    if (ops) overlay.vector = ops;
                    else raster.push(...vector);
                }
                if (raster.length) {
                    const image = await editor.toImage(raster.map(s => s.id), { ...options, format: 'png', scale: 2 });
                    overlay.raster = new Uint8Array(await image.blob.arrayBuffer());
                }
                overlays.push(isEmptyOverlay(overlay) ? undefined : overlay);
            }

            return { paper: current, overlays };
        });
    }, [filePath, inkShapes]);

    /**
     * Drop the last page.
     *
     * The LAST one specifically: pages are a stack, and removing one from the
     * middle would have to decide what happens to everything written below it.
     * Trailing pages are also what actually accumulates — writing low on a page
     * summons the next one, so overshooting leaves blanks at the end.
     *
     * Writing on that page goes with it, and is the one thing here that
     * destroys something the user made — so it asks first, and says how much.
     * An empty page just goes.
     */
    const removeLastPage = useCallback(async () => {
        const editor = editorRef.current;
        const current = paperRef.current;
        if (!editor || current.pageCount <= 1) return;

        const size = paperPageSize(current);
        const boxes = pageLayout(Array.from({ length: current.pageCount }, () => size));
        const last = boxes[boxes.length - 1];
        const doomed = inkShapes(editor).filter(shape => {
            const b = editor.getShapePageBounds(shape.id);
            // Anything that starts below the last page's top belongs to it. A
            // stroke straddling the boundary is kept: it is mostly on the page
            // that survives, and dropping it would delete from a page the user
            // did not ask to remove.
            return b ? b.minY >= last.y : false;
        });

        if (doomed.length) {
            const ok = await onConfirmRef.current({
                title: `Delete page ${current.pageCount}?`,
                body: `It has ${doomed.length} ${doomed.length === 1 ? 'stroke' : 'strokes'} on it, which will be deleted with it.`,
                confirmLabel: 'Delete page',
                danger: true,
            });
            if (!ok) return;
            // A user deletion, not a remote merge: this SHOULD dirty the file.
            editor.deleteShapes(doomed.map(s => s.id));
        }

        const next = { ...current, pageCount: current.pageCount - 1 };
        paperRef.current = next;
        setPaper(next);
        layOutPages(editor, next);
        persist();
    }, [inkShapes, layOutPages, persist]);

    const changePaper = useCallback((patch: Partial<NotebookPaper>) => {
        const next = { ...paperRef.current, ...patch };
        paperRef.current = next;
        setPaper(next);
        const editor = editorRef.current;
        if (editor) layOutPages(editor, next);
        // Re-papering is a document change the user made, but it reaches the
        // store as a 'remote' merge (so opening a file cannot dirty it) — which
        // means the save listener will not see it. Write it out here instead.
        persist();
    }, [layOutPages, persist]);

    return (
        <div className="drawing-pane notebook-pane">
            <NotebookToolbar paper={paper} onChange={changePaper} onRemovePage={removeLastPage} />
            <Tldraw
                snapshot={parsed.snapshot}
                assets={assetStore}
                onMount={handleMount}
                components={CANVAS_COMPONENTS}
                colorScheme={NOTEBOOK_COLOR_SCHEME}
                licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
            />
        </div>
    );
}

/** Paper settings, over the canvas's top-left where tldraw leaves room. */
function NotebookToolbar({ paper, onChange, onRemovePage }: {
    paper: NotebookPaper;
    onChange: (patch: Partial<NotebookPaper>) => void;
    onRemovePage: () => void;
}) {
    return (
        <div className="notebook-toolbar">
            <select
                className="notebook-select"
                value={paper.ruling}
                onChange={e => onChange({ ruling: e.target.value as NotebookPaper['ruling'] })}
                title="Ruling"
            >
                <option value="lined">Lined</option>
                <option value="grid">Grid</option>
                <option value="dotted">Dotted</option>
                <option value="blank">Blank</option>
            </select>
            <select
                className="notebook-select"
                value={paper.size}
                onChange={e => onChange({ size: e.target.value as NotebookPaper['size'] })}
                title="Page size"
            >
                <option value="letter">Letter</option>
                <option value="a4">A4</option>
                <option value="legal">Legal</option>
            </select>
            <button
                className="notebook-toolbar-btn"
                onClick={() => onChange({ orientation: paper.orientation === 'portrait' ? 'landscape' : 'portrait' })}
                title="Rotate the pages"
            >
                {paper.orientation === 'portrait' ? 'Portrait' : 'Landscape'}
            </button>
            <span className="notebook-page-count">
                {paper.pageCount} {paper.pageCount === 1 ? 'page' : 'pages'}
            </span>
            <button
                className="notebook-toolbar-btn"
                onClick={onRemovePage}
                disabled={paper.pageCount <= 1}
                title="Delete the last page"
                aria-label="Delete the last page"
            >
                − Page
            </button>
            <button
                className="notebook-toolbar-btn"
                onClick={() => onChange({ pageCount: Math.min(MAX_PAGES, paper.pageCount + 1) })}
                disabled={paper.pageCount >= MAX_PAGES}
                title="Add a page"
            >
                + Page
            </button>
        </div>
    );
}
