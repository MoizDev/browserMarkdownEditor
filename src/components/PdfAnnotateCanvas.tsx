import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tldraw, getSnapshot, AssetRecordType, createShapeId, Box, inlineBase64AssetStore } from 'tldraw';
import type { Editor, TLAssetId, TLAssetStore, TLEditorSnapshot, TLImageShape, TLShapeId } from 'tldraw';
import 'tldraw/tldraw.css';
import type { Theme } from '../types';
import { pageLayout, openPdfPages, type PdfPageSize } from '../utils/pdfAnnotation';
import { setPdfRenderData } from '../utils/pdfRenderCache';

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
    theme: Theme;
}

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

function parseSnapshot(content: string): TLEditorSnapshot | undefined {
    if (!content.trim()) return undefined;
    try {
        return JSON.parse(content) as TLEditorSnapshot;
    } catch (err) {
        console.error('Could not parse PDF annotations (leaving the file untouched):', err);
        return undefined;
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
export default function PdfAnnotateCanvas({ filePath, original, snapshot, onContentChange, onFlushNow, onFlushStart, theme }: PdfAnnotateCanvasProps) {
    // Geometry only. The canvas mounts as soon as this lands; the page images
    // stream in afterwards through pageUrlsRef.
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
    const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Page image URLs as they arrive, by page index. Read by the asset store. */
    const pageUrlsRef = useRef<Array<string | undefined>>([]);
    /** The live editor, so streamed pages can refresh their assets. */
    const editorRef = useRef<Editor | null>(null);
    /** Shape ids of the page backdrops — never exported, never saved as strokes. */
    const pageShapeIdsRef = useRef<Set<TLShapeId>>(new Set());
    /** Last exported overlay per page index, keyed by that page's shape signature. */
    const overlayCacheRef = useRef<Map<number, { signature: string; bytes: Uint8Array | undefined }>>(new Map());
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
            if (typeof page === 'number') return pageUrlsRef.current[page] ?? null;
            return inlineBase64AssetStore.resolve?.(asset, ctx) ?? asset.props.src;
        },
    }), []);

    // Open the PDF and stream its pages in. Always the pristine original:
    // rendering the stamped pages would show baked-in strokes behind their own
    // editable copies.
    useEffect(() => {
        let cancelled = false;
        const urls: Array<string | undefined> = [];
        let source: Awaited<ReturnType<typeof openPdfPages>> | null = null;

        (async () => {
            try {
                source = await openPdfPages(original);
                if (cancelled) { await source.close(); return; }

                // Geometry is enough to lay out and mount the canvas — no need to
                // wait on a single pixel. Set the ref before the state: <Tldraw>
                // mounts the moment `pages` is non-null and immediately asks the
                // asset store to resolve page URLs through this ref.
                pageUrlsRef.current = urls;
                setPages(source.sizes);

                for (let i = 0; i < source.sizes.length; i++) {
                    const url = await source.renderPage(i);
                    if (cancelled) { URL.revokeObjectURL(url); return; }
                    urls[i] = url;

                    // Nudge tldraw to re-resolve this page's asset now that it has
                    // an image. mergeRemoteChanges marks the edit as 'remote', so
                    // the 'user'-scoped save listener ignores it — otherwise
                    // merely opening a file would mark it dirty and rewrite it.
                    const editor = editorRef.current;
                    const assetId = AssetRecordType.createId(`pdf-page-${i}`);
                    const asset = editor?.getAsset(assetId);
                    if (editor && asset) {
                        editor.store.mergeRemoteChanges(() => {
                            editor.updateAssets([{
                                ...asset,
                                meta: { ...asset.meta, pdfPage: i, rev: (Number(asset.meta?.rev) || 0) + 1 },
                            }]);
                        });
                    }
                }
            } catch (err) {
                console.error('Could not render PDF pages:', err);
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            }
        })();

        return () => {
            cancelled = true;
            pageUrlsRef.current = [];
            for (const url of urls) if (url) URL.revokeObjectURL(url);
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
        if (!parsed) editor.zoomToFit();

        for (const shape of editor.getCurrentPageShapes()) {
            if (shape.meta?.pdfPage !== undefined) pageShapeIdsRef.current.add(shape.id);
        }

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

            const overlays: Array<Uint8Array | undefined> = [];
            for (let i = 0; i < boxes.length; i++) {
                const box = boxes[i];
                const onThisPage = annotations.filter(s => {
                    const b = editor.getShapePageBounds(s.id);
                    return b && b.maxY > box.y && b.minY < box.y + box.height;
                });

                // Re-render a page only when its own annotations actually changed.
                // Rasterizing is main-thread work (it needs the DOM, so unlike the
                // PDF build it can't be moved off), and a stroke on page 1 must not
                // cost a re-render of pages 2..N. The signature covers every shape
                // on the page, so a moved or recoloured stroke still invalidates.
                const signature = JSON.stringify(onThisPage);
                const cached = overlayCacheRef.current.get(i);
                if (cached?.signature === signature) { overlays.push(cached.bytes); continue; }

                if (!onThisPage.length) {
                    overlayCacheRef.current.set(i, { signature, bytes: undefined });
                    overlays.push(undefined);
                    continue;
                }

                try {
                    // bounds = exactly the page box, so the PNG maps 1:1 onto the
                    // page when stamped; padding 0 or it would shift.
                    const image = await editor.toImage(onThisPage.map(s => s.id), {
                        format: 'png',
                        background: false,
                        bounds: new Box(box.x, box.y, box.width, box.height),
                        padding: 0,
                        scale: 2,
                    });
                    const bytes = new Uint8Array(await image.blob.arrayBuffer());
                    overlayCacheRef.current.set(i, { signature, bytes });
                    overlays.push(bytes);
                } catch (err) {
                    console.error(`Could not export annotations for page ${i + 1}:`, err);
                    // Reuse the last good overlay rather than dropping this page's
                    // annotations out of the file on a transient export failure.
                    overlays.push(cached?.bytes);
                }
            }

            // Hand the binary to the save path, then report the snapshot as this
            // tab's content — that marks it dirty and triggers the write.
            setPdfRenderData(filePath, { original, overlays });
            const json = JSON.stringify(getSnapshot(editor.store));
            if (immediate) onFlushNowRef.current(filePath, json);
            else onContentChangeRef.current(filePath, json);
        };

        const unlisten = editor.store.listen(() => {
            hasUnsavedRef.current = true;
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            serializeTimerRef.current = setTimeout(() => { void flush(); }, SERIALIZE_DEBOUNCE_MS);
        }, { source: 'user', scope: 'document' });

        return () => {
            unlisten();
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            // Write on the way out so the viewer (which re-reads immediately) sees
            // the strokes — but only if there are any. Flushing unconditionally
            // would rewrite the whole PDF every time the mode was toggled.
            if (hasUnsavedRef.current) {
                onFlushStartRef.current();   // synchronous: beats the viewer's read
                void flush(true);
            }
        };
    }, [filePath, original, pages, parsed]);

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
        <div className="drawing-pane">
            <Tldraw
                snapshot={parsed}
                assets={assetStore}
                onMount={handleMount}
                colorScheme={theme === 'light' ? 'light' : 'dark'}
                licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
            />
        </div>
    );
}
