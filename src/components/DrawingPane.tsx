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

/** Drawing a single stroke fires a burst of store transactions; serializing the
 *  whole document on each one would be wasteful. Coalesce, then hand off to the
 *  app's own 1s save debounce. */
const SERIALIZE_DEBOUNCE_MS = 400;

function parseSnapshot(content: string): TLEditorSnapshot | undefined {
    if (!content.trim()) return undefined; // new/empty file → blank canvas
    try {
        return JSON.parse(content) as TLEditorSnapshot;
    } catch (err) {
        // Don't destroy an unreadable file: mounting blank would autosave over
        // it on the first stroke. Better to show an empty canvas and let the
        // user close the tab with the bytes still intact on disk.
        console.error('Could not parse drawing (leaving the file untouched):', err);
        return undefined;
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

    // Parsed once per FILE, not per render: `content` changes on every save
    // round-trip, but tldraw owns the document after mount, so re-reading it
    // would be pointless work (and could clobber in-progress edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const snapshot = useMemo(() => parseSnapshot(content), [filePath]);

    const serializeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleMount = useCallback((editor: Editor) => {
        const flush = () => {
            serializeTimerRef.current = null;
            onContentChangeRef.current(filePath, JSON.stringify(getSnapshot(editor.store)));
        };

        // source: 'user'     → a programmatic load never marks the file dirty.
        // scope: 'document'  → panning/zooming (session state) doesn't either.
        const unlisten = editor.store.listen(() => {
            if (serializeTimerRef.current) clearTimeout(serializeTimerRef.current);
            serializeTimerRef.current = setTimeout(flush, SERIALIZE_DEBOUNCE_MS);
        }, { source: 'user', scope: 'document' });

        return () => {
            unlisten();
            // Unmounting mid-debounce (tab switch, tab close) must not drop the
            // last strokes — flush them synchronously while the editor is alive.
            if (serializeTimerRef.current) {
                clearTimeout(serializeTimerRef.current);
                flush();
            }
        };
    }, [filePath]);

    return (
        <div className="drawing-pane">
            <Tldraw
                snapshot={snapshot}
                onMount={handleMount}
                colorScheme={theme === 'light' ? 'light' : 'dark'}
                // A free non-commercial license key from tldraw.dev goes here to
                // drop the corner watermark: licenseKey="..."
            />
        </div>
    );
}
