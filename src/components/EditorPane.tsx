import React, { useEffect, useRef, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import type { EditorState } from '@codemirror/state';
import BacklinksPanel from './BacklinksPanel';
import ConfirmDialog from './ConfirmDialog';
import DocumentPane from './DocumentPane';
import type { PaneImageDelete } from './DocumentPane';
import TabBar from './TabBar';
import { getBacklinkNodes } from '../utils/graph';
import { dismissOnEscape } from '../utils/escapeDismiss';
import { isPdfFile, isCanvasFile } from '../utils/fileTypes';
import { paneSizes, paneById, focusedPane, canGoBack, canGoForward, canSplitToPane, MAX_PANES } from '../utils/tabPanes';
import type { WikiLinkTarget } from '../editor/wikiLinkComplete';
import 'katex/dist/katex.min.css';
import type { ActiveFile, OpenTab, GraphData, GraphNode, TabLayout, Theme, OpenNodeHandler, OpenNoteByNameHandler, EditorRevealRequest } from '../types';

// Same reasoning as the drawing canvas: pdf.js + pdf-lib only load once a PDF
// is actually opened.
const PdfPane = lazy(() => import('./PdfPane'));

interface EditorPaneProps {
    /** Every open document, flat. */
    tabs: OpenTab[];
    /** The columns, each with its own tabs, and which column has focus. */
    layout: TabLayout;
    theme: Theme;
    /** Spaces a Tab inserts — and how far Tab indents a list item. */
    tabSize: number;
    saveStatus: string;
    /** Front `path` in `paneId` and give that column the focus. */
    onSelectTab: (paneId: string, path: string) => void;
    /** Close ONE document. The last tab of a column takes the column with it. */
    onCloseTab: (path: string) => void;
    /** Close a whole column, and every tab in it. */
    onClosePane: (paneId: string) => void;
    /** Move a document into `toPaneId` so it lands at `toIndex` (an index into
     *  that pane's PRE-removal paths) — a reorder when it is already there. */
    onMoveTab: (path: string, toPaneId: string, toIndex: number) => void;
    /** Take a document out of its column and give it one of its own at `at`. */
    onSplitTabToPane: (path: string, at: number) => void;
    /** Record the columns' widths (percentages summing to 100), or null to put
     *  them back to equal columns. */
    onResizePanes: (sizes: number[] | null) => void;
    /** Ask for a new note — named in the app's own dialog, opened in whichever
     *  column has the focus. */
    onNewNote: () => void;
    onPaneBack: (paneId: string) => void;
    onPaneForward: (paneId: string) => void;
    onFocusPane: (path: string) => void;
    onToggleMode: (path: string) => void;
    /** Path-explicit: several documents are editable at once, and a canvas's
     *  debounced save can land after its pane has gone away. */
    onContentChange: (path: string, content: string) => void;
    /** Buffer content and write it immediately, skipping the save debounce. */
    onFlushNow: (path: string, content: string) => void;
    /** Read an unreadable tab's file again (OpenTab.readError); resolves true
     *  once the tab holds its text. Stable, for DocumentPane's memo. */
    onRetryRead: (path: string) => Promise<boolean>;
    /** A notebook's exported PDF sends you to the notebook — see PdfPane. */
    onOpenNotebookSource: (pdfPath: string, notebookPath: string) => void;
    /** Write a notebook out as a PDF beside it (a row of its pane's ⋯ menu). */
    onExportNotebook: (file: ActiveFile) => void;
    onOpenNote: OpenNoteByNameHandler;
    /** Every open document's EditorState, OWNED BY App so it outlives this
     *  component — the graph view unmounts it. This component only hands it to
     *  the panes and prunes it to the open documents. */
    stateCache: Map<string, EditorState>;
    /** The [[ autocomplete's source. Baked into each cached state, so it must
     *  be stable for the app's life (App's is). */
    getWikiLinkTargets: () => WikiLinkTarget[];
    /** Say something to the reader in the app's own dialog — App's `tell`,
     *  threaded down to the panes because a right-click menu row that cannot
     *  reach the clipboard has to say so. Stable, or DocumentPane's memo (and
     *  with it every pane's) stops holding. */
    onNotify: (message: string) => void;
    /** Ask a yes/no question in the app's own dialog. Resolves false on cancel. */
    onConfirm: (question: { title: string; body: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>;
    graph: GraphData;
    onOpenNode: OpenNodeHandler;
    /** One-shot select+scroll order from vault search (null = nothing pending). */
    revealRequest: EditorRevealRequest | null;
    onRevealHandled: () => void;
}

/** Inline positioning for the linked-mentions popover (fixed bottom/right).
 *  UPWARD from its toggle, because that toggle now lives in the status pill a
 *  few pixels off the bottom of the window — anchored below it, as it was when
 *  it sat in the top bar, a `max-height: 50vh` popover opened entirely off
 *  screen. */
interface PopoverPos {
    bottom: number;
    right: number;
}

/** Where a dragged tab would land: the insertion index among the columns, plus
 *  the half of which column to paint while the pointer is there. */
interface DropTarget {
    index: number;
    pane: number;
    side: 'left' | 'right';
}

/**
 * The narrowest a pane may be DRAGGED to, in pixels.
 *
 * DERIVED, not measured — this was raised alongside the rewrite that gave every
 * column a tab strip and a header of its own, and there was no browser to
 * measure in at the time, so check it on screen before trusting it. The
 * arithmetic: a column's STRIP has to hold one tab at its 80px floor plus the
 * strip's 18px + 8px insets and the `+` / `⌄` buttons at 24px each with 4px
 * gaps, which is about 164px; its HEADER has four 24px buttons, 12px of padding
 * and the gaps between them, about 115px before the title gets a single
 * character. 200 clears the strip and leaves the header a word of its name.
 *
 * A PIXEL floor, and so it lives here rather than in utils/tabPanes.ts, which
 * is pure and never sees one — that module's own floor is about keeping a
 * STORED arrangement sane and is deliberately far below this. It is a gesture
 * constraint only: a window shrunk after a drag simply shows narrower panes,
 * because re-clamping on every resize would rewrite an arrangement the reader
 * made from a window size they were only passing through.
 */
const MIN_PANE_PX = 200;

/** Both sides of the geometry format identically, so React's style diff — which
 *  compares values — writes nothing when a re-render lands mid-drag and the
 *  widths it is holding have not moved. */
const pct = (n: number) => n.toFixed(4);

/* A pane's share of the editor, as a `flex-grow` naming that column's variable.
   Grow against the stylesheet's zero basis, so the browser shares the width out
   by dividing by the sum of the factors: the columns tile the container exactly
   however the percentages rounded, which a percentage basis would leave as a
   seam or an overflow. The fallback of 1 is equal columns.

   ONE FROZEN OBJECT PER COLUMN, not one built per render: this is the prop that
   would otherwise defeat DocumentPane's memo, and a stable identity means a
   pane's props do not change at all while a divider is being dragged. The tab
   strip sizes its groups from the same variables (TabBar's TAB_GROUP_STYLE), so
   a group and its column are one mechanism at every pane count — including one,
   where `--pane-w-0` is simply 100. */
const PANE_WIDTH_STYLE: React.CSSProperties[] = Array.from(
    { length: MAX_PANES }, (_, i) => ({ flexGrow: `var(--pane-w-${i}, 1)` }));

/**
 * What a document's pane, and its cached EditorState, are held under.
 *
 * Its ID, because a path is not enough: renameFile/moveFile deliberately
 * overwrite an existing name, so for one commit two different documents answer
 * to the same path — and keyed by path React matched the survivor to the pane
 * the OVERWRITTEN document was drawn in and kept that pane's view, while the
 * state cache handed over its text and its undo history. The renamed file's
 * first keystroke then saved the dead document's bytes over it.
 *
 * And its PATH, because a rename must still rebuild the view: the update
 * listener that reports edits has the path baked into it (see DocumentPane), so
 * a pane carried across a rename would go on reporting the old one and every
 * edit after it would land nowhere. Injective either way — an id holds no '|'.
 */
const paneKey = (tab: OpenTab) => `${tab.id}|${tab.file.path}`;

/** The least a pane may be left holding, as a percentage of the editor. */
function paneFloorPct(totalPx: number): number {
    return totalPx > 0 ? (MIN_PANE_PX / totalPx) * 100 : 0;
}

/**
 * Where the boundary between two panes may sit, given what the pair holds
 * between them.
 *
 * The floor is capped at HALF THE PAIR, which is what keeps the range from ever
 * being empty (`lo <= pair / 2` gives `pair - lo >= lo`) — so a pair with no
 * room for two full-width panes pins its divider at the midpoint rather than
 * jamming or going negative. Deliberately measured against the pair rather than
 * against an equal share of the whole editor: the drag only ever moves these
 * two, and capping by the pane count instead put the floor at a tenth of a
 * five-column editor — 118px on a 1176px one, well under the minimum this is
 * here to keep.
 */
function clampEdge(want: number, pair: number, floor: number): number {
    const lo = Math.min(floor, pair / 2);
    return Math.min(Math.max(want, lo), pair - lo);
}

/** A divider drag in flight. Everything it needs is captured at pointerdown:
 *  the gesture must not depend on a render happening during it. */
interface PaneResize {
    handle: HTMLElement;
    pointerId: number;
    /** The boundary being moved: between pane `edge` and pane `edge + 1`. */
    edge: number;
    /** The columns this gesture is moving, by id — joined, so one string
     *  comparison says whether they are still the columns on screen. */
    paneIds: string;
    /** The editor's width, read once — the whole gesture is measured in it. */
    total: number;
    x0: number;
    x: number;
    /** The widths at grab time: what the drag moves away from, and what Escape
     *  and a cancelled pointer put back. */
    start: number[];
    live: number[];
    floor: number;
    frame: number | null;
    onKey: (e: KeyboardEvent) => void;
}

/**
 * The editor half of the workspace: a row of panes, all drawn at once, above
 * their tab strips and below a floating status bar.
 *
 * A PANE is a column owning its own set of tabs and showing one of them (see
 * utils/tabPanes.ts); most workspaces are one pane with a few tabs, which is
 * the ordinary tab strip. Each column is a DocumentPane owning its own
 * CodeMirror view; this component owns what is shared between them — handing
 * App's per-document EditorState cache to the panes and pruning it, the tab
 * strip, the status bar (which is about the FOCUSED pane's document), the
 * image-delete confirmation, and the PDF panes, which are deliberately NOT
 * inside a pane so they can outlive it.
 */
export default function EditorPane({ tabs, layout, theme, tabSize, saveStatus, onSelectTab, onCloseTab, onClosePane, onMoveTab, onSplitTabToPane, onResizePanes, onNewNote, onPaneBack, onPaneForward, onFocusPane, onToggleMode, onContentChange, onFlushNow, onRetryRead, onOpenNotebookSource, onExportNotebook, onOpenNote, stateCache, getWikiLinkTargets, onNotify, onConfirm, graph, onOpenNode, revealRequest, onRevealHandled }: EditorPaneProps) {
    const byPath = useMemo(() => new Map(tabs.map(t => [t.file.path, t])), [tabs]);

    // The columns on screen, the document each one shows, and the share of the
    // width each one holds, from ONE walk: a pane whose showing path has no
    // open document draws nothing — the two structures' documented failure mode
    // (see utils/tabPanes.ts) — and it has to drop out of all three together,
    // or the strip's groups, the columns and the dividers stop describing the
    // same panes. What is left is re-shared among them. ONE array drives the
    // strip and the columns both, which is what guarantees that group i and
    // column i are the same pane.
    const { panes, paneTabs, widths } = useMemo(() => {
        const kept: typeof layout.panes = [];
        const docs: OpenTab[] = [];
        const share: number[] = [];
        const stored = paneSizes(layout);
        layout.panes.forEach((pane, i) => {
            const tab = byPath.get(pane.activePath);
            if (!tab) return;
            kept.push(pane);
            docs.push(tab);
            share.push(stored[i]);
        });
        const sum = share.reduce((a, b) => a + b, 0);
        return { panes: kept, paneTabs: docs, widths: sum > 0 ? share.map(s => (s * 100) / sum) : [] };
    }, [layout, byPath]);
    const paneCount = panes.length;

    /** Each pane's left edge, in the same percentages. */
    const edges = useMemo(() => {
        const out: number[] = [];
        let x = 0;
        for (const w of widths) { out.push(x); x += w; }
        return out;
    }, [widths]);

    /** Where each visible document's column is — what the PDF panes, which
     *  float over a column rather than sitting in it, are placed from. */
    const paneGeom = useMemo(() => {
        const m = new Map<string, { index: number; left: number; width: number }>();
        paneTabs.forEach((t, i) => m.set(t.file.path, { index: i, left: edges[i], width: widths[i] }));
        return m;
    }, [paneTabs, edges, widths]);

    /**
     * The pane geometry, published as CSS variables on this component's root —
     * the one box holding the tab strip, the columns and the PDF panes floating
     * over them. Everything that has to line up with a column reads them, so a
     * divider drag moves all of it with one write and no render at all.
     *
     * A fresh object per render is the point, not a cost: React writes only the
     * properties whose VALUES changed, so a re-render landing mid-drag (a save
     * status arriving, a keystroke in a neighbouring pane) finds the committed
     * widths unchanged and leaves the gesture's own writes exactly where they
     * are. Both sides format through `pct` so that comparison is on the same
     * strings. Removing a stale variable is React's too — a five-column
     * workspace's leftovers go when a smaller one renders.
     */
    const splitVars = useMemo(() => {
        const vars: Record<string, string> = {};
        widths.forEach((w, i) => {
            vars[`--pane-w-${i}`] = pct(w);
            vars[`--pane-x-${i}`] = pct(edges[i]);
        });
        return vars as React.CSSProperties;
    }, [widths, edges]);

    const paneRootRef = useRef<HTMLDivElement | null>(null);
    const splitRef = useRef<HTMLDivElement | null>(null);

    const focusedPath = focusedPane(layout)?.activePath ?? null;
    const focusedTab = focusedPath ? byPath.get(focusedPath) ?? null : null;
    const activeFile: ActiveFile | null = focusedTab?.file ?? null;
    /** The focused document could not be read (OpenTab.readError): its pane
     *  shows only that, so the status bar has nothing to count. */
    const unreadable = !!focusedTab?.readError;

    const isDrawing = !!activeFile && !activeFile.isHelp && isCanvasFile(activeFile.name);
    const isPdf = !!activeFile && !activeFile.isHelp && isPdfFile(activeFile.name);
    /** True whenever a non-CodeMirror surface owns the focused pane. */
    const isCanvas = isDrawing || isPdf;

    // ── The keyboard after a tab-bar click ─────────────────────────────────
    // A tab is a plain `<div>`, so clicking one leaves the keyboard on `<body>`,
    // and Chromium then sends Space, PageDown and the arrows to whatever was
    // clicked last — the tab bar, which scrolls nothing. A note opened from its
    // tab ignored every scroll key until the reader clicked its text (#35).
    //
    // What should hold the keyboard is the pane's to know (it owns the view),
    // when is this component's (it owns the tab bar) — so each note pane
    // registers a "take the keyboard" function here, by path: one pane per
    // path is on screen at a time. A canvas pane registers nothing, and keeps
    // what it does today.
    const [keyboardTargets] = useState(() => new Map<string, () => void>());
    const registerKeyboardTarget = useCallback((path: string, take: () => void) => {
        keyboardTargets.set(path, take);
        // Only its OWN entry: a late cleanup (StrictMode's re-run, an unreadable
        // pane remounting readable) must not delete the newer pane's.
        return () => { if (keyboardTargets.get(path) === take) keyboardTargets.delete(path); };
    }, [keyboardTargets]);
    const focusedPathRef = useRef<string | null>(null);
    useEffect(() => { focusedPathRef.current = focusedPath; }, [focusedPath]);

    /*
     * Give the keyboard to the focused note once a tab-bar gesture has settled.
     *
     * In a frame, not an effect: the switch mounts a new pane, and StrictMode
     * double-runs that pane's effects AFTER this component's — its cleanup
     * destroys the view it just built and the ref callback builds another, so
     * a scroller focused from an effect here is gone a moment later and the
     * keyboard is back on `<body>`. By the next frame both are done, and the
     * pane's function reads its view when called, so it reaches the live one.
     *
     * Never from something that TYPES — an Edit-mode caret, the Find field (or
     * its bar's buttons), a rename field — or a menu or dialog: a middle-click
     * or × close is `preventDefault`ed so those keep it, and a cached state's
     * search panel, which focuses Find as it mounts, has already been handed
     * back by `returnKeyboard`. Anything else is taken, a button included: that same
     * `preventDefault` left a header button (the mode toggle, the graph view's)
     * holding the keyboard through a × close, and Space then pressed it —
     * measured: the note that came to the front flipped into Edit mode, or the
     * graph opened. Clicking the tab already in front re-renders nothing but
     * still moved the keyboard to `<body>` — the frame covers it with no
     * special case.
     */
    const handKeyboardToNote = useCallback(() => {
        requestAnimationFrame(() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && (active.isContentEditable
                || active.closest('input, textarea, select, .cm-panels, [role="dialog"], [role="menu"], [role="listbox"]'))) return;
            const path = focusedPathRef.current;
            if (path) keyboardTargets.get(path)?.();
        });
    }, [keyboardTargets]);
    const selectFromTabBar = useCallback((paneId: string, path: string) => {
        onSelectTab(paneId, path);
        handKeyboardToNote();
    }, [onSelectTab, handKeyboardToNote]);
    const closeFromTabBar = useCallback((path: string) => {
        onCloseTab(path);
        handKeyboardToNote();
    }, [onCloseTab, handKeyboardToNote]);
    /** A group's `+`. Focus its column FIRST: `openTab` opens into whichever
     *  pane has the focus, so without this the note lands in the column the
     *  reader was last in rather than the one they pressed `+` in. */
    const newTabInPane = useCallback((paneId: string) => {
        const pane = paneById(layout, paneId);
        if (pane) onSelectTab(paneId, pane.activePath);
        onNewNote();
    }, [layout, onSelectTab, onNewNote]);

    // ── Linked mentions popover ────────────────────────────────────────────
    const [showBacklinks, setShowBacklinks] = useState(false);
    const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null);
    const backlinksBtnRef = useRef<HTMLButtonElement | null>(null);

    const backlinkNodes = useMemo<GraphNode[]>(
        () => getBacklinkNodes(graph, activeFile?.path),
        [graph, activeFile?.path]
    );

    const closeBacklinks = useCallback(() => setShowBacklinks(false), []);

    // The popover lives only while its toggle does (the status bar's
    // markdown-only items). Focus moving to Help, a canvas or an unreadable tab
    // by keyboard closes it rather than leaving it hidden but still OPEN — still
    // registered with `dismissOnEscape`, where it took the next Escape unseen
    // and, being newest, outranked a vault menu that was on screen (#36 review).
    // Adjusted during render, React's pattern for state that follows a prop.
    const backlinksAvailable = !!activeFile && !activeFile.isHelp && !isCanvas && !unreadable;
    if (showBacklinks && !backlinksAvailable) setShowBacklinks(false);

    const toggleBacklinks = useCallback(() => {
        setShowBacklinks(prev => {
            const next = !prev;
            if (next && backlinksBtnRef.current) {
                const r = backlinksBtnRef.current.getBoundingClientRect();
                setPopoverPos({
                    bottom: Math.max(8, Math.round(window.innerHeight - r.top + 6)),
                    right: Math.max(8, Math.round(window.innerWidth - r.right)),
                });
            }
            return next;
        });
    }, []);

    // Dismiss the popover on outside-click, Escape, or window resize. Escape
    // goes through `dismissOnEscape`, so one that the note's search bar, a
    // selection or a newer surface already handled leaves the popover open
    // (#36). Registered only while open: registration order is its stacking.
    useEffect(() => {
        if (!showBacklinks) return;
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.backlinks-popover') || target.closest('.backlinks-toggle')) return;
            setShowBacklinks(false);
        };
        const onResize = () => setShowBacklinks(false);
        document.addEventListener('pointerdown', onPointerDown, true);
        const stopEscape = dismissOnEscape(closeBacklinks);
        window.addEventListener('resize', onResize);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            stopEscape();
            window.removeEventListener('resize', onResize);
        };
    }, [showBacklinks, closeBacklinks]);

    // ── The status bar's word and character counts ─────────────────────────
    //
    // Counted over a DEBOUNCED copy of the text, never over `focusedTab.content`
    // directly: that string is new on every keystroke, so a plain useMemo would
    // walk the whole document — split included — on every character, on the same
    // frames the decoration pass already owns (see the live-preview skill for
    // what that pass costs on a long note). Nobody reads a word count tick per
    // character; a quarter of a second after typing stops is soon enough.
    //
    // A canvas has no words and an unreadable tab holds no text, so neither is
    // counted at all — and neither is the count shown for them.
    const countable = !!activeFile && !isCanvas && !unreadable;
    const countPath = countable ? activeFile!.path : null;
    const liveText = countable ? focusedTab?.content ?? '' : '';
    const [counted, setCounted] = useState<{ path: string | null; text: string }>(
        { path: countPath, text: liveText });
    // A SWITCH is not typing: showing the previous note's numbers for a quarter
    // of a second beside the new note's name reads as a bug, so a change of
    // document lands at once. Adjusted during render, React's pattern for state
    // that follows a prop — the same one `showBacklinks` above uses.
    if (counted.path !== countPath) setCounted({ path: countPath, text: liveText });
    useEffect(() => {
        const timer = setTimeout(() => setCounted(prev => (
            prev.path === countPath && prev.text === liveText ? prev : { path: countPath, text: liveText }
        )), 250);
        return () => clearTimeout(timer);
    }, [countPath, liveText]);
    const counts = useMemo(() => {
        const trimmed = counted.text.trim();
        return { words: trimmed ? trimmed.split(/\s+/).length : 0, chars: counted.text.length };
    }, [counted.text]);

    // ── Embedded images ────────────────────────────────────────────────────
    // Deleting one is the editor's only action that needs the app: it has to be
    // confirmed first, since the picture goes to .Garbage with it. The document
    // edit itself stays inside the editor subsystem — this only decides whether
    // it happens (see imageWidget.ts).
    const [imageDelete, setImageDelete] = useState<PaneImageDelete | null>(null);
    const handleImageDelete = useCallback((request: PaneImageDelete) => setImageDelete(request), []);

    const closeImageDelete = useCallback(() => setImageDelete(null), []);
    // Not inside a state updater: StrictMode invokes those twice, and this one
    // edits the document.
    const runImageDelete = useCallback(() => {
        imageDelete?.run();
        setImageDelete(null);
    }, [imageDelete]);

    // (Escape, the click outside and the focus round trip are ConfirmDialog's.)

    // A pending request names a position in the document that raised it, and
    // that document can leave the screen while the dialog is up (a tab switch,
    // ⌘N, the pane being closed). The question stops meaning anything then, so
    // it is withdrawn rather than answered against the wrong note — removeEmbed
    // would refuse it anyway, silently.
    const visibleKey = panes.map(p => p.activePath).join('\n');
    useEffect(() => {
        const visible = new Set(visibleKey ? visibleKey.split('\n') : []);
        setImageDelete(prev => (prev && visible.has(prev.path) ? prev : null));
    }, [visibleKey]);

    // Drop cached editor states for documents that are no longer open — the
    // only thing that ever empties App's cache. Keyed on the joined key string
    // so it doesn't run on every keystroke. It does not run while the graph
    // view has this component unmounted; its first run on the way back clears
    // whatever closed meanwhile, which nothing could adopt in between (ids
    // never repeat — see App's newTabId).
    const openTabsKey = tabs.map(paneKey).join('\n');
    useEffect(() => {
        const open = new Set(openTabsKey ? openTabsKey.split('\n') : []);
        for (const key of stateCache.keys()) {
            if (!open.has(key)) stateCache.delete(key);
        }
    }, [openTabsKey, stateCache]);

    // ── Opening a tab as a column of its own ───────────────────────────────
    // A tab dragged out of its strip and dropped on the panes below leaves its
    // pane and becomes a new column. The drop zone is a layer OVER the panes
    // rather than handlers on them: CodeMirror handles `drop` itself (it would
    // insert the dragged text), and a PDF pane would swallow it entirely. It
    // exists only while a tab is actually in flight, so nothing else is ever
    // intercepted.
    const [draggingPath, setDraggingPath] = useState<string | null>(null);
    const [dropAt, setDropAt] = useState<DropTarget | null>(null);
    /** Whether the pointer is actually over the panes. The zone exists for the
     *  whole drag (it has to, to keep CodeMirror off the drop), but what it says
     *  is only about where the pointer IS. */
    const [overZone, setOverZone] = useState(false);

    const endDrag = useCallback(() => {
        setDraggingPath(null);
        setDropAt(null);
        setOverZone(false);
    }, []);

    const splittable = canSplitToPane(layout, draggingPath);
    /** Dragged onto an editor that can't take another column — say why rather
     *  than look broken. Gated on the pointer being over the panes: ungated it
     *  announced itself from the moment the drag started, so merely re-ordering
     *  a tab along a strip raised a message about something the user wasn't
     *  doing. */
    const dropFull = overZone && !!draggingPath && !splittable;

    /** The column the dragged tab is the ONLY tab of, or -1. Dropping such a
     *  tab back onto its own column is refused by splitToPane — the arrangement
     *  it asks for is already on screen — so the two indices that would mean
     *  that are painted as no target at all rather than promising a move that
     *  will not happen. */
    const soloPane = useMemo(() => {
        if (!draggingPath) return -1;
        const i = panes.findIndex(p => p.paths.includes(draggingPath));
        return i >= 0 && panes[i].paths.length === 1 ? i : -1;
    }, [draggingPath, panes]);

    const handleDropOver = (e: React.DragEvent<HTMLDivElement>) => {
        setOverZone(true);
        if (!splittable || paneCount === 0) { setDropAt(null); return; }
        // The index below counts the DRAWN columns, and `splitToPane` splices
        // into `layout.panes` — which the memo above may have filtered short
        // when a pane's showing tab has no document. Refuse rather than land the
        // new column in the wrong slot; the same guard `startResize` uses.
        if (widths.length !== layout.panes.length) { setDropAt(null); return; }
        const r = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        // Which pane the pointer is in, walked along the real boundaries: the
        // columns are no longer equal, so neither the pane nor its midpoint can
        // be divided out of the width any more.
        let pane = 0;
        while (pane + 1 < paneCount && x >= edges[pane + 1]) pane++;
        // Which half of that pane decides which side of it the new column lands.
        const right = x - edges[pane] > widths[pane] / 2;
        const index = right ? pane + 1 : pane;
        const side = right ? 'right' : 'left';
        if (index === soloPane || index === soloPane + 1) { setDropAt(null); return; }
        e.preventDefault();                     // without this the drop is refused
        e.dataTransfer.dropEffect = 'move';
        // dragover fires continuously — several times a second even with the
        // pointer still. Keeping the same object when the answer hasn't changed
        // is what stops each tick re-rendering this component and the tab bar.
        setDropAt(prev => (prev && prev.index === index && prev.pane === pane && prev.side === side)
            ? prev
            : { index, pane, side });
    };

    const handleDropLeave = () => { setOverZone(false); setDropAt(null); };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (draggingPath && dropAt && splittable) onSplitTabToPane(draggingPath, dropAt.index);
        endDrag();
    };

    // ── Resizing the panes ─────────────────────────────────────────────────
    // The gesture writes the geometry variables straight onto the root and
    // commits to the layout once, on release.
    //
    // LIVE, because the width is a decision about the text — you cannot judge
    // where a line wraps or whether a table still fits without seeing it — and
    // because this app's own sidebar drag is live already.
    //
    // WITHOUT REACT, because the frame budget belongs to what the width change
    // already costs: editor/tableFit.ts re-fits every visible table on each one
    // and PdfViewer re-lays-out and re-rasterizes its windowed pages, both
    // ResizeObserver-driven and neither able to be told to wait. A setState per
    // frame would put a re-render of this component, the tab strip and every
    // mounted PDF pane on top of that — and would run App's persist effect, so
    // the whole session would be written to localStorage sixty times a second.
    const resizeRef = useRef<PaneResize | null>(null);

    /** Move the columns. Only the two panes either side of the boundary can
     *  have changed, but writing the row is a handful of property sets and
     *  keeps this the single writer. */
    const writePaneVars = useCallback((cols: number[]) => {
        const root = paneRootRef.current;
        if (!root) return;
        let x = 0;
        for (let i = 0; i < cols.length; i++) {
            root.style.setProperty(`--pane-w-${i}`, pct(cols[i]));
            root.style.setProperty(`--pane-x-${i}`, pct(x));
            x += cols[i];
        }
    }, []);

    /**
     * The one way out of the gesture, however it ended.
     *
     * A cancel puts the columns back BY HAND: React has not re-rendered at any
     * point during the drag, so its own view of these variables is still the
     * committed one and nothing would otherwise correct the last frame.
     *
     * `restore` is false for the one exit where that reasoning inverts —
     * abandoning because the panes being moved are no longer the panes on
     * screen. React has just re-rendered (that is what raised the abandon), so
     * repainting the row this gesture started from would drag the columns that
     * REPLACED them into a shape nobody chose.
     *
     * Stable for the app's life, deliberately: the unmount guard below has it as
     * a dependency, so an identity that moved would run that cleanup — and
     * cancel a live drag — on every re-render, and this component re-renders on
     * every keystroke and every save status.
     */
    const endResize = useCallback((commit: boolean, restore = true) => {
        const drag = resizeRef.current;
        if (!drag) return;                  // a lost capture after a normal pointerup
        resizeRef.current = null;
        if (drag.frame !== null) cancelAnimationFrame(drag.frame);
        if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
            drag.handle.releasePointerCapture(drag.pointerId);
        }
        drag.handle.classList.remove('is-resizing');
        window.removeEventListener('keydown', drag.onKey, true);
        document.body.classList.remove('is-resizing-panes');
        if (commit) onResizePanes(drag.live);
        else if (restore) writePaneVars(drag.start);
    }, [onResizePanes, writePaneVars]);

    /** Ends a gesture whose own pointer never will. */
    const endsGesture = (e: React.PointerEvent<HTMLSpanElement>) =>
        e.pointerId === resizeRef.current?.pointerId;

    // The whole editor going away — ⌘ to the Neural Brain view — must not leave
    // the window stuck on a col-resize cursor with text selection off.
    useEffect(() => () => { if (resizeRef.current) endResize(false); }, [endResize]);

    /** The columns this render is drawing, by id — the drag's own premise, in
     *  the one form a single comparison can test. */
    const paneIdsKey = panes.map(p => p.id).join('\n');

    /**
     * ...and neither must the divider going away UNDER the gesture.
     *
     * Every exit from the drag is a React handler on the handle, and React
     * delegates at the root: a handle removed from the document while it still
     * holds the capture gets its implicit `lostpointercapture` at a detached
     * node, which reaches no listener. Nothing would then release the body
     * class, the Escape listener, or startResize's own guard — dividers would
     * be dead and the whole app stuck on `col-resize` for the rest of the
     * session. Closing a column is enough to do it.
     *
     * The same test covers the drag's premises moving without the handle going
     * anywhere (a pane closing beside it), since `start` describes a pane list
     * that no longer exists either way.
     */
    useEffect(() => {
        const drag = resizeRef.current;
        if (drag && (drag.paneIds !== paneIdsKey || drag.start.length !== paneCount)) {
            endResize(false, false);
        }
    }, [paneIdsKey, paneCount, endResize]);

    const startResize = (e: React.PointerEvent<HTMLSpanElement>, edge: number) => {
        if (e.button !== 0 || !e.isPrimary || resizeRef.current) return;
        // A pane whose showing path has no open document draws no column — the
        // two structures' documented failure mode — so the row is shorter than
        // the layout's pane list, and a row that short is one setPaneSizes would
        // decline, leaving the gesture to move the columns and then silently not
        // be recorded. Refuse it instead.
        if (widths.length !== layout.panes.length) return;
        const total = splitRef.current?.getBoundingClientRect().width ?? 0;
        if (!(total > 0)) return;
        const handle = e.currentTarget;
        // Capture is what keeps every later move away from CodeMirror, from a
        // PDF pane's capture-phase pointerdown and from tldraw, and what makes a
        // drag that leaves the window still arrive back here.
        handle.setPointerCapture(e.pointerId);
        // Capture does not focus, and the mousedown that would is cancelled
        // below — so without this the arrow keys the Help guide describes ("click
        // a line and nudge it") would never reach keyResize, and the only way to
        // the divider at all would be tabbing out of a CodeMirror that binds Tab.
        handle.focus({ preventScroll: true });
        handle.classList.add('is-resizing');
        // Capture phase and stopped: CodeMirror binds Escape too, and focus may
        // still be sitting in one of the panes.
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key !== 'Escape') return;
            ev.preventDefault();
            ev.stopPropagation();
            endResize(false);
        };
        window.addEventListener('keydown', onKey, true);
        document.body.classList.add('is-resizing-panes');
        resizeRef.current = {
            handle, pointerId: e.pointerId, edge, paneIds: paneIdsKey, total,
            x0: e.clientX, x: e.clientX,
            start: widths.slice(), live: widths.slice(),
            floor: paneFloorPct(total), frame: null, onKey,
        };
    };

    const moveResize = (e: React.PointerEvent<HTMLSpanElement>) => {
        const drag = resizeRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        drag.x = e.clientX;
        if (drag.frame !== null) return;
        // At most one write per frame — and none at all when the clamped answer
        // has not moved. Holding a divider against its floor would otherwise
        // re-fit every table and re-rasterize every PDF page sixty times a
        // second for a picture that never changes.
        drag.frame = requestAnimationFrame(() => {
            drag.frame = null;
            const k = drag.edge;
            const pair = drag.start[k] + drag.start[k + 1];
            const left = clampEdge(
                drag.start[k] + ((drag.x - drag.x0) / drag.total) * 100, pair, drag.floor);
            if (Math.abs(left - drag.live[k]) < 0.01) return;
            // Only the pair moves: every other pane keeps exactly the width it
            // had, and the pair's total is conserved to the bit, so a long drag
            // cannot accumulate drift.
            drag.live = drag.start.slice();
            drag.live[k] = left;
            drag.live[k + 1] = pair - left;
            writePaneVars(drag.live);
        });
    };

    /** Arrow keys nudge the boundary; Home/End send it to the pair's limits.
     *  Straight to the layout — a keypress is discrete and final, so there is
     *  nothing here worth deferring. */
    const keyResize = (e: React.KeyboardEvent<HTMLSpanElement>, edge: number) => {
        if (widths.length !== layout.panes.length) return;   // see startResize
        const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (!step && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const total = splitRef.current?.getBoundingClientRect().width ?? 0;
        const pair = widths[edge] + widths[edge + 1];
        const floor = paneFloorPct(total);
        const want = e.key === 'Home' ? 0
            : e.key === 'End' ? pair
            : widths[edge] + step * (e.shiftKey ? 10 : 2);
        const next = widths.slice();
        next[edge] = clampEdge(want, pair, floor);
        next[edge + 1] = pair - next[edge];
        onResizePanes(next);
    };

    return (
        <div className="editor-pane" ref={paneRootRef} style={splitVars}>
            {/* Nothing but the tab groups: one per column, tiling the full
                width, so a group's right edge lands on its divider's rule. */}
            <div className="view-header">
                <TabBar
                    tabs={tabs}
                    panes={panes}
                    focusedPaneId={layout.activeId}
                    draggingPath={draggingPath}
                    onSelectTab={selectFromTabBar}
                    onCloseTab={closeFromTabBar}
                    onMoveTab={onMoveTab}
                    onNewTab={newTabInPane}
                    onDragStart={setDraggingPath}
                    onDragEnd={endDrag}
                />
            </div>

            {/* The columns, left to right, as wide as the reader left them
                (even until a divider is dragged). */}
            <div className={`editor-split${paneCount > 1 ? ' is-split' : ''}`} ref={splitRef}>
                {paneTabs.map((tab, i) => (
                    <DocumentPane
                        // An unreadable document's pane is keyed apart from its
                        // readable self, so a retry that succeeds REMOUNTS it
                        // and every mount-time step (the view built from the
                        // real text, the scroll-anchor hold) runs as on a fresh
                        // open. stateKey stays the same: the unreadable pane
                        // never builds a view, so there is nothing cached under
                        // it to adopt.
                        key={`${paneKey(tab)}${tab.readError ? '|unread' : ''}`}
                        stateKey={paneKey(tab)}
                        tab={tab}
                        paneId={panes[i].id}
                        isFocused={tab.file.path === focusedPath}
                        isSplit={paneCount > 1}
                        canBack={canGoBack(panes[i])}
                        canForward={canGoForward(panes[i])}
                        // Passed at every pane count, a lone one included: the
                        // strip's groups read the same variables, so one
                        // mechanism sizes both rows and there is no count at
                        // which they could disagree.
                        widthStyle={PANE_WIDTH_STYLE[i]}
                        theme={theme}
                        tabSize={tabSize}
                        stateCache={stateCache}
                        registerKeyboardTarget={registerKeyboardTarget}
                        getWikiLinkTargets={getWikiLinkTargets}
                        onContentChange={onContentChange}
                        onRetryRead={onRetryRead}
                        onFocusPane={onFocusPane}
                        onBack={onPaneBack}
                        onForward={onPaneForward}
                        onClosePane={onClosePane}
                        onToggleMode={onToggleMode}
                        onExportNotebook={onExportNotebook}
                        onOpenNote={onOpenNote}
                        onImageDelete={handleImageDelete}
                        onNotify={onNotify}
                        onConfirm={onConfirm}
                        revealRequest={revealRequest}
                        onRevealHandled={onRevealHandled}
                    />
                ))}
                {/* Drawn over the panes rather than as a border on them (a PDF
                    pane floats above its column and would otherwise cover it) —
                    and it is the handle that moves the boundary. Keyed by the
                    pane on its right, so a boundary's DOM stays with the
                    document it runs alongside rather than with an index a
                    split or a close can shift under it — which is what keeps
                    its hover and focus state from jumping to a neighbour. It
                    is NOT what makes a gesture safe against the pane list
                    moving: nothing about a key can be, and the abandon effect
                    above is what covers that. */}
                {paneTabs.slice(1).map((right, i) => (
                    <span
                        key={right.file.path}
                        className="editor-split-divider"
                        style={{ left: `calc(var(--pane-x-${i + 1}) * 1%)` }}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize the ${paneTabs[i].file.name} and ${right.file.name} panes`}
                        aria-valuenow={Math.round(widths[i])}
                        aria-valuemin={0}
                        aria-valuemax={Math.round(widths[i] + widths[i + 1])}
                        aria-valuetext={`${paneTabs[i].file.name} ${Math.round(widths[i])}%, ${right.file.name} ${Math.round(widths[i + 1])}%`}
                        tabIndex={0}
                        title="Drag to resize · double-click for equal widths"
                        onPointerDown={(e) => startResize(e, i)}
                        onPointerMove={moveResize}
                        // Only the gesture's OWN pointer ends it. A capture
                        // retargets that pointer and nothing else, so a second
                        // finger landing on the same strip still gets its
                        // pointerup here — and unguarded it committed the drag
                        // the first finger was still making.
                        onPointerUp={(e) => { if (endsGesture(e)) endResize(true); }}
                        onPointerCancel={(e) => { if (endsGesture(e)) endResize(false); }}
                        onLostPointerCapture={(e) => { if (endsGesture(e)) endResize(false); }}
                        onKeyDown={(e) => keyResize(e, i)}
                        // Not on pointerdown: cancelling that suppresses the
                        // compatibility mouse events, and with them the
                        // double-click this reset hangs off. mousedown is where
                        // the focus steal and the text selection come from
                        // anyway — the same trick the tab strip uses.
                        onMouseDown={(e) => e.preventDefault()}
                        onDoubleClick={() => onResizePanes(null)}
                        // Now that this strip takes pointer events it is also a
                        // drop target, and a file dropped from the desktop on an
                        // uncancelled one navigates the whole app away to it.
                        // It used to fall through to .view-content, which
                        // cancels its own.
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => e.preventDefault()}
                    />
                ))}
                {draggingPath && paneCount > 0 && (
                    <div
                        className="editor-split-dropzone"
                        onDragEnter={handleDropOver}
                        onDragOver={handleDropOver}
                        onDragLeave={handleDropLeave}
                        onDrop={handleDrop}
                    >
                        {/* The half of the column the tab would land beside —
                            that column's own half, since they can differ.
                            Recomputed here rather than stored in `dropAt`,
                            which would go stale under a resize and would churn
                            the identity check that keeps dragover from
                            re-rendering on every tick. */}
                        {dropAt && dropAt.pane < paneCount && (
                            <div
                                className="editor-split-drop-target"
                                style={{
                                    left: `${edges[dropAt.pane] + (dropAt.side === 'right' ? widths[dropAt.pane] / 2 : 0)}%`,
                                    width: `${widths[dropAt.pane] / 2}%`,
                                }}
                            />
                        )}
                        {dropFull && (
                            <div className="editor-split-drop-note">
                                The editor holds up to {MAX_PANES} panes side by side
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* One pane per OPEN PDF tab — kept mounted and merely hidden while
                off screen, so switching tabs never reloads the document or loses
                the reading position. That is why they live out here rather than
                inside a DocumentPane, which exists only while its tab is shown;
                each is positioned over the column its document occupies. Panes
                defer their disk/pdf.js work until first shown. */}
            {tabs.filter(t => !t.file.isHelp && isPdfFile(t.file.name)).map(tab => {
                // From the RENDERED columns, not the layout's paths: a pane
                // whose showing path has no open document draws no column, and
                // there is then nothing for this to stand over. Visible now
                // means "this document is some column's showing tab".
                const slot = paneGeom.get(tab.file.path);
                const visible = !!slot;
                // The placeholder has to stand in the SAME column as the pane it
                // is standing in for: bare `.pdf-pane` is full width and sits
                // above the pane headers, so on the restore path — the one that
                // can put a PDF straight into a column beside another — it
                // covered the notes beside it until the lazy chunk arrived.
                // Through the same variables as the pane itself, so it lines up
                // even mid-drag.
                const fallbackStyle = visible
                    ? {
                        left: `calc(var(--pane-x-${slot!.index}) * 1%)`,
                        width: `calc(var(--pane-w-${slot!.index}) * 1%)`,
                        right: 'auto' as const,
                    }
                    : undefined;
                return (
                    <Suspense
                        // Same key as a pane (see paneKey): matched by path
                        // alone, the pane of an overwritten PDF was handed to
                        // the file that replaced it and went on showing the old
                        // bytes — its re-read effect does re-run on the new
                        // handle, and returns early on the bytes it has.
                        key={paneKey(tab)}
                        fallback={visible ? (
                            <div className="pdf-pane pdf-pane-message" style={fallbackStyle}>
                                Loading PDF…
                            </div>
                        ) : null}
                    >
                        <PdfPane
                            file={tab.file}
                            isVisible={visible}
                            isFocused={tab.file.path === focusedPath}
                            slotIndex={slot?.index ?? 0}
                            slotLeft={slot?.left ?? 0}
                            slotWidth={slot?.width ?? 100}
                            onFocusPane={onFocusPane}
                            mode={tab.mode}
                            content={tab.content}
                            onContentChange={onContentChange}
                            onFlushNow={onFlushNow}
                            onOpenNotebookSource={onOpenNotebookSource}
                            isDirty={tab.dirty}
                        />
                    </Suspense>
                );
            })}

            {/* A floating pill over the bottom right of the editor, about the
                FOCUSED pane's document — the one thing in this component that
                is still single-valued, like ⌘E and ⌘S.
                `saveStatus` keeps it alive on its own because it is not only
                about a document: "Moving … to Trash…" and "Put back as …" are
                raised from the file tree and the bin, and with nothing open
                there would otherwise be nowhere for them to appear. */}
            {(activeFile || saveStatus) && (
                <div className="status-bar">
                    {backlinksAvailable && (
                        <button
                            ref={backlinksBtnRef}
                            className={`status-bar-item status-bar-btn backlinks-toggle${showBacklinks ? ' active' : ''}`}
                            onClick={toggleBacklinks}
                            title="Linked mentions"
                            aria-label="Linked mentions"
                            aria-expanded={showBacklinks}
                        >
                            {backlinkNodes.length} {backlinkNodes.length === 1 ? 'backlink' : 'backlinks'}
                        </button>
                    )}
                    {countable && (
                        <>
                            <span className="status-bar-item">{counts.words} {counts.words === 1 ? 'word' : 'words'}</span>
                            <span className="status-bar-item">{counts.chars} {counts.chars === 1 ? 'character' : 'characters'}</span>
                        </>
                    )}
                    {/* Always mounted, never conditional: it is written after
                        every autosave, and appearing and vanishing on a 2s cycle
                        while the reader types pumped ~38px through the row it
                        used to sit in. Its slot is reserved in CSS. It also
                        carries "Moving … to Trash…" and "Put back as …". */}
                    <span className="status-bar-item save-status">{saveStatus}</span>
                </div>
            )}

            {!activeFile && (
                <div className="editor-empty-overlay">
                    <div className="editor-empty-inner">
                        <p className="editor-empty-title">No file open</p>
                        <p className="editor-empty-hint">Select a file from the sidebar to begin editing.</p>
                    </div>
                </div>
            )}
            {imageDelete && (
                <ConfirmDialog
                    title="Delete image?"
                    confirmLabel="Delete"
                    danger
                    onConfirm={runImageDelete}
                    onCancel={closeImageDelete}
                >
                    <strong>{imageDelete.name}</strong> is removed from this note, and its file moves
                    to this folder’s <code>.Garbage</code> unless another note here still shows it.
                    Undo (⌘Z) brings both back.
                </ConfirmDialog>
            )}
            {showBacklinks && backlinksAvailable && (
                <BacklinksPanel
                    nodes={backlinkNodes}
                    onOpenNode={onOpenNode}
                    onClose={closeBacklinks}
                    style={popoverPos ? { position: 'fixed', bottom: popoverPos.bottom, right: popoverPos.right } : undefined}
                />
            )}
        </div>
    );
}
