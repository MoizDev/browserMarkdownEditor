import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Tldraw, getSnapshot } from 'tldraw';
import type { Editor, TLEditorSnapshot } from 'tldraw';
import 'tldraw/tldraw.css';
import type { Theme } from '../types';

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

/** The tool and style pickers (color, pen size, dash, fill…) live in tldraw's
 *  instance state, which its document AND session snapshots both omit — so
 *  they're persisted as an extra `ui` block in the file, and put back on open
 *  exactly as the user left them. */
interface SavedUiState {
    toolId?: string;
    stylesForNextShape?: Record<string, unknown>;
}

/** Drawing a single stroke fires a burst of store transactions; serializing the
 *  whole document on each one would be wasteful. Coalesce, then hand off to the
 *  app's own 1s save debounce. */
const SERIALIZE_DEBOUNCE_MS = 400;

/** Up to this many shapes on a page, zoomed-out strokes keep their full ink
 *  rendering; past it, tldraw's low-zoom thin-line LOD applies as designed. */
const FULL_INK_SHAPE_LIMIT = 1000;

function parseDrawingFile(content: string): { snapshot?: TLEditorSnapshot; ui?: SavedUiState } {
    if (!content.trim()) return {}; // new/empty file → blank canvas
    try {
        // Files written before the `ui` block existed are plain snapshots;
        // destructuring just yields ui === undefined for those.
        const { ui, ...snapshot } = JSON.parse(content) as TLEditorSnapshot & { ui?: SavedUiState };
        return { snapshot, ui };
    } catch (err) {
        // Don't destroy an unreadable file: mounting blank would autosave over
        // it on the first stroke. Better to show an empty canvas and let the
        // user close the tab with the bytes still intact on disk.
        console.error('Could not parse drawing (leaving the file untouched):', err);
        return {};
    }
}

function readUiState(editor: Editor): SavedUiState {
    return {
        toolId: editor.getCurrentToolId(),
        stylesForNextShape: editor.getInstanceState().stylesForNextShape,
    };
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

        // Restore the saved pickers BEFORE the listeners attach: these writes
        // are indistinguishable from user edits, and a restore must not mark a
        // just-opened file dirty.
        if (ui) {
            try {
                if (ui.stylesForNextShape) {
                    editor.updateInstanceState({ stylesForNextShape: ui.stylesForNextShape });
                }
                if (ui.toolId) editor.setCurrentTool(ui.toolId);
            } catch (err) {
                // A tool/style saved by a newer build than this one — the
                // defaults are a fine fallback, the drawing itself is intact.
                console.warn('Could not restore drawing UI state:', err);
            }
        }

        let lastUi = JSON.stringify(readUiState(editor));

        const flush = () => {
            serializeTimerRef.current = null;
            const uiNow = readUiState(editor);
            lastUi = JSON.stringify(uiNow);
            onContentChangeRef.current(filePath, JSON.stringify({ ...getSnapshot(editor.store), ui: uiNow }));
        };

        const schedule = () => {
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            serializeTimerRef.current = setTimeout(flush, SERIALIZE_DEBOUNCE_MS);
        };

        // source: 'user'     → a programmatic load never marks the file dirty.
        // scope: 'document'  → panning/zooming (session state) doesn't either.
        const unlistenDoc = editor.store.listen(schedule, { source: 'user', scope: 'document' });

        // The pickers live in session scope alongside camera/selection noise
        // that must NOT dirty the file — so compare just the slice we persist
        // and only save when THAT changed.
        const unlistenSession = editor.store.listen(() => {
            if (JSON.stringify(readUiState(editor)) !== lastUi) schedule();
        }, { source: 'user', scope: 'session' });

        return () => {
            editorRef.current = null;
            unlistenDoc();
            unlistenSession();
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
