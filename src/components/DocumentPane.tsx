import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme, obsidianLightHighlightStyle } from '../editor/cmTheme';
import { createLivePreviewPlugin } from '../editor/livePreview';
import type { ImageDeleteRequest, ImageEmbedActions } from '../editor/imageWidget';
import { markdownFormatExtension } from '../editor/formatKeymap';
import { indentSettings, listIndentKeymap } from '../editor/lists';
import { wikiLinkAutocomplete } from '../editor/wikiLinkComplete';
import type { WikiLinkTarget } from '../editor/wikiLinkComplete';
import { mathEditingExtensions } from '../editor/latexSource';
import { revealHighlightField, setRevealHighlight } from '../editor/revealHighlight';
import { useFileSystem } from '../context/FileSystemContext';
import { readRecord, flushRecord } from '../utils/storage';
import { isDrawingFile, isPdfFile } from '../utils/fileTypes';
import { FileText, PenTool, PopOut, X } from './icons';
import type { EditorMode, EditorRevealRequest, OpenNoteByNameHandler, OpenTab, Theme } from '../types';

// tldraw is a heavy dependency (canvas engine + its own UI). Loading it lazily
// keeps it out of the initial bundle, so a markdown-only session never pays for
// it — the chunk is fetched the first time a .tldraw file is opened.
const DrawingPane = lazy(() => import('./DrawingPane'));

/** localStorage key: per-file editor scroll offsets. */
const SCROLL_POSITIONS_KEY = 'fileScrollPositions';

/* ── Scroll persistence, keyed by PATH rather than by pane ─────────────────
   The scroll handler is baked into the document's EditorState (below), and a
   state outlives the pane that built it — so a handler adopted by a later pane
   still writes into the pane that created it. Held per PATH instead, both ends
   agree whichever pane is showing the document: the handler debounces, and the
   unmount flush below finds the timer it actually armed. Sound because a path
   is open at most once, so at most one pane is ever scrolling it.

   `pending` is remembered rather than re-read because by the time an unmount
   runs the scroller is detached and reports 0. */
const scrollDebounce = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pending: number | null }>();

function scrollSlot(path: string) {
    let slot = scrollDebounce.get(path);
    if (!slot) { slot = { timer: null, pending: null }; scrollDebounce.set(path, slot); }
    return slot;
}

/** Write the remembered offset now, cancelling any pending debounce. */
function flushScroll(path: string): void {
    const slot = scrollDebounce.get(path);
    if (!slot) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.pending !== null) {
        // Held parsed in memory — mutate and write, no full re-parse per tick.
        readRecord<number>(SCROLL_POSITIONS_KEY)[path] = slot.pending;
        flushRecord(SCROLL_POSITIONS_KEY);
        slot.pending = null;
    }
    scrollDebounce.delete(path);
}

/** Debounced scroll persistence for one document. */
function rememberScroll(path: string, top: number): void {
    const slot = scrollSlot(path);
    slot.pending = top;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => { slot.timer = null; flushScroll(path); }, 300);
}

/* ── One set of compartments for every pane ───────────────────────────────
   A Compartment is an identity key, not state: each EditorState tracks its own
   replacement for it, so several views can share these freely.

   They MUST be shared, in fact. A pane's state outlives the pane — it is cached
   by path and handed to whichever pane shows that document next (a tab switch,
   or the same document dragged into a split) — and a reconfigure effect naming
   a compartment the state has never heard of is silently dropped. Per-pane
   compartments would therefore give a restored document a theme, mode and tab
   size frozen at whatever the pane that last held it was configured with. */
const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const livePreviewCompartment = new Compartment();
const indentCompartment = new Compartment();

/** The theme + syntax-highlight extension pair for the current app theme. */
function themeExtensions(theme: Theme) {
    return theme === 'light'
        ? [obsidianLightTheme, obsidianLightHighlightStyle]
        : [obsidianDarkTheme, obsidianHighlightStyle];
}

/** A delete request, tagged with the document it was raised against — the
 *  confirmation is the app's (EditorPane's), and with several panes on screen
 *  it has to know which one asked. */
export interface PaneImageDelete extends ImageDeleteRequest {
    path: string;
}

interface DocumentPaneProps {
    tab: OpenTab;
    /** The pane the header actions, ⌘E and ⌘S mean. */
    isFocused: boolean;
    /** True once this tab holds more than one document: each pane then names
     *  itself, because side by side there is nothing else that could. */
    showHeader: boolean;
    theme: Theme;
    /** Spaces a Tab inserts — and how far Tab indents a list item. */
    tabSize: number;
    /**
     * Per-path EditorStates (doc + undo history + selection), owned by
     * EditorPane and shared by every pane, so a document that leaves the screen
     * and comes back is exactly where it was left. Keyed by path alone, which
     * is sound because a path is open at most once and so can be in at most one
     * pane at a time.
     */
    stateCache: Map<string, EditorState>;
    getWikiLinkTargets: () => WikiLinkTarget[];
    /** Path-explicit: several documents are editable at once, and a debounced
     *  canvas save can land after this pane has gone away. */
    onContentChange: (path: string, content: string) => void;
    onFocusPane: (path: string) => void;
    onClosePane: (path: string) => void;
    onSplitOffPane: (path: string) => void;
    onOpenNote: OpenNoteByNameHandler;
    onImageDelete: (request: PaneImageDelete) => void;
    /** One-shot select+scroll order from vault search (null = nothing pending). */
    revealRequest: EditorRevealRequest | null;
    onRevealHandled: () => void;
}

/**
 * ONE open document, drawn in one pane of the tab on screen.
 *
 * Everything document-scoped lives here — the CodeMirror view, its
 * compartments, the paste/scroll/wikilink handlers and the drawing canvas — so
 * that showing N documents side by side is N of these rather than a special
 * case inside the editor. React keys the component by path, which is why there
 * is no tab-swap logic in it at all: a pane shows one document for its whole
 * life, and switching tabs mounts and unmounts panes instead of re-pointing one.
 *
 * The state cache is what makes that free. A pane caches its EditorState on the
 * way out and adopts it on the way in, so undo history and selection survive
 * every tab switch exactly as they did when a single view was re-pointed — and
 * still never reach across documents.
 *
 * A canvas document (a drawing, a PDF) builds no view: it never held text, and
 * the surface that draws it is either the drawing pane below or the PdfPane
 * that EditorPane positions over this slot.
 */
function DocumentPane({
    tab,
    isFocused,
    showHeader,
    theme,
    tabSize,
    stateCache,
    getWikiLinkTargets,
    onContentChange,
    onFocusPane,
    onClosePane,
    onSplitOffPane,
    onOpenNote,
    onImageDelete,
    revealRequest,
    onRevealHandled,
}: DocumentPaneProps) {
    const { getAssetUrl, saveAsset } = useFileSystem();

    const file = tab.file;
    const path = file.path;
    const mode = tab.mode;
    const isDrawing = !file.isHelp && isDrawingFile(file.name);
    const isPdf = !file.isHelp && isPdfFile(file.name);
    const isCanvas = isDrawing || isPdf;

    const viewRef = useRef<EditorView | null>(null);
    const revealClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Live prop mirrors: the view is built once, so everything it calls has to
    // be reachable without rebuilding it.
    //
    // THE CATCH, and it is easy to miss: a ref only stays live while the pane
    // that owns it is mounted, but these are read from handlers baked into the
    // EditorState — which is cached and re-adopted by whichever pane shows the
    // document next, keeping the handlers the FIRST pane built. So a callback
    // reached this way must already be stable for the app's life; making it a
    // ref here does not rescue one that isn't, it only hides the staleness.
    // (`openNoteByName` was not, and wikilink clicks silently stopped working
    // in any note whose pane had been unmounted once — it is now stable in
    // App.tsx, where the fix belongs.) Anything genuinely per-document that the
    // handlers need goes by PATH instead, like scrollDebounce above.
    const onContentChangeRef = useRef(onContentChange);
    const onOpenNoteRef = useRef(onOpenNote);
    const onImageDeleteRef = useRef(onImageDelete);
    const fileRef = useRef(file);
    const getTargetsRef = useRef(getWikiLinkTargets);
    useEffect(() => { onContentChangeRef.current = onContentChange; }, [onContentChange]);
    useEffect(() => { onOpenNoteRef.current = onOpenNote; }, [onOpenNote]);
    useEffect(() => { onImageDeleteRef.current = onImageDelete; }, [onImageDelete]);
    useEffect(() => { fileRef.current = file; }, [file]);
    useEffect(() => { getTargetsRef.current = getWikiLinkTargets; }, [getWikiLinkTargets]);

    // Bound to THIS pane's document, so a picture is resolved against the
    // folder its own note sits in — with several notes on screen there is no
    // "the active file" to fall back on.
    const boundGetAssetUrl = useRef<(fileName: string) => Promise<string | null>>(
        (fileName) => getAssetUrl(fileName, file.parentHandle || null));
    useEffect(() => {
        boundGetAssetUrl.current = (fileName) => getAssetUrl(fileName, fileRef.current.parentHandle || null);
    }, [getAssetUrl]);

    // ONE stable identity for the life of the pane. ImageWidget.eq() compares
    // its resolver by identity, so a fresh closure per call site made every
    // image widget compare unequal after any compartment reconfigure — i.e. on
    // every ⌘E CodeMirror tore down and rebuilt all their DOM, re-resolved every
    // asset, and flashed each image back through its "Loading …" placeholder.
    // Held in state rather than a ref because it is READ during render (it goes
    // into the editor's extensions), which is exactly what a ref is not for.
    const [stableGetAssetUrl] = useState(() => (fileName: string) => boundGetAssetUrl.current(fileName));

    // Deleting an embedded image is the editor's only action that needs the app:
    // it has to be confirmed first, since the picture goes to .Garbage with it.
    // Stable for the same reason the resolver is.
    const [imageActions] = useState<ImageEmbedActions>(() => ({
        confirmDelete: (request) => onImageDeleteRef.current({ ...request, path }),
    }));

    /** The full extension list for this document. Every dynamic bit goes
     *  through a ref, so the view never has to be rebuilt. */
    const createTabState = (doc: string): EditorState => EditorState.create({
        doc: doc || '',
        extensions: [
            EditorView.lineWrapping,
            // Draw a custom cursor element (.cm-cursor) instead of using the
            // native browser caret, so the caret style/animation settings apply.
            drawSelection(),
            history(),
            // Before closeBrackets so LaTeX gets first claim on $ { ( [ —
            // the stock handler doesn't know $ at all, and refuses to pair
            // brackets before non-whitespace, which is every keystroke
            // inside $…$.
            mathEditingExtensions(),
            closeBrackets(),
            // The extra resolver matters: fence infostrings are often file
            // extensions (```py, ```rs) which matchLanguageName ignores —
            // it only knows names and aliases — so fall back to matching
            // them as if they were a filename's extension.
            markdown({
                base: markdownLanguage,
                codeLanguages: (info: string) =>
                    LanguageDescription.matchLanguageName(languages, info, true)
                    ?? LanguageDescription.matchFilename(languages, `x.${info}`),
            }),
            themeCompartment.of(themeExtensions(theme)),
            indentCompartment.of(indentSettings(tabSize)),
            // Above the default keymap, which deliberately leaves Tab to the
            // browser — here it indents (and re-nests list items) instead.
            listIndentKeymap,
            keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                ...closeBracketsKeymap,
                ...searchKeymap,
            ]),
            readOnlyCompartment.of(EditorView.editable.of(mode !== 'read')),
            wikiLinkAutocomplete(() => getTargetsRef.current()),
            livePreviewCompartment.of(createLivePreviewPlugin(stableGetAssetUrl, mode, imageActions)),
            markdownFormatExtension,
            revealHighlightField,
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    onContentChangeRef.current(path, update.state.doc.toString());
                }
            }),
            EditorView.domEventHandlers({
                paste(event, view) {
                    const items = event.clipboardData?.items;
                    if (!items) return false;

                    for (const item of items) {
                        if (item.type.startsWith('image/')) {
                            event.preventDefault();
                            const blob = item.getAsFile();

                            // Generate a filename like Obsidian: Pasted image 20231025143000.png
                            const now = new Date();
                            const timestamp = now.getFullYear().toString() +
                                (now.getMonth() + 1).toString().padStart(2, '0') +
                                now.getDate().toString().padStart(2, '0') +
                                now.getHours().toString().padStart(2, '0') +
                                now.getMinutes().toString().padStart(2, '0') +
                                now.getSeconds().toString().padStart(2, '0');

                            // Make sure we carry over the correct extension (e.g. image/png -> .png)
                            const extMatch = item.type.match(/image\/(jpeg|png|gif|webp|svg\+xml)/);
                            let ext = '.png';
                            if (extMatch) {
                                ext = `.${extMatch[1] === 'svg+xml' ? 'svg' : extMatch[1]}`;
                            }
                            const filename = `Pasted image ${timestamp}${ext}`;

                            // Into the .Assets folder beside THIS pane's note.
                            const parentHandle = fileRef.current.parentHandle || null;
                            saveAsset(filename, blob!, parentHandle).then(() => {
                                // Insert the markdown at cursor
                                const insertText = `![[${filename}]]\n`;
                                const ranges = view.state.selection.ranges;
                                if (ranges.length > 0) {
                                    const pos = ranges[0].from;
                                    view.dispatch({
                                        changes: { from: pos, insert: insertText },
                                        selection: { anchor: pos + insertText.length }
                                    });
                                }
                            }).catch(err => {
                                console.error('Failed to save pasted image:', err);
                                alert('Failed to save image to .Assets folder.');
                            });

                            return true; // We handled the paste
                        }
                    }
                    return false;
                },
                scroll(event, view) {
                    // Keyed by path, not by this pane: see scrollDebounce above.
                    rememberScroll(path, view.scrollDOM.scrollTop);
                },
                mousedown(event) {
                    // Navigate when a rendered [[wikilink]] is clicked.
                    const el = (event.target as HTMLElement).closest?.('.cm-wikilink');
                    if (el && onOpenNoteRef.current) {
                        event.preventDefault();
                        onOpenNoteRef.current(el.getAttribute('data-wikilink') as string);
                        return true;
                    }
                    return false;
                }
            })
        ],
    });

    // Build the view as soon as the container is mounted, from this document's
    // cached state when it has one. A cached state was configured by whichever
    // pane last held it, so everything a SETTING feeds is re-stated here — the
    // same reconfigure the single-view build did on a tab swap.
    const setEditorContainer = (node: HTMLDivElement | null) => {
        if (!node || viewRef.current) return;
        const cached = stateCache.get(path);
        const view = new EditorView({ state: cached ?? createTabState(tab.content), parent: node });
        viewRef.current = view;

        if (cached) {
            view.dispatch({
                effects: [
                    themeCompartment.reconfigure(themeExtensions(theme)),
                    readOnlyCompartment.reconfigure(EditorView.editable.of(mode !== 'read')),
                    livePreviewCompartment.reconfigure(createLivePreviewPlugin(stableGetAssetUrl, mode, imageActions)),
                    indentCompartment.reconfigure(indentSettings(tabSize)),
                    // A leftover search flash from the last time this document
                    // was on screen.
                    setRevealHighlight.of(null),
                ],
            });
        }

        // Restore where this file was left. Scheduled from the callback ref,
        // which runs BEFORE effects — so the reveal effect below, whose own
        // frame is scheduled after this one, still lands last and wins.
        const savedScrollTop = readRecord<number>(SCROLL_POSITIONS_KEY)[path];
        requestAnimationFrame(() => {
            if (viewRef.current === view) view.scrollDOM.scrollTop = savedScrollTop ?? 0;
        });
    };

    // Hand the document's state back to the cache on the way out. Nothing to
    // cache for a canvas document — it never built a view, and a blank doc
    // stored under its path is exactly the wrong thing to restore.
    useEffect(() => () => {
        const view = viewRef.current;
        if (view) {
            stateCache.set(path, view.state);
            view.destroy();
            viewRef.current = null;
        }
        // Scrolling and then switching tabs inside the debounce must not lose
        // where the reader was — write it now rather than drop it. Keyed by
        // path, so this finds the timer the handler actually armed even when
        // that handler belongs to an earlier pane for this document.
        flushScroll(path);
        if (revealClearTimerRef.current) clearTimeout(revealClearTimerRef.current);
    }, [path, stateCache]);

    // Live settings → the open view. (Cached states get the same treatment when
    // they are adopted, above.)
    useEffect(() => {
        viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(theme)) });
    }, [theme]);

    useEffect(() => {
        viewRef.current?.dispatch({ effects: indentCompartment.reconfigure(indentSettings(tabSize)) });
    }, [tabSize]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: [
                readOnlyCompartment.reconfigure(EditorView.editable.of(mode !== 'read')),
                livePreviewCompartment.reconfigure(createLivePreviewPlugin(stableGetAssetUrl, mode, imageActions)),
            ],
        });
    }, [mode, stableGetAssetUrl, imageActions]);

    // Jump to a search match: select it, scroll it to the vertical center, and
    // flash a highlight decoration (visible even in read mode, where the view
    // may refuse focus so the selection alone could be invisible). Dispatched
    // inside requestAnimationFrame so it runs after the scroll-position restore
    // above (rAFs fire in schedule order).
    useEffect(() => {
        if (!revealRequest || revealRequest.path !== path) return;
        const { from, to } = revealRequest;
        onRevealHandled();

        requestAnimationFrame(() => {
            const view = viewRef.current;
            if (!view) return;
            // The doc may be shorter than the searched text was (e.g. it
            // changed on disk since indexing) — clamp rather than throw.
            const docLen = view.state.doc.length;
            const safeFrom = Math.min(from, docLen);
            const safeTo = Math.min(to, docLen);
            view.dispatch({
                selection: { anchor: safeFrom, head: safeTo },
                effects: [
                    EditorView.scrollIntoView(safeFrom, { y: 'center' }),
                    setRevealHighlight.of({ from: safeFrom, to: safeTo }),
                ],
            });
            view.focus();
        });

        // Let the flash fade after a moment. An earlier reveal's pending fade is
        // cancelled so it can't cut this one short.
        if (revealClearTimerRef.current) clearTimeout(revealClearTimerRef.current);
        revealClearTimerRef.current = setTimeout(() => {
            viewRef.current?.dispatch({ effects: setRevealHighlight.of(null) });
        }, 1600);
        // No effect cleanup: it would cancel the pending fade when
        // onRevealHandled() nulls the request and re-runs this effect.
    }, [revealRequest, path, onRevealHandled]);

    // Anything at all inside a pane — a click in its text, its canvas, its
    // header — is what makes it the focused one. mousedown as well as focus,
    // because a canvas pane may never take DOM focus at all.
    const takeFocus = () => { if (!isFocused) onFocusPane(path); };

    return (
        <div
            className={`editor-slot${isFocused ? ' is-focused' : ''}`}
            onMouseDownCapture={takeFocus}
            onFocusCapture={takeFocus}
        >
            {showHeader && (
                <div className="editor-slot-header">
                    <span className="editor-slot-icon" aria-hidden="true">
                        {isDrawing ? <PenTool size={12} /> : <FileText size={12} />}
                    </span>
                    <span className="editor-slot-title" title={path}>{file.name}</span>
                    {tab.dirty && <span className="editor-slot-dot" aria-hidden="true" />}
                    <button
                        className="editor-slot-action"
                        title="Move to its own tab"
                        aria-label={`Move ${file.name} to its own tab`}
                        onClick={() => onSplitOffPane(path)}
                    >
                        <PopOut size={12} />
                    </button>
                    <button
                        className="editor-slot-action"
                        title="Close this pane"
                        aria-label={`Close ${file.name}`}
                        onClick={() => onClosePane(path)}
                    >
                        <X size={12} />
                    </button>
                </div>
            )}
            <div className="editor-slot-body">
                {!isCanvas && (
                    <div
                        className="view-content"
                        ref={setEditorContainer}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={async (e) => {
                            e.preventDefault();
                            const item = e.dataTransfer.items?.[0];
                            if (!item || item.kind !== 'file') return;
                            const dropped = item.getAsFile();
                            if (!dropped || !dropped.name.endsWith('.md')) return;
                            const text = await dropped.text();
                            // Overwrite this pane's document; the update listener
                            // marks its tab dirty and schedules the save.
                            const view = viewRef.current;
                            if (view) {
                                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
                            }
                        }}
                    />
                )}
                {isDrawing && (
                    <Suspense fallback={<div className="drawing-pane drawing-pane-loading">Loading whiteboard…</div>}>
                        {/* Keyed on path: each drawing gets its own tldraw
                            instance, loaded from its own snapshot. */}
                        <DrawingPane
                            key={path}
                            filePath={path}
                            content={tab.content}
                            onContentChange={onContentChange}
                            theme={theme}
                        />
                    </Suspense>
                )}
                {/* A PDF's surface is the PdfPane EditorPane keeps mounted for
                    every open PDF tab and positions over this slot — it must
                    outlive the pane so a tab switch never reloads the document. */}
            </div>
        </div>
    );
}

// Memoized: EditorPane re-renders on every keystroke, and with up to five panes
// on screen only the one being typed in has anything new to say. App replaces
// exactly the edited tab's object, so the others' props compare equal.
export default React.memo(DocumentPane);
