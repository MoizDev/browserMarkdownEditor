import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFileSystem } from '../context/FileSystemContext';
import { readAnnotatedPdf } from '../utils/pdfAnnotation';
import { isAnnotatedPdf } from '../utils/fileTypes';
import PdfViewer from './PdfViewer';
import type { ActiveFile, EditorMode, Theme } from '../types';

// tldraw + pdf.js rasterization are heavy and only needed once someone actually
// annotates, so the canvas is a separate chunk. Viewing a PDF never loads it.
const PdfAnnotateCanvas = lazy(() => import('./PdfAnnotateCanvas'));

interface PdfPaneProps {
    file: ActiveFile;
    /**
     * Whether this pane's tab is the active one. EditorPane keeps one pane
     * MOUNTED per open PDF tab and merely hides the inactive ones, so switching
     * tabs never reloads the document or loses the reading position. Inactive
     * panes hold their viewer; only the annotate canvas is torn down (it's a
     * whole tldraw instance, and unmounting it is also what flushes strokes).
     */
    isActive: boolean;
    /** 'read' = view the real PDF, 'edit' = annotate. Reuses the per-tab mode. */
    mode: EditorMode;
    /** The tab's buffered tldraw snapshot (annotated files only). */
    content: string;
    onContentChange: (path: string, content: string) => void;
    /** Writes to disk immediately; used as the canvas hands over to the viewer. */
    onFlushNow: (path: string, content: string) => void;
    theme: Theme;
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
 * View mode is a pdf.js-rendered scroll of pages (PdfViewer) with a selectable
 * text layer. It replaced the browser's viewer in an <iframe> because that
 * viewer is a closed box: it cannot report the current page, which made both
 * "reopen where I left off" and keeping the position across tab switches
 * impossible.
 *
 * Annotate mode is a tldraw canvas over rasterized pages. The two are separate
 * modes rather than one blended view because a rasterized page has no text to
 * select — the pixels are all that's left. See utils/pdfAnnotation.ts.
 */
export default function PdfPane({ file, isActive, mode, content, onContentChange, onFlushNow, theme, isDirty }: PdfPaneProps) {
    const { readFileBytes } = useFileSystem();
    const [source, setSource] = useState<PdfSource | null>(null);
    const [viewBytes, setViewBytes] = useState<Uint8Array | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Panes for background tabs mount hidden at session restore; don't touch
    // the disk (or pdf.js) until the tab is first brought to the front.
    const [activated, setActivated] = useState(isActive);
    useEffect(() => { if (isActive) setActivated(true); }, [isActive]);

    // True from the moment the canvas starts exporting until that save lands.
    // `isDirty` alone can't cover this: the export takes a moment, and the tab
    // isn't marked dirty until it finishes — a window in which the viewer would
    // happily read and show the pre-annotation file.
    const [flushing, setFlushing] = useState(false);
    // The save landing is what pulls `dirty` back down — this file's own write,
    // not some other tab's (the old global saveEpoch signal reloaded the view,
    // and with it the scroll position, whenever ANY file autosaved).
    useEffect(() => { if (!isDirty) setFlushing(false); }, [isDirty]);

    // Safety net: `flushing` normally clears when this file's save lands, but a
    // save that THROWS leaves `dirty` set — which would leave "Applying
    // annotations…" covering the document for the rest of the session. Failing
    // back to showing the file (stale though it may be) beats hiding it forever.
    useEffect(() => {
        if (!flushing) return;
        const timer = setTimeout(() => {
            console.warn('PDF save did not complete in time; showing the file as it stands on disk.');
            setFlushing(false);
        }, 15000);
        return () => clearTimeout(timer);
    }, [flushing]);

    // Set when a write happened since the view was last read → it's stale and
    // the next chance to re-read should take it (and only then; re-reading on
    // every mode toggle would reload a document that hasn't changed).
    const viewStaleRef = useRef(false);
    useEffect(() => { if (isDirty) viewStaleRef.current = true; }, [isDirty]);

    // Load once per file (once activated). Annotated files also yield the
    // pristine original and any existing snapshot out of their attachments.
    //
    // Deliberately does NOT re-run on saves: `original` feeds the canvas, and
    // replacing it would re-rasterize every page mid-session.
    useEffect(() => {
        if (!activated) return;
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
    }, [activated, file.path, file.handle, file.name, readFileBytes]);

    // Read the bytes the viewer shows: once on first need, and again only after
    // a save of THIS file lands (mid-flush the bytes on disk still predate the
    // strokes, so wait out `flushing`/`isDirty`; their clearing re-runs this).
    useEffect(() => {
        if (!activated || mode !== 'read' || !file.handle || flushing || isDirty) return;
        if (viewBytes && !viewStaleRef.current) return;
        let cancelled = false;

        (async () => {
            try {
                const bytes = await readFileBytes(file.handle as FileSystemFileHandle);
                if (cancelled) return;
                viewStaleRef.current = false;
                setViewBytes(bytes);
            } catch (err) {
                console.error('Could not refresh the PDF view:', err);
            }
        })();

        return () => { cancelled = true; };
    }, [activated, mode, flushing, isDirty, viewBytes, file.handle, readFileBytes]);

    let body: ReactNode = null;
    if (activated) {
        if (error) {
            body = <div className="pdf-pane-message">Could not open this PDF: {error}</div>;
        } else if (!source) {
            body = <div className="pdf-pane-message">Loading PDF…</div>;
        } else if (mode === 'edit' && source.original) {
            // The annotate canvas only exists while its tab is in front: a
            // background tldraw instance would pin megabytes of page bitmaps,
            // and unmounting it is what flushes pending strokes to disk.
            body = isActive ? (
                <Suspense fallback={<div className="pdf-pane-message">Loading annotation tools…</div>}>
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
            ) : null;
        } else if (isDirty || flushing) {
            // Between leaving the canvas and the write landing (a few hundred ms)
            // the file on disk still predates the last strokes. Say so rather than
            // render a PDF that's missing the annotations the user just drew.
            body = <div className="pdf-pane-message">Applying annotations…</div>;
        } else if (!viewBytes) {
            body = <div className="pdf-pane-message">Loading PDF…</div>;
        } else {
            body = <PdfViewer filePath={file.path} data={viewBytes} />;
        }
    }

    // One stable root for every state, so EditorPane can hide an inactive pane
    // with CSS instead of unmounting it (which would forget the document).
    return (
        <div className={`pdf-pane${isActive ? '' : ' pdf-pane-hidden'}`}>
            {body}
        </div>
    );
}
