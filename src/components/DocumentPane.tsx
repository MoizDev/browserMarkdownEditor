import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import type { ChangeDesc } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { obsidianDarkTheme, obsidianHighlightStyle, obsidianLightTheme, obsidianLightHighlightStyle } from '../editor/cmTheme';
import { createLivePreviewPlugin } from '../editor/livePreview';
import type { ImageDeleteRequest, ImageEmbedActions } from '../editor/imageWidget';
import { markdownFormatExtension } from '../editor/formatKeymap';
import { indentSettings, listIndentKeymap } from '../editor/lists';
import { wikiLinkAutocomplete } from '../editor/wikiLinkComplete';
import type { WikiLinkTarget } from '../editor/wikiLinkComplete';
import { mathEditingExtensions } from '../editor/latexSource';
import { foldedHeadingKeys, headingFold, headingFoldField, isHeadingKeyList, sameHeadingKeys } from '../editor/headingFold';
import type { HeadingKey } from '../editor/headingFold';
import { revealHighlightField, setRevealHighlight } from '../editor/revealHighlight';
import {
    captureScrollAnchor,
    holdScrollAnchor,
    isHoldingScrollAnchor,
    isScrollAnchor,
    mapScrollAnchor,
    parseForReveal,
    revealMatch,
    revealMatchEffect,
    scrollAnchorTracking,
} from '../editor/scrollAnchor';
import type { ScrollAnchor } from '../editor/scrollAnchor';
import { insertTableAtCursor } from '../editor/tableEdit';
import { canWrite, modeExtensions } from '../editor/readingMode';
import { noteSearchKeymap, rebuildSearchPanelForMode, returnKeyboard, runNoteSearchKey } from '../editor/noteSearch';
import { onTableInsertRequest, TABLE_GRID_COLS, TABLE_GRID_ROWS } from '../utils/tableInsertRequest';
import { useFileSystem } from '../context/FileSystemContext';
import { readRecord, flushRecord, scopedKey } from '../utils/storage';
import { openContextMenu } from '../utils/contextMenu';
import type { ContextMenuEntry } from '../utils/contextMenu';
import { copyText, readClipboardText, CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';
import { isDrawingFile, isNotebookFile, isPdfFile } from '../utils/fileTypes';
import { AlertCircle, FileText, Notebook, PenTool, PopOut, X } from './icons';
import type { EditorMode, EditorRevealRequest, OpenNoteByNameHandler, OpenTab, Theme } from '../types';

// tldraw is a heavy dependency (canvas engine + its own UI). Loading it lazily
// keeps it out of the initial bundle, so a markdown-only session never pays for
// it — the chunk is fetched the first time a .tldraw file is opened.
const DrawingPane = lazy(() => import('./DrawingPane'));
// Lazy for the same reason DrawingPane is: opening a note must not load tldraw.
const NotebookPane = lazy(() => import('./NotebookPane'));

/** localStorage key: per-file editor scroll places (editor/scrollAnchor.ts). */
const SCROLL_ANCHORS_KEY = 'fileScrollAnchors';
/** The raw-scrollTop record the anchors replaced; see scrollAnchorRecord. */
const LEGACY_SCROLL_POSITIONS_KEY = 'fileScrollPositions';

/* ── Scroll persistence, keyed by PATH rather than by pane ─────────────────
   The scroll handler is baked into the document's EditorState (below), and a
   state outlives the pane that built it — so a handler adopted by a later pane
   still writes into the pane that created it. Held per PATH instead, both ends
   agree whichever pane is showing the document: the handler debounces, and the
   unmount flush below finds the timer it actually armed. Sound because a path
   is open at most once, so at most one pane is ever scrolling it.

   `pending` is remembered rather than re-read because by the time an unmount
   runs the scroller is detached and reports 0.

   What is remembered is a place in the TEXT — the line block at the top edge
   and how far into it (editor/scrollAnchor.ts) — because a pixel offset
   measured while reading means something else to the fresh view a return
   builds. A returning view HOLDS that place until the reader takes over, and
   nothing is remembered while it holds: its scroll events are the restore
   landing, and saving those is how every return used to creep further down.

   The in-memory map stays keyed by the BARE path — it lives for one session,
   inside one vault. Only the stored record is `scopedKey`'d, because it
   outlives the switch and `Notes/index.md` names a different file in every
   vault (see utils/storage.ts). */
const scrollDebounce = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pending: ScrollAnchor | null }>();

function scrollSlot(path: string) {
    let slot = scrollDebounce.get(path);
    if (!slot) { slot = { timer: null, pending: null }; scrollDebounce.set(path, slot); }
    return slot;
}

let legacyScrollPositionsDropped = false;

/** The stored anchors record. The raw-scrollTop record they replaced is
 *  deleted on first use rather than read: its pixels are exactly the wrong
 *  answer on a long note, and nothing prunes it — so every note opens at its
 *  top once and remembers correctly from then on. One-way, like tabSessions'
 *  migration off its flat keys. */
function scrollAnchorRecord(): Record<string, unknown> {
    if (!legacyScrollPositionsDropped) {
        legacyScrollPositionsDropped = true;
        try {
            localStorage.removeItem(LEGACY_SCROLL_POSITIONS_KEY);
        } catch {
            // Storage blocked outright: nothing reads the old key anyway.
        }
    }
    return readRecord<unknown>(SCROLL_ANCHORS_KEY);
}

/** Write the remembered place now, cancelling any pending debounce. */
function flushScroll(path: string): void {
    const slot = scrollDebounce.get(path);
    if (!slot) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.pending !== null) {
        const { pos, offset } = slot.pending;
        // Held parsed in memory — mutate and write, no full re-parse per tick.
        // A tenth of a pixel is already finer than the hold's 1px tolerance.
        scrollAnchorRecord()[scopedKey(path)] = { pos, offset: Math.round(offset * 10) / 10 };
        flushRecord(SCROLL_ANCHORS_KEY);
        slot.pending = null;
    }
    scrollDebounce.delete(path);
}

/** (Re)start the debounce that writes `path`'s remembered place. */
function armScrollFlush(path: string): void {
    const slot = scrollSlot(path);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => { slot.timer = null; flushScroll(path); }, 300);
}

/** Debounced scroll persistence for one document. The place is captured in
 *  CodeMirror's next measure (the one it runs right after scroll handlers),
 *  not read here: see captureScrollAnchor. */
function rememberScroll(path: string, view: EditorView): void {
    if (isHoldingScrollAnchor(view)) return;
    captureScrollAnchor(view, `scroll-anchor:${path}`, (anchor) => {
        scrollSlot(path).pending = anchor;
        armScrollFlush(path);
    });
}

/** Where `path` was left. The debounced capture comes first: a pane mounting
 *  in the same commit another unmounts reads this before that pane's cleanup
 *  has flushed it. Then the stored entry, shape-guarded — localStorage is
 *  user-editable, and a malformed entry just opens the note at its top. */
function rememberedScroll(path: string): ScrollAnchor | null {
    const pending = scrollDebounce.get(path)?.pending;
    if (pending) return pending;
    const stored = scrollAnchorRecord()[scopedKey(path)];
    return isScrollAnchor(stored) ? stored : null;
}

/** Carry the remembered place through an edit made in the app, so text added
 *  or removed above it does not change which line comes back. Runs on every
 *  keystroke, so it re-arms the write only when the place actually moved. */
function mapRememberedScroll(path: string, changes: ChangeDesc): void {
    const current = rememberedScroll(path);
    if (!current) return;
    const mapped = mapScrollAnchor(current, changes);
    if (mapped === current) return;
    scrollSlot(path).pending = mapped;
    armScrollFlush(path);
}

/** localStorage key: per-file collapsed heading sections (editor/headingFold.ts). */
const COLLAPSED_HEADINGS_KEY = 'collapsedHeadings';

/* ── Collapsed-section persistence, keyed by PATH for the scroll reason ────
   The listener that notices a fold is baked into the EditorState exactly as
   the scroll handler is, so its debounce is held per path for the reason given
   above. The STATE is remembered rather than its keys: turning positions into
   keys walks the note's lines, which belongs in the debounced flush and not in
   every keystroke that moves a collapsed heading down the page. An entry is
   deleted once nothing is collapsed, so the record only grows by the notes that
   actually have a collapsed section. */
const foldDebounce = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pending: EditorState | null }>();

/** Write the document's collapsed headings now, cancelling any pending debounce. */
function flushFolds(path: string): void {
    const slot = foldDebounce.get(path);
    if (!slot) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.pending) {
        const record = readRecord<HeadingKey[]>(COLLAPSED_HEADINGS_KEY);
        const key = scopedKey(path);
        const keys = foldedHeadingKeys(slot.pending);
        // Typing above a collapsed heading moves it without changing its key:
        // that is a debounce tick, not a write of the whole record.
        if (!sameHeadingKeys(record[key], keys)) {
            if (keys.length > 0) record[key] = keys;
            else delete record[key];
            flushRecord(COLLAPSED_HEADINGS_KEY);
        }
        slot.pending = null;
    }
    foldDebounce.delete(path);
}

/** Debounced fold persistence for one document. */
function rememberFolds(path: string, state: EditorState): void {
    let slot = foldDebounce.get(path);
    if (!slot) { slot = { timer: null, pending: null }; foldDebounce.set(path, slot); }
    const armed = slot;
    armed.pending = state;
    if (armed.timer) clearTimeout(armed.timer);
    armed.timer = setTimeout(() => { armed.timer = null; flushFolds(path); }, 400);
}

/** The collapsed headings stored for `path` — shape-guarded, since localStorage
 *  is user-editable. */
function storedFoldKeys(path: string): readonly HeadingKey[] {
    const keys = readRecord<unknown>(COLLAPSED_HEADINGS_KEY)[scopedKey(path)];
    return isHeadingKeyList(keys) ? keys : [];
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

/**
 * Whether a keydown that reached `window` is meant for this note — the guard
 * in front of the search keys (editor/noteSearch.ts), which have to be caught
 * outside the editor because a note being read never holds focus.
 *
 * - Already `defaultPrevented`: CodeMirror (Edit mode, focus in the text), the
 *   open search panel or a dialog took it — acting again would jump twice.
 * - A modal is open: the note is not what the reader is looking at.
 * - Inside the view: its text, a table cell (CodeMirror ignores keys raised in
 *   a widget, so Edit mode's ⌘F in a cell used to reach the browser too).
 * - A text field, menu, dialog or listbox owns its keyboard — the sidebar's
 *   search box and a rename field keep the browser's find.
 * - Anything else has no find of its own, so the note in front gets it:
 *   `<body>` (where a click in Reading-mode text, a tree row or a tab leaves
 *   the keyboard — none is focusable), and any button, in the pane's chrome or
 *   the sidebar's. The sidebar counts: Help Guide keeps the keyboard after
 *   opening the guide, whose own text says to press ⌘F (measured: the
 *   browser's find opened instead while this stopped at `.editor-pane`).
 */
function keyIsForNote(event: KeyboardEvent, view: EditorView): boolean {
    // Every search key is ⌘/Ctrl-something or F3 — a superset test, so a typed
    // letter in Edit mode never pays for the document query below.
    if (!event.metaKey && !event.ctrlKey && event.key !== 'F3') return false;
    if (event.defaultPrevented || event.isComposing) return false;
    if (document.querySelector('[aria-modal="true"]')) return false;
    const target = event.target;
    if (!(target instanceof Element)) return false;
    if (view.dom.contains(target)) return true;
    if (target instanceof HTMLElement && target.isContentEditable) return false;
    return !target.closest('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"]');
}

/* ── The editor's own right-click menu ────────────────────────────────────
   Rows that write test `canWrite` (editor/readingMode.ts), never either facet
   alone: neither half of Reading mode blocks a programmatic `view.dispatch`,
   so an unguarded Insert table… would really insert a table into a note
   nobody was editing, with no visible cause. */
const READ_MODE_REASON = 'Switch to editing with ⌘E';
const NO_SELECTION_REASON = 'Nothing is selected';


/**
 * The rows of the menu a right-click in note text raises.
 *
 * Built fresh per click, so every disabled state is a snapshot of the moment
 * the user asked. Disabled rows are PRESENT and carry their reason rather than
 * being left out — a menu that quietly grows and shrinks makes the reader hunt
 * for a row that is simply not applicable right now (the rule
 * VaultMenu.messageFor states for the vault list).
 *
 * Every command re-reads the selection from the view when it RUNS rather than
 * closing over the one measured here: the clipboard calls are async, and a
 * position captured before an await is a position that may no longer describe
 * anything.
 */
function editorMenuEntries(view: EditorView, notify: (message: string) => void): ContextMenuEntry[] {
    const editable = canWrite(view.state);
    const empty = view.state.selection.main.empty;

    return [
        {
            kind: 'command',
            id: 'cut',
            label: 'Cut',
            disabled: !editable || empty,
            reason: !editable ? READ_MODE_REASON : empty ? NO_SELECTION_REASON : undefined,
            run: async () => {
                const range = view.state.selection.main;
                if (range.empty) return;
                // The text goes ONLY after the clipboard write resolves: a
                // refused clipboard that had already deleted the selection
                // would have destroyed it and put it nowhere.
                if (!await copyText(view.state.sliceDoc(range.from, range.to))) {
                    notify(CLIPBOARD_WRITE_BLOCKED);
                    return;
                }
                const now = view.state.selection.main;
                if (now.empty || !canWrite(view.state)) return;
                view.dispatch({ changes: { from: now.from, to: now.to, insert: '' }, selection: { anchor: now.from } });
                view.focus();
            },
        },
        {
            kind: 'command',
            id: 'copy',
            label: 'Copy',
            // Copy is the one row that survives Reading mode — reading is
            // exactly when quoting a passage is most likely.
            disabled: empty,
            reason: empty ? NO_SELECTION_REASON : undefined,
            run: async () => {
                const range = view.state.selection.main;
                if (range.empty) return;
                if (!await copyText(view.state.sliceDoc(range.from, range.to))) {
                    notify(CLIPBOARD_WRITE_BLOCKED);
                }
            },
        },
        {
            kind: 'command',
            id: 'paste',
            label: 'Paste',
            disabled: !editable,
            reason: !editable ? READ_MODE_REASON : undefined,
            run: async () => {
                // Chromium permission-gates a clipboard READ that is not
                // driven by a live gesture, and by the time a menu row is
                // clicked the right-click is spent — so a refusal here is
                // ordinary, and saying so (naming the keystroke that always
                // works) is the whole handling.
                const read = await readClipboardText();
                if (!read.ok) { notify(CLIPBOARD_READ_BLOCKED); return; }
                if (!canWrite(view.state)) return;
                const range = view.state.selection.main;
                view.dispatch({
                    changes: { from: range.from, to: range.to, insert: read.text },
                    selection: { anchor: range.from + read.text.length },
                    scrollIntoView: true,
                });
                view.focus();
            },
        },
        {
            kind: 'command',
            id: 'select-all',
            label: 'Select all',
            run: () => {
                view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
                view.focus();
            },
        },
        { kind: 'separator', id: 'sep-insert' },
        {
            kind: 'grid',
            id: 'insert-table',
            label: 'Insert table…',
            maxRows: TABLE_GRID_ROWS,
            maxCols: TABLE_GRID_COLS,
            disabled: !editable,
            reason: !editable ? READ_MODE_REASON : undefined,
            pick: (rows, cols) => { insertTableAtCursor(view, rows, cols); },
        },
    ];
}

/** A delete request, tagged with the document it was raised against — the
 *  confirmation is the app's (EditorPane's), and with several panes on screen
 *  it has to know which one asked. */
export interface PaneImageDelete extends ImageDeleteRequest {
    path: string;
}

interface DocumentPaneProps {
    tab: OpenTab;
    /** What this pane's EditorState is cached under — the same string React
     *  keys the pane by, so a pane and its state are one thing. It is NOT the
     *  path: see EditorPane's paneKey. */
    stateKey: string;
    /** The pane the header actions, ⌘E, ⌘F and ⌘S mean. */
    isFocused: boolean;
    /** True once this tab holds more than one document: each pane then names
     *  itself, because side by side there is nothing else that could. */
    showHeader: boolean;
    /**
     * This pane's share of the tab's width — a `flex-grow` naming the CSS
     * variable EditorPane keeps for this column, so a pane needs to know
     * nothing at all about how its tab divides the width. `undefined` on a tab
     * with a single pane, which then keeps the stylesheet's own `flex: 1 1 0`
     * and is laid out exactly as it always was.
     *
     * EditorPane hands out ONE FROZEN OBJECT per column, so this prop's
     * identity never moves: a pane's props do not change at all while a divider
     * is being dragged, which is what lets the drag repaint the whole split
     * without re-rendering a single document.
     */
    widthStyle: React.CSSProperties | undefined;
    theme: Theme;
    /** Spaces a Tab inserts — and how far Tab indents a list item. */
    tabSize: number;
    /**
     * Per-document EditorStates (doc + undo history + selection), owned by
     * EditorPane and shared by every pane, so a document that leaves the screen
     * and comes back is exactly where it was left. Keyed by `tab.id` — the
     * document, not its path, which a rename can hand to a different document
     * (see OpenTab.id).
     */
    stateCache: Map<string, EditorState>;
    getWikiLinkTargets: () => WikiLinkTarget[];
    /** Path-explicit: several documents are editable at once, and a debounced
     *  canvas save can land after this pane has gone away. */
    onContentChange: (path: string, content: string) => void;
    /** Read this document's file again when the restore could not
     *  (OpenTab.readError); resolves true once it holds the text. Stable. */
    onRetryRead: (path: string) => Promise<boolean>;
    onFocusPane: (path: string) => void;
    onClosePane: (path: string) => void;
    onSplitOffPane: (path: string) => void;
    onOpenNote: OpenNoteByNameHandler;
    onImageDelete: (request: PaneImageDelete) => void;
    /** Say something to the reader — the app's own dialog, from App's `tell`.
     *  A refused clipboard and a refused `.md` drop use it, and it is the
     *  difference between a gesture that explains itself and a dead one.
     *  Must be STABLE: this component is memoized so the tree of panes does
     *  not re-render on every keystroke. */
    onNotify: (message: string) => void;
    onConfirm: (question: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;
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
    stateKey,
    isFocused,
    showHeader,
    widthStyle,
    theme,
    tabSize,
    stateCache,
    getWikiLinkTargets,
    onContentChange,
    onRetryRead,
    onFocusPane,
    onClosePane,
    onSplitOffPane,
    onOpenNote,
    onImageDelete,
    onNotify,
    onConfirm,
    revealRequest,
    onRevealHandled,
}: DocumentPaneProps) {
    const { getAssetUrl, saveAsset } = useFileSystem();

    const file = tab.file;
    const path = file.path;
    const mode = tab.mode;
    const isDrawing = !file.isHelp && isDrawingFile(file.name);
    const isNotebook = !file.isHelp && isNotebookFile(file.name);
    const isPdf = !file.isHelp && isPdfFile(file.name);
    const isCanvas = isDrawing || isNotebook || isPdf;
    /** Restored without its text (OpenTab.readError): this pane shows only
     *  that, and builds no view, drawing or notebook — each would take the
     *  empty buffer for the document and save it over the file. */
    const unreadable = !!tab.readError;
    const [retrying, setRetrying] = useState(false);
    // A success remounts this pane (EditorPane keys it on readError), so only a
    // failed attempt comes back to a mounted component to clear the flag.
    const retryRead = async () => {
        setRetrying(true);
        if (!await onRetryRead(path)) setRetrying(false);
    };

    const viewRef = useRef<EditorView | null>(null);
    /** True only while setEditorContainer builds the view — see there. */
    const buildingViewRef = useRef(false);

    // The top bar's table button cannot reach this view (EditorPane holds none),
    // so it raises a request, and only the pane FOCUSED on that document acts on
    // it: two panes showing the same note must not both insert. A ref, because
    // the subscription is made once per document and focus moves under it.
    const isFocusedRef = useRef(isFocused);
    useEffect(() => { isFocusedRef.current = isFocused; }, [isFocused]);
    useEffect(() => onTableInsertRequest((request) => {
        const view = viewRef.current;
        if (!view || !isFocusedRef.current || request.path !== tab.file.path) return;
        insertTableAtCursor(view, request.rows, request.cols);
    }), [tab.file.path]);

    // ⌘F, ⌘G and F3 for this note, from outside the editor: a note being read
    // never holds focus, so CodeMirror's own searchKeymap cannot see them
    // (editor/noteSearch.ts). Only the FOCUSED pane acts, for the table-insert
    // reason — two panes must not both open. Bubble phase, so the content and
    // the panel have had their turn and `keyIsForNote` sees what they took. A
    // canvas pane builds no view and never listens, so a PDF keeps the
    // browser's find, which its text layer makes real. Registered by the pane,
    // not baked into the EditorState, so the outlives-the-pane rule does not
    // apply.
    useEffect(() => {
        if (isCanvas) return;
        const onKeyDown = (event: KeyboardEvent) => {
            const view = viewRef.current;
            if (!view || !isFocusedRef.current || !keyIsForNote(event, view)) return;
            runNoteSearchKey(view, event);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isCanvas]);

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
            // ⌘F's jump is a revealMatch, as the vault-search reveal is: centred
            // and held while pictures and diagrams above it load (the default,
            // a one-shot nearest-edge scroll, left a match 1,445px below view).
            search({ scrollToMatch: revealMatchEffect }),
            // The search keys again, for a note that cannot take focus — run
            // by the window listener below, never by CodeMirror itself.
            noteSearchKeymap,
            readOnlyCompartment.of(modeExtensions(mode)),
            wikiLinkAutocomplete(() => getTargetsRef.current()),
            livePreviewCompartment.of(createLivePreviewPlugin(stableGetAssetUrl, mode, imageActions)),
            // Deliberately OUTSIDE livePreviewCompartment: ⌘E reconfigures
            // that, which would forget every collapsed section (headingFold.ts).
            headingFold(storedFoldKeys(path)),
            // Outside every compartment for the same reason: a reconfigure
            // (⌘E, the theme) must not drop a restored place still being held.
            scrollAnchorTracking,
            markdownFormatExtension,
            revealHighlightField,
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    onContentChangeRef.current(path, update.state.doc.toString());
                    // Keyed by path, like everything else baked in here.
                    mapRememberedScroll(path, update.changes);
                }
                // Keyed by path, like scroll. `folded` changes identity only
                // when a section folds, unfolds or moves; an edit at or above
                // the last collapsed heading may also rename one in place.
                const before = update.startState.field(headingFoldField, false);
                const after = update.state.field(headingFoldField, false);
                if (before && after && (before.folded !== after.folded || (
                    update.docChanged && before.folded.length > 0
                    && update.changes.touchesRange(0, update.startState.doc.lineAt(before.folded[before.folded.length - 1]).to) !== false
                ))) {
                    rememberFolds(path, update.state);
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
                    // Also called by CodeMirror's IntersectionObserver at mount,
                    // at scrollTop 0 — harmless only because a holding view
                    // remembers nothing.
                    rememberScroll(path, view);
                },
                drop(event) {
                    // A dropped .md replaces the whole note, and the pane's
                    // onDrop does that — or refuses it, in Reading mode.
                    // Claimed here, in both modes, so CodeMirror's own drop
                    // handler never runs for it: in Edit mode it would first
                    // insert the file's text at the drop point, making the
                    // replace a second transaction that collapsed headings
                    // could not be carried through (measured: both folds
                    // lost). Every OTHER drop — text, a non-.md file — reaches
                    // that handler, which refuses it in Reading mode on
                    // readOnly. The event still bubbles to onDrop, which reads
                    // the file.
                    const item = event.dataTransfer?.items?.[0];
                    return item?.kind === 'file' && !!item.getAsFile()?.name.endsWith('.md');
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
        const cached = stateCache.get(stateKey);
        // A cached state whose search panel was left open focuses that panel's
        // Find field as the view is built (SearchPanel.mount). That is not the
        // reader choosing this pane, so the slot's focus handler must not take
        // it as such — measured: in a split, returning to the tab made the pane
        // with the open panel the focused one, and ⌘E/⌘S then acted on the other
        // note — and the keyboard goes back to where it was.
        const keyboardBefore = document.activeElement;
        buildingViewRef.current = true;
        try {
            const view = new EditorView({ state: cached ?? createTabState(tab.content), parent: node });
            viewRef.current = view;
            returnKeyboard(view, keyboardBefore);

            if (cached) {
                const wasReadOnly = view.state.readOnly;
                view.dispatch({
                    effects: [
                        themeCompartment.reconfigure(themeExtensions(theme)),
                        readOnlyCompartment.reconfigure(modeExtensions(mode)),
                        livePreviewCompartment.reconfigure(createLivePreviewPlugin(stableGetAssetUrl, mode, imageActions)),
                        indentCompartment.reconfigure(indentSettings(tabSize)),
                        // A leftover search flash from the last time this document
                        // was on screen.
                        setRevealHighlight.of(null),
                    ],
                });
                // Nothing for collapsed headings: their field is in no compartment,
                // and reads the mode from the editable facet re-stated above.
                //
                // An open search panel follows the mode re-stated above, for the
                // same both-places reason (tabs-and-panes). Nothing changes a tab's
                // mode while no pane shows it today — the graph view, which could,
                // unmounts EditorPane and this cache with it — so this guards the
                // day something does, rather than a path in use.
                rebuildSearchPanelForMode(view, wasReadOnly);
            }

            // Put back where this document was left, and keep it there while the
            // background parse draws what lies around it. After the reconfigure
            // above, so the landing is laid out with this mode's decorations;
            // synchronous, so no frame is painted at the note's top first. The
            // reveal effect below runs later, in its own frame, and its revealMatch
            // replaces this hold with its own, so it still wins.
            const anchor = rememberedScroll(path);
            if (anchor) holdScrollAnchor(view, anchor);
        } finally {
            buildingViewRef.current = false;
        }
    };

    // Hand the document's state back to the cache on the way out. Nothing to
    // cache for a canvas document — it never built a view, and a blank doc
    // stored under its path is exactly the wrong thing to restore.
    useEffect(() => () => {
        const view = viewRef.current;
        if (view) {
            stateCache.set(stateKey, view.state);
            view.destroy();
            viewRef.current = null;
        }
        // Scrolling and then switching tabs inside the debounce must not lose
        // where the reader was — write it now rather than drop it. Keyed by
        // path, so this finds the timer the handler actually armed even when
        // that handler belongs to an earlier pane for this document. The same
        // holds for a section collapsed just before the switch.
        flushScroll(path);
        flushFolds(path);
        if (revealClearTimerRef.current) clearTimeout(revealClearTimerRef.current);
    }, [path, stateKey, stateCache]);

    /* ── Live settings → the open view ────────────────────────────────────
       The three effects below carry a CHANGE of setting into a view that is
       already running. They must not also run at mount, which is what `settled`
       is for: the callback ref above has just configured this view for exactly
       these values — either by baking them into a fresh state or by
       reconfiguring an adopted one — and re-stating them is not free.

       livePreviewCompartment is the expensive one. Each createLivePreviewPlugin
       mints a NEW StateField, so reconfiguring it discards the field's value and
       runs create() — a full buildDecorations pass over the document (tens of
       thousands of ranges on a large note; see AGENTS.md). Ungated, every pane
       mount paid for two of those instead of one, and a pane now mounts on every
       tab switch: a five-pane split cost ten walks where five would do. */
    const settled = useRef(false);

    useEffect(() => {
        if (!settled.current) return;
        viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(theme)) });
    }, [theme]);

    useEffect(() => {
        if (!settled.current) return;
        viewRef.current?.dispatch({ effects: indentCompartment.reconfigure(indentSettings(tabSize)) });
    }, [tabSize]);

    useEffect(() => {
        if (!settled.current) return;
        const view = viewRef.current;
        if (!view) return;
        const wasReadOnly = view.state.readOnly;
        view.dispatch({
            effects: [
                readOnlyCompartment.reconfigure(modeExtensions(mode)),
                livePreviewCompartment.reconfigure(createLivePreviewPlugin(stableGetAssetUrl, mode, imageActions)),
            ],
        });
        // An open search panel gains or loses its Replace row with the mode.
        rebuildSearchPanelForMode(view, wasReadOnly);
    }, [mode, stableGetAssetUrl, imageActions]);

    // Declared LAST on purpose — effects run in declaration order, so the three
    // above see `false` on the mount pass and `true` on every pass after it. The
    // cleanup makes StrictMode's simulated remount behave like a real one: it
    // re-runs the ref callback too, so that build configures the view just the
    // same and the three should skip again.
    useEffect(() => {
        settled.current = true;
        return () => { settled.current = false; };
    }, []);

    // Jump to a search match: select it, centre it and hold it there while
    // what surrounds it is still being drawn (revealMatch, editor/scrollAnchor.ts),
    // and flash a highlight decoration (visible even in read mode, where the
    // view may refuse focus so the selection alone could be invisible).
    // Dispatched inside requestAnimationFrame, after the view is laid out; the
    // revealMatch replaces any restored place the callback ref is holding.
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
            // A note this jump just opened is parsed only to ~3,000 characters;
            // without this its headings, code panels and collapsed sections
            // around the match were redrawn after the scroll (a 34KB note landed
            // 61px off centre, 256px with a section collapsed above the match).
            parseForReveal(view, safeTo);
            view.dispatch({
                selection: { anchor: safeFrom, head: safeTo },
                effects: [
                    revealMatch.of({ from: safeFrom, to: safeTo }),
                    setRevealHighlight.of({ from: safeFrom, to: safeTo }),
                ],
            });
            view.focus();

            // Let the flash fade after a moment — timed from the dispatch, so the
            // parse above does not eat into it. An earlier reveal's pending fade
            // is cancelled so it can't cut this one short.
            if (revealClearTimerRef.current) clearTimeout(revealClearTimerRef.current);
            revealClearTimerRef.current = setTimeout(() => {
                viewRef.current?.dispatch({ effects: setRevealHighlight.of(null) });
            }, 1600);
        });
        // No effect cleanup: it would cancel the pending fade when
        // onRevealHandled() nulls the request and re-runs this effect.
    }, [revealRequest, path, onRevealHandled]);

    // Anything at all inside a pane — a click in its text, its canvas, its
    // header — is what makes it the focused one. mousedown as well as focus,
    // because a canvas pane may never take DOM focus at all.
    const takeFocus = () => { if (!isFocused) onFocusPane(path); };
    // …except a focus the view moved while it was being built (see
    // setEditorContainer): that one arrives synchronously, mid-construction.
    const takeFocusFromEvent = () => { if (!buildingViewRef.current) takeFocus(); };

    return (
        <div
            className={`editor-slot${isFocused ? ' is-focused' : ''}`}
            style={widthStyle}
            onMouseDownCapture={takeFocus}
            onFocusCapture={takeFocusFromEvent}
        >
            {showHeader && (
                <div
                    className="editor-slot-header"
                    // A file dropped from the desktop on an UNCANCELLED target
                    // navigates the whole app away to that file, taking every
                    // unsaved buffer with it. Every other surface a drop can
                    // land on cancels its own (`.view-content` below, the
                    // divider in EditorPane); this strip is one too, and it is
                    // the natural place to aim at if you mean "into that pane".
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => e.preventDefault()}
                >
                    <span className="editor-slot-icon" aria-hidden="true">
                        {unreadable ? <AlertCircle size={12} /> : isNotebook ? <Notebook size={12} /> : isDrawing ? <PenTool size={12} /> : <FileText size={12} />}
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
                {unreadable && (
                    <div
                        className="pdf-pane-message unread-pane"
                        // status, not alert: this pane remounts on every tab
                        // switch, and an alert would be read out each time.
                        role="status"
                        // Nothing else in this slot cancels a desktop drop,
                        // and an uncancelled one navigates the app away (see
                        // the header's note).
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => e.preventDefault()}
                    >
                        <span className="unread-pane-title" title={file.name}>
                            Couldn’t read <strong>{file.name}</strong>
                        </span>
                        <span className="unread-pane-hint">
                            Another program may be using it, it may not be downloaded yet, or it
                            can’t be opened right now. Nothing was changed, and its tab is kept.
                        </span>
                        <span className="unread-pane-detail" title={tab.readError}>{tab.readError}</span>
                        <button className="pdf-pane-action" disabled={retrying} onClick={retryRead}>
                            {retrying ? 'Trying…' : 'Try again'}
                        </button>
                    </div>
                )}
                {!isCanvas && !unreadable && (
                    <div
                        className="view-content"
                        ref={setEditorContainer}
                        /* The app's own menu, in place of the browser's.
                           WHERE this handler lives is the whole safety
                           argument, and it is the reason it is not a document
                           listener with an exclusion list: this element is
                           rendered `{!isCanvas && …}`, DrawingPane and
                           NotebookPane are its siblings, EditorPane mounts every PdfPane outside the
                           slot entirely, and GraphView replaces EditorPane. So
                           tldraw's own menu, a PDF's and the graph's are
                           excluded BY CONSTRUCTION — there is no closest()
                           list here to drift out of step as surfaces are
                           added. (Suppressing tldraw's menu would be a
                           regression, not a feature.)

                           An ordinary React prop, recreated per render, rather
                           than EditorView.domEventHandlers: those are baked
                           into the EditorState, which outlives the pane that
                           built it — and CodeMirror's own event dispatch
                           refuses events raised inside a widget, which is the
                           one place a menu is most wanted. */
                        onContextMenu={(e) => {
                            const view = viewRef.current;
                            if (!view) return;
                            // A right-click inside a table widget raises the
                            // TABLE menu and stops there (tableEdit's handler
                            // is a native listener that stops propagation, so
                            // it never reaches React's root), which means
                            // anything arriving here is note text.
                            e.preventDefault();
                            // Right-clicking OUTSIDE the selection moves the
                            // caret there first, the way every editor does, so
                            // "Insert table…" lands where the user aimed.
                            // Inside a selection, leave it alone so Copy means
                            // what it looks like.
                            //
                            // The LOOSE overload, and that is load-bearing. The
                            // precise one returns null whenever the block under
                            // the pointer falls outside the rendered viewport
                            // (@codemirror/view 6.39.15 :3766-3768), and
                            // `viewport.to <= block.from` is true for exactly
                            // one on-screen target: the document's LAST line
                            // when it is empty, whose from === to === doc.length
                            // === viewport.to. That is every note that ends in a
                            // newline, and it is the line the reader aims at to
                            // put a table at the end of a note. Measured: the
                            // caret never moved, so "Insert table…" wrote its
                            // table at the previous caret — the TOP of a
                            // freshly-opened note, under the heading — and Paste
                            // spliced the clipboard into the middle of the title
                            // line. Interior blank lines all resolve either way;
                            // the loose form differs from the precise one ONLY
                            // in that branch, where it estimates instead of
                            // giving up, and it returns doc.length here. The
                            // null guard below stays regardless.
                            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
                            const sel = view.state.selection.main;
                            if (pos !== null && (sel.empty || pos < sel.from || pos > sel.to)) {
                                view.dispatch({ selection: { anchor: pos } });
                            }
                            openContextMenu({
                                x: e.clientX,
                                y: e.clientY,
                                // "<noun> actions", the form every raiser uses
                                // — the menu is announced as "Note actions
                                // menu" wherever it was raised, rather than
                                // this one alone reading out a file name. The
                                // document is not in doubt: the reader's own
                                // click is what opened it.
                                label: 'Note actions',
                                opener: document.activeElement as HTMLElement | null,
                                entries: editorMenuEntries(view, onNotify),
                            });
                        }}
                        /* A dropped .md replaces this pane's whole note. That is a
                           programmatic dispatch, which neither half of Reading
                           mode blocks — until #17's fix a file dropped on a note
                           being read replaced it, and autosave wrote it to disk.
                           So Reading mode refuses here, and SAYS so: a drop that
                           does nothing looks broken. Both cancels stay
                           unconditional (an uncancelled file drop navigates the
                           app away with every unsaved buffer), and the cursor is
                           not turned into a no-drop one: `dropEffect = 'none'`
                           would swallow the drop, and the explanation with it. */
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={async (e) => {
                            e.preventDefault();
                            const item = e.dataTransfer.items?.[0];
                            if (!item || item.kind !== 'file') return;
                            // Before any await: the items are unreadable once
                            // this handler returns.
                            const dropped = item.getAsFile();
                            if (!dropped || !dropped.name.endsWith('.md')) return;
                            const view = viewRef.current;
                            if (!view) return;
                            // Dropping onto a pane is acting on it, as a click
                            // is — and a drop brings no mousedown. Without this,
                            // in a split the ⌘E the refusal names toggled the
                            // OTHER pane (measured). A keyboard still in another
                            // pane is let go too: dragging from the desktop does
                            // not move it, and the refusal's dialog hands focus
                            // back to its opener on close, whose focus event
                            // made that other pane the focused one again
                            // (measured, typing in the right pane, dropping on
                            // the left).
                            const slot = e.currentTarget.closest('.editor-slot');
                            const keyboard = document.activeElement;
                            if (keyboard instanceof HTMLElement && keyboard !== document.body && !slot?.contains(keyboard)) {
                                keyboard.blur();
                            }
                            takeFocus();
                            // Decided before the read, so a refused file is
                            // never read at all.
                            if (!canWrite(view.state)) {
                                // The guide is read-only in every mode: ⌘E
                                // skips it, so naming ⌘E would be a dead end.
                                onNotify(file.isHelp
                                    ? `“${dropped.name}” did not replace the Help Guide, which cannot be edited.`
                                    : `“${dropped.name}” did not replace “${file.name}”, which is open for reading. ${READ_MODE_REASON}, then drop the file again.`);
                                return;
                            }
                            const text = await dropped.text();
                            // Re-read after the await, as Paste does: a ⌘E
                            // pressed during the read is the reader's latest word.
                            const now = viewRef.current;
                            if (!now || !canWrite(now.state)) return;
                            // The update listener marks the tab dirty and
                            // schedules the save.
                            now.dispatch({ changes: { from: 0, to: now.state.doc.length, insert: text } });
                        }}
                    />
                )}
                {isDrawing && !unreadable && (
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
                {isNotebook && !unreadable && (
                    <Suspense fallback={<div className="drawing-pane drawing-pane-loading">Loading notebook…</div>}>
                        {/* Keyed on path, like a drawing: each notebook gets its
                            own tldraw instance, loaded from its own file. */}
                        <NotebookPane
                            key={path}
                            filePath={path}
                            content={tab.content}
                            onContentChange={onContentChange}
                            onConfirm={onConfirm}
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
