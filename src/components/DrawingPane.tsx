import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Box, Tldraw, getSnapshot, react } from 'tldraw';
import type { Editor, TLEditorSnapshot } from 'tldraw';
import 'tldraw/tldraw.css';
import type { Theme } from '../types';
import { CANVAS_COMPONENTS, CANVAS_OPTIONS, CANVAS_SHAPE_UTILS, applyCanvasUi, applyPenDefaults, readCanvasUi, serializeDelay, type CanvasUiState } from './canvasPen';
import { bindImageInvertKey } from './invertibleImageShape';
import { subscribePenScale } from '../utils/penStyle';
import { flushCanvasViewPositions, readCanvasViewPos, writeCanvasViewPos } from '../utils/canvasViewState';
import { registerView, type DrawingViewInfo } from '../utils/viewRegistry';
import { captureRegion, createCanvasAgentOps, selectedAgentShapeIds, summarizeShapes, type CanvasPageModel } from './canvasAgentOps';

interface DrawingPaneProps {
    /** The drawing's vault path. Every change is reported against it explicitly
     *  (never "the active tab") so a save landing after a tab switch cannot
     *  write drawing JSON into another file's buffer. */
    filePath: string;
    /** The file's text: a serialized tldraw snapshot, or '' for a new drawing. */
    content: string;
    onContentChange: (path: string, content: string) => void;
    theme: Theme;
}

/** Drawing a single stroke fires a burst of store transactions; serializing the
 *  whole document on each one would be wasteful. Coalesce, then hand off to the
 *  app's own 1s save debounce. */
const SERIALIZE_DEBOUNCE_MS = 400;

/** Up to this many shapes on a page, zoomed-out strokes keep their full ink
 *  rendering; past it, tldraw's low-zoom thin-line LOD applies as designed. */
const FULL_INK_SHAPE_LIMIT = 1000;

/** How long the camera must rest before where it rests reaches storage. */
const VIEW_PERSIST_DEBOUNCE_MS = 400;

/** A whiteboard has no pages to be relative to and no backdrop to protect:
 *  the agent's coordinates are the canvas's own. */
const WHITEBOARD_MODEL: CanvasPageModel = {
    boxes: () => [],
    currentPage: () => 0,
    isBackdrop: () => false,
};

function parseDrawingFile(content: string): { snapshot?: TLEditorSnapshot; ui?: CanvasUiState } {
    if (!content.trim()) return {}; // new/empty file → blank canvas
    try {
        // Files written before the `ui` block existed are plain snapshots;
        // destructuring just yields ui === undefined for those.
        const { ui, ...snapshot } = JSON.parse(content) as TLEditorSnapshot & { ui?: CanvasUiState };
        return { snapshot, ui };
    } catch (err) {
        // Don't destroy an unreadable file: mounting blank would autosave over
        // it on the first stroke. Better to show an empty canvas and let the
        // user close the tab with the bytes still intact on disk.
        console.error('Could not parse drawing (leaving the file untouched):', err);
        return {};
    }
}

/**
 * A tldraw whiteboard bound to one `.tldraw` file. The document is loaded from
 * the file's JSON once on mount; from then on tldraw owns it, and every user
 * edit is serialized back out through onContentChange — the same funnel
 * CodeMirror uses, so dirty-tracking, autosave, Cmd+S and close-flush all work
 * unchanged.
 */
export default function DrawingPane({ filePath, content, onContentChange, theme }: DrawingPaneProps) {
    const onContentChangeRef = useRef(onContentChange);
    useEffect(() => { onContentChangeRef.current = onContentChange; }, [onContentChange]);

    // The colorScheme prop is only honored at mount (and a persisted tldraw
    // user preference can override even that) — so the app theme is pushed
    // into tldraw's user preferences on mount and on every toggle. Dark mode
    // then picks up the custom canvas color via .tl-theme__dark CSS; light
    // mode keeps tldraw's stock white.
    const editorRef = useRef<Editor | null>(null);
    const themeRef = useRef(theme);
    useEffect(() => {
        themeRef.current = theme;
        editorRef.current?.user.updateUserPreferences({ colorScheme: theme === 'light' ? 'light' : 'dark' });
    }, [theme]);

    // Parsed once per FILE, not per render: `content` changes on every save
    // round-trip, but tldraw owns the document after mount, so re-reading it
    // would be pointless work (and could clobber in-progress edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const { snapshot, ui } = useMemo(() => parseDrawingFile(content), [filePath]);

    const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleMount = useCallback((editor: Editor) => {
        editorRef.current = editor;
        editor.user.updateUserPreferences({ colorScheme: themeRef.current === 'light' ? 'light' : 'dark' });

        // Below 50% zoom tldraw degrades draw-shapes to a thin solid
        // centerline (an LOD for huge boards) — the sudden hairline look when
        // zooming out. Fidelity beats that perf saving at this app's scale,
        // so the "efficient" zoom that every LOD check reads is clamped at
        // the 0.5 threshold; the real camera zoom is untouched. On genuinely
        // huge pages the LOD gets its job back — repainting thousands of
        // full-ink outlines mid-zoom is where it actually earns its keep.
        // (Both reads are signal-backed, so LOD checks re-run on crossings.)
        const realEfficientZoom = editor.getEfficientZoomLevel.bind(editor);
        editor.getEfficientZoomLevel = () =>
            editor.getCurrentPageShapeIds().size > FULL_INK_SHAPE_LIMIT
                ? realEfficientZoom()
                : Math.max(0.5, realEfficientZoom());

        // Restore the saved pen BEFORE the listeners attach: these writes are
        // indistinguishable from user edits, and a restore must not mark a
        // just-opened file dirty. Also before applyPenDefaults, whose shape
        // handler reads the width this seeds.
        applyCanvasUi(editor, ui);
        const disposePen = applyPenDefaults(editor);
        // `i` inverts a selected picture — see invertibleImageShape.tsx.
        const disposeInvert = bindImageInvertKey(editor);

        let lastUi = JSON.stringify(readCanvasUi(editor));

        const flush = () => {
            serializeTimerRef.current = null;
            const uiNow = readCanvasUi(editor);
            lastUi = JSON.stringify(uiNow);
            onContentChangeRef.current(filePath, JSON.stringify({ ...getSnapshot(editor.store), ui: uiNow }));
        };

        // Mid-stroke the document is about to change again, and serializing a
        // big board is exactly what the pen would feel — so wait for the hand
        // to lift and pay it once, rather than in the middle of a line.
        const tick = () => {
            if (editor.inputs.isPointing) {
                serializeTimerRef.current = setTimeout(tick, SERIALIZE_DEBOUNCE_MS);
                return;
            }
            flush();
        };

        const schedule = () => {
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            serializeTimerRef.current = setTimeout(tick, serializeDelay(editor, SERIALIZE_DEBOUNCE_MS));
        };

        // Reopen where the reader LEFT it, not where the file was last saved:
        // the snapshot's session camera is only as new as the last stroke, so
        // a board panned across and closed came back wherever the drawing
        // stopped. Session state, and before the listeners attach, so neither
        // the page switch nor the camera marks the file dirty. No record: the
        // snapshot's camera, exactly as before.
        const remembered = readCanvasViewPos(filePath);
        if (remembered?.kind === 'drawing') {
            // A page since deleted takes its camera with it: that place was on
            // a page that is no longer there.
            const page = editor.getPages().find(p => p.id === remembered.pageId);
            if (page) {
                if (page.id !== editor.getCurrentPageId()) editor.setCurrentPage(page.id);
                editor.setCamera({ x: remembered.x, y: remembered.y, z: remembered.z });
            }
        }

        // And remember it as it moves. A `react()` on the camera and the page,
        // which runs when the VIEW changes — not a session-scope store
        // listener, which fires on every pointer move while drawing. Memory on
        // every change (a property write), storage once the camera rests.
        let viewTimer: ReturnType<typeof setTimeout> | null = null;
        let viewMounted = false;
        const stopViewWatch = react('drawing view position', () => {
            const { x, y, z } = editor.getCamera();
            const pageId = editor.getCurrentPageId();
            // The first run is the camera just restored (or the file's own):
            // nothing moved, so nothing to write.
            if (!viewMounted) { viewMounted = true; return; }
            writeCanvasViewPos(filePath, { kind: 'drawing', pageId, x, y, z }, false);
            if (viewTimer) clearTimeout(viewTimer);
            viewTimer = setTimeout(() => { viewTimer = null; flushCanvasViewPositions(); }, VIEW_PERSIST_DEBOUNCE_MS);
        });
        // A reload or a closed window unmounts nothing, so the last pan would
        // die in the debounce without this.
        const onPageHide = () => {
            if (viewTimer) { clearTimeout(viewTimer); viewTimer = null; flushCanvasViewPositions(); }
            // A big board waits longer between saves, so more strokes can be
            // outstanding here — and a reload unmounts nothing.
            if (serializeTimerRef.current) { clearTimeout(serializeTimerRef.current); flush(); }
        };
        window.addEventListener('pagehide', onPageHide);

        // What the agent sees and draws through (utils/viewRegistry.ts). Built
        // here, from the live editor, and read only when a message is sent.
        const ops = createCanvasAgentOps(editor, WHITEBOARD_MODEL);
        const unregisterView = registerView(filePath, {
            kind: 'drawing',
            canvas: ops,
            describe(): DrawingViewInfo {
                const pages = editor.getPages();
                const current = editor.getCurrentPage();
                const view = editor.getViewportPageBounds();
                const { x, y, z } = editor.getCamera();
                const { shapes, total } = summarizeShapes(editor, WHITEBOARD_MODEL, b => Box.Collides(b, view));
                return {
                    kind: 'drawing',
                    pageName: current.name,
                    pageIndex: Math.max(0, pages.findIndex(p => p.id === current.id)),
                    pageCount: pages.length,
                    camera: { x, y, z },
                    viewport: { x: view.x, y: view.y, w: view.w, h: view.h },
                    selectedShapeIds: selectedAgentShapeIds(editor, WHITEBOARD_MODEL),
                    shapes,
                    shapesTotal: total,
                };
            },
            // The view as it is on screen, at no more than twice its on-screen
            // size.
            capture: (maxSide) => captureRegion(editor, editor.getViewportPageBounds(), maxSide, editor.getZoomLevel() * 2),
            // A stroke still inside the serialize debounce is an edit App cannot
            // see yet; reloading the file from disk over it would lose it.
            hasPendingEdits: () => serializeTimerRef.current !== null,
            flushPending: () => {
                if (!serializeTimerRef.current) return;
                clearTimeout(serializeTimerRef.current);
                flush();
            },
        });

        // source: 'user'     → a programmatic load never marks the file dirty.
        // scope: 'document'  → panning/zooming (session state) doesn't either.
        // The agent's canvas edits are 'user' too (editor API, no remote merge
        // — see canvasAgentOps.ts), so they are saved exactly like a stroke.
        const unlistenDoc = editor.store.listen(schedule, { source: 'user', scope: 'document' });

        // The pickers live in session scope alongside camera/selection noise
        // that must NOT dirty the file — so compare just the slice we persist
        // and only save when THAT changed.
        const saveUiIfChanged = () => {
            if (JSON.stringify(readCanvasUi(editor)) !== lastUi) schedule();
        };
        const unlistenSession = editor.store.listen(saveUiIfChanged, { source: 'user', scope: 'session' });
        // Pen WIDTH is not a tldraw style, so changing it touches no store and
        // the listener above never sees it. Without this the width was only
        // remembered if you happened to draw afterwards.
        const unlistenPen = subscribePenScale(saveUiIfChanged);

        return () => {
            editorRef.current = null;
            unregisterView();
            stopViewWatch();
            window.removeEventListener('pagehide', onPageHide);
            // The memory record is current (the watch writes it on every
            // change); only the flush can still be pending.
            if (viewTimer) { clearTimeout(viewTimer); flushCanvasViewPositions(); }
            disposePen();
            disposeInvert();
            unlistenDoc();
            unlistenSession();
            unlistenPen();
            // Unmounting mid-debounce (tab switch, tab close) must not drop the
            // last strokes — flush them synchronously while the editor is alive.
            if (serializeTimerRef.current) {
                clearTimeout(serializeTimerRef.current);
                flush();
            }
        };
    }, [filePath, ui]);

    return (
        <div className="drawing-pane">
            <Tldraw
                snapshot={snapshot}
                onMount={handleMount}
                components={CANVAS_COMPONENTS}
                shapeUtils={CANVAS_SHAPE_UTILS}
                options={CANVAS_OPTIONS}
                colorScheme={theme === 'light' ? 'light' : 'dark'}
                // Required once deployed, not cosmetic: on a non-localhost HTTPS
                // origin, tldraw with no key reports `unlicensed-production` and
                // replaces the canvas with an empty gate 5s after load. Localhost
                // counts as development, so a missing key only shows up in prod.
                licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
            />
        </div>
    );
}
