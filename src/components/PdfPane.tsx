import { lazy, Suspense, useEffect, useState } from 'react';
import { useFileSystem } from '../context/FileSystemContext';
import { readAnnotatedPdf } from '../utils/pdfAnnotation';
import { isAnnotatedPdf } from '../utils/fileTypes';
import type { ActiveFile, EditorMode, Theme } from '../types';

// tldraw + pdf.js rasterization are heavy and only needed once someone actually
// annotates, so the canvas is a separate chunk. Viewing a PDF never loads it.
const PdfAnnotateCanvas = lazy(() => import('./PdfAnnotateCanvas'));

interface PdfPaneProps {
    file: ActiveFile;
    /** 'read' = view the real PDF, 'edit' = annotate. Reuses the per-tab mode. */
    mode: EditorMode;
    /** The tab's buffered tldraw snapshot (annotated files only). */
    content: string;
    onContentChange: (path: string, content: string) => void;
    /** Writes to disk immediately; used as the canvas hands over to the viewer. */
    onFlushNow: (path: string, content: string) => void;
    theme: Theme;
    /** Bumped after every completed save; re-reads the PDF shown in view mode. */
    saveEpoch: number;
    /** True while this tab has strokes not yet written to disk. */
    isDirty: boolean;
}

interface PdfSource {
    /** Pristine original bytes — only annotated files have them. */
    original: Uint8Array | null;
    /** Snapshot found on disk when the file was opened. */
    diskSnapshot: string;
}

/**
 * A PDF in the vault, in one of two modes.
 *
 * View mode hands the bytes to the browser's own PDF viewer, which gives real
 * scrolling, text selection, copy and search for free.
 *
 * Annotate mode is a tldraw canvas over rasterized pages. The two are separate
 * modes rather than one blended view because a rasterized page has no text to
 * select — the pixels are all that's left. See utils/pdfAnnotation.ts.
 */
export default function PdfPane({ file, mode, content, onContentChange, onFlushNow, theme, saveEpoch, isDirty }: PdfPaneProps) {
    const { readFileBytes } = useFileSystem();
    const [source, setSource] = useState<PdfSource | null>(null);
    const [viewUrl, setViewUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // True from the moment the canvas starts exporting until that save lands.
    // `isDirty` alone can't cover this: the export takes a moment, and the tab
    // isn't marked dirty until it finishes — a window in which the viewer would
    // happily read and show the pre-annotation file.
    const [flushing, setFlushing] = useState(false);
    useEffect(() => { setFlushing(false); }, [saveEpoch]);

    // Safety net: `flushing` normally clears when the save bumps saveEpoch, but a
    // save that THROWS never bumps it — which would leave "Applying annotations…"
    // covering the document for the rest of the session. Failing back to showing
    // the file (stale though it may be) beats hiding it forever.
    useEffect(() => {
        if (!flushing) return;
        const timer = setTimeout(() => {
            console.warn('PDF save did not complete in time; showing the file as it stands on disk.');
            setFlushing(false);
        }, 15000);
        return () => clearTimeout(timer);
    }, [flushing]);

    // Load once per file. Annotated files also yield the pristine original and
    // any existing snapshot out of their attachments.
    //
    // Deliberately does NOT depend on saveEpoch: `original` feeds the canvas,
    // and replacing it would re-rasterize every page mid-session.
    useEffect(() => {
        let cancelled = false;
        setSource(null);
        setError(null);

        (async () => {
            try {
                if (!file.handle) return;
                const bytes = await readFileBytes(file.handle as FileSystemFileHandle);

                // Trust the file's contents, not its name: a file named
                // "… (annotated).pdf" that we didn't write has no attachments and
                // must be treated as a plain PDF rather than crashing.
                const annotated = isAnnotatedPdf(file.name) ? await readAnnotatedPdf(bytes) : null;

                if (cancelled) return;
                setSource({
                    original: annotated?.original ?? null,
                    diskSnapshot: annotated?.snapshot ?? '',
                });
            } catch (err) {
                console.error('Could not open PDF:', err);
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            }
        })();

        return () => { cancelled = true; };
    }, [file.path, file.handle, file.name, readFileBytes]);

    // Re-read the file for view mode: on entering it, and again after each save.
    //
    // Both halves matter. Reading once at open would show the bytes from before
    // you drew — toggling back to View would show a stale PDF until the tab was
    // closed and reopened. And a save lands ~1s AFTER the toggle (the canvas
    // serializes, then the write is debounced), so re-reading only on toggle
    // would still catch the pre-save file; saveEpoch brings it current.
    useEffect(() => {
        // Don't read mid-flush: the bytes on disk are still the pre-annotation
        // ones. The save bumps saveEpoch, which clears `flushing` and re-runs this.
        if (mode !== 'read' || !file.handle || flushing) return;
        let cancelled = false;

        (async () => {
            try {
                const bytes = await readFileBytes(file.handle as FileSystemFileHandle);
                if (cancelled) return;
                // slice() before the Blob: pdf.js detaches buffers handed to it,
                // and these bytes may be read again.
                const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/pdf' }));
                setViewUrl(prev => {
                    if (prev) URL.revokeObjectURL(prev);
                    return url;
                });
            } catch (err) {
                console.error('Could not refresh the PDF view:', err);
            }
        })();

        return () => { cancelled = true; };
    }, [mode, saveEpoch, flushing, file.path, file.handle, readFileBytes]);

    // Release the last URL when the pane goes away.
    useEffect(() => () => { if (viewUrl) URL.revokeObjectURL(viewUrl); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []);

    if (error) {
        return <div className="pdf-pane pdf-pane-message">Could not open this PDF: {error}</div>;
    }
    if (!source) {
        return <div className="pdf-pane pdf-pane-message">Loading PDF…</div>;
    }

    if (mode === 'edit' && source.original) {
        return (
            <Suspense fallback={<div className="pdf-pane pdf-pane-message">Loading annotation tools…</div>}>
                <PdfAnnotateCanvas
                    key={file.path}
                    filePath={file.path}
                    original={source.original}
                    // Prefer the live buffer (unsaved strokes) over disk, but only
                    // once it holds this file's snapshot — on the first render
                    // after a tab switch `content` may still be '' .
                    snapshot={content || source.diskSnapshot}
                    onContentChange={onContentChange}
                    onFlushNow={onFlushNow}
                    onFlushStart={() => setFlushing(true)}
                    theme={theme}
                />
            </Suspense>
        );
    }

    // Between leaving the canvas and the write landing (a few hundred ms) the
    // file on disk still predates the last strokes. Say so rather than render a
    // PDF that's missing the annotations the user just drew.
    if (isDirty || flushing) {
        return <div className="pdf-pane pdf-pane-message">Applying annotations…</div>;
    }
    if (!viewUrl) {
        return <div className="pdf-pane pdf-pane-message">Loading PDF…</div>;
    }

    return (
        <div className="pdf-pane">
            {/* Keyed on the URL so the viewer reloads when the file is re-read;
                swapping an iframe's src alone doesn't reliably re-render it. */}
            <iframe key={viewUrl} className="pdf-pane-frame" src={viewUrl} title={file.name} />
        </div>
    );
}
