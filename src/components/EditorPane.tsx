import React, { useEffect, useRef, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import type { EditorState } from '@codemirror/state';
import BacklinksPanel from './BacklinksPanel';
import ConfirmDialog from './ConfirmDialog';
import DocumentPane from './DocumentPane';
import type { PaneImageDelete } from './DocumentPane';
import TabBar from './TabBar';
import { Link, Eye, Edit2, PenTool } from './icons';
import { getBacklinkNodes } from '../utils/graph';
import { isPdfFile, isAnnotatedPdf, isDrawingFile } from '../utils/fileTypes';
import { activeGroup as activeGroupOf, canMergeIntoActive, paneSizes, MAX_SPLIT_PANES } from '../utils/tabGroups';
import type { WikiLinkTarget } from '../editor/wikiLinkComplete';
import 'katex/dist/katex.min.css';
import type { ActiveFile, OpenTab, GraphData, GraphNode, TabLayout, Theme, EditorMode, OpenNodeHandler, OpenNoteByNameHandler, EditorRevealRequest } from '../types';

// Same reasoning as the drawing canvas: pdf.js + pdf-lib only load once a PDF
// is actually opened.
const PdfPane = lazy(() => import('./PdfPane'));

interface EditorPaneProps {
    /** Every open document, flat. */
    tabs: OpenTab[];
    /** What the tab bar shows, and which of those tabs' panes are on screen. */
    layout: TabLayout;
    theme: Theme;
    /** Spaces a Tab inserts — and how far Tab indents a list item. */
    tabSize: number;
    saveStatus: string;
    onSelectGroup: (id: string) => void;
    onCloseGroup: (id: string) => void;
    onReorderGroups: (id: string, toIndex: number) => void;
    /** Merge a whole tab into the one on screen, as panes starting at `index`. */
    onMergeGroups: (sourceId: string, index: number) => void;
    /** Record a tab's pane widths (percentages summing to 100), or null to put
     *  them back to equal columns. */
    onResizePanes: (id: string, sizes: number[] | null) => void;
    onFocusPane: (path: string) => void;
    onClosePane: (path: string) => void;
    onSplitOffPane: (path: string) => void;
    onToggleMode: (path: string) => void;
    /** Path-explicit: several documents are editable at once, and a canvas's
     *  debounced save can land after its pane has gone away. */
    onContentChange: (path: string, content: string) => void;
    /** Buffer content and write it immediately, skipping the save debounce. */
    onFlushNow: (path: string, content: string) => void;
    /** Start annotating a plain PDF: creates "<name> (annotated).pdf" and opens it. */
    onAnnotatePdf: (file: ActiveFile) => void;
    onOpenNote: OpenNoteByNameHandler;
    /** Say something to the reader in the app's own dialog — App's `tell`,
     *  threaded down to the panes because a right-click menu row that cannot
     *  reach the clipboard has to say so. Stable, or DocumentPane's memo (and
     *  with it every pane's) stops holding. */
    onNotify: (message: string) => void;
    graph: GraphData;
    onOpenNode: OpenNodeHandler;
    /** One-shot select+scroll order from vault search (null = nothing pending). */
    revealRequest: EditorRevealRequest | null;
    onRevealHandled: () => void;
}

/** Inline positioning for the linked-mentions popover (fixed top/right). */
interface PopoverPos {
    top: number;
    right: number;
}

/** Where a dragged tab would land: the insertion index among the panes, plus
 *  the half of which pane to paint while the pointer is there. */
interface DropTarget {
    index: number;
    pane: number;
    side: 'left' | 'right';
}

/**
 * The narrowest a pane may be DRAGGED to, in pixels.
 *
 * A pane header's fixed chrome measures about 78px before its title gets a
 * single character (10px of padding, a 12px icon, two 6px gaps, two 20px
 * buttons, 4px of padding), and a pane narrower than that starts clipping its
 * own name away entirely. 140 leaves room for a word of it as well.
 *
 * A PIXEL floor, and so it lives here rather than in utils/tabGroups.ts, which
 * is pure and never sees one — that module's own floor is about keeping a
 * STORED arrangement sane and is deliberately far below this. It is a gesture
 * constraint only: a window shrunk after a drag simply shows narrower panes,
 * because re-clamping on every resize would rewrite an arrangement the reader
 * made from a window size they were only passing through.
 */
const MIN_PANE_PX = 140;

/** Both sides of the geometry format identically, so React's style diff — which
 *  compares values — writes nothing when a re-render lands mid-drag and the
 *  widths it is holding have not moved. */
const pct = (n: number) => n.toFixed(4);

/* A pane's share of its tab, as a `flex-grow` naming that column's variable.
   Grow against the stylesheet's zero basis, so the browser shares the width out
   by dividing by the sum of the factors: the columns tile the container exactly
   however the percentages rounded, which a percentage basis would leave as a
   seam or an overflow. The fallback of 1 is equal columns.

   ONE FROZEN OBJECT PER COLUMN, not one built per render: this is the prop that
   would otherwise defeat DocumentPane's memo, and a stable identity means a
   pane's props do not change at all while a divider is being dragged. */
const PANE_WIDTH_STYLE: React.CSSProperties[] = Array.from(
    { length: MAX_SPLIT_PANES }, (_, i) => ({ flexGrow: `var(--pane-w-${i}, 1)` }));

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

/** The least a pane may be left holding, as a percentage of the tab. */
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
 * against an equal share of the whole tab: the drag only ever moves these two,
 * and capping by the pane count instead put the floor at a tenth of a five-pane
 * tab — 118px on a 1176px editor, well under the minimum this is here to keep.
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
    groupId: string;
    /** The split's width, read once — the whole gesture is measured in it. */
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
 * The editor half of the workspace: the tab bar, and the panes of whichever tab
 * is on screen.
 *
 * A tab shows one document in the ordinary case and up to five side by side
 * once tabs have been merged (see utils/tabGroups.ts). Each pane is a
 * DocumentPane owning its own CodeMirror view; this component owns what is
 * shared between them — the per-path EditorState cache, the tab bar, the
 * top-bar actions (which act on the focused pane), the image-delete
 * confirmation, and the PDF panes, which are deliberately NOT inside a pane so
 * they can outlive it.
 */
export default function EditorPane({ tabs, layout, theme, tabSize, saveStatus, onSelectGroup, onCloseGroup, onReorderGroups, onMergeGroups, onResizePanes, onFocusPane, onClosePane, onSplitOffPane, onToggleMode, onContentChange, onFlushNow, onAnnotatePdf, onOpenNote, onNotify, graph, onOpenNode, revealRequest, onRevealHandled }: EditorPaneProps) {
    const group = activeGroupOf(layout);
    const byPath = useMemo(() => new Map(tabs.map(t => [t.file.path, t])), [tabs]);

    // The panes on screen and the share of the width each one holds, from ONE
    // walk: a path with no open document has no pane — the two structures'
    // documented failure mode (see utils/tabGroups.ts) — and it has to drop out
    // of both together, or the columns and the dividers stop describing the
    // same panes. What is left is re-shared among them.
    const { paneTabs, widths } = useMemo(() => {
        const panes: OpenTab[] = [];
        const share: number[] = [];
        if (group) {
            const stored = paneSizes(group);
            group.paths.forEach((p, i) => {
                const tab = byPath.get(p);
                if (!tab) return;
                panes.push(tab);
                share.push(stored[i]);
            });
        }
        const sum = share.reduce((a, b) => a + b, 0);
        return { paneTabs: panes, widths: sum > 0 ? share.map(s => (s * 100) / sum) : [] };
    }, [group, byPath]);
    const paneCount = paneTabs.length;

    /** Each pane's left edge, in the same percentages. */
    const edges = useMemo(() => {
        const out: number[] = [];
        let x = 0;
        for (const w of widths) { out.push(x); x += w; }
        return out;
    }, [widths]);

    /** Where each visible document's column is — what the PDF panes, which
     *  float over a slot rather than sitting in it, are placed from. */
    const paneGeom = useMemo(() => {
        const m = new Map<string, { index: number; left: number; width: number }>();
        paneTabs.forEach((t, i) => m.set(t.file.path, { index: i, left: edges[i], width: widths[i] }));
        return m;
    }, [paneTabs, edges, widths]);

    /**
     * The pane geometry, published as CSS variables on this component's root —
     * the one box holding both the columns and the PDF panes floating over
     * them. Everything that has to line up with a column reads them, so a
     * divider drag moves all of it with one write and no render at all.
     *
     * A fresh object per render is the point, not a cost: React writes only the
     * properties whose VALUES changed, so a re-render landing mid-drag (a save
     * status arriving, a keystroke in a neighbouring pane) finds the committed
     * widths unchanged and leaves the gesture's own writes exactly where they
     * are. Both sides format through `pct` so that comparison is on the same
     * strings. Removing a stale variable is React's too — a five-pane tab's
     * leftovers go when a smaller one renders.
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

    const focusedPath = group?.activePath ?? null;
    const focusedTab = focusedPath ? byPath.get(focusedPath) ?? null : null;
    const activeFile: ActiveFile | null = focusedTab?.file ?? null;
    const editorMode: EditorMode = focusedTab?.mode ?? 'read';

    const isDrawing = !!activeFile && !activeFile.isHelp && isDrawingFile(activeFile.name);
    const isPdf = !!activeFile && !activeFile.isHelp && isPdfFile(activeFile.name);
    // Only a file we wrote can be annotated in place; a plain PDF gets an
    // "Annotate" action that spawns its annotated sibling instead.
    const isAnnotatable = isPdf && !!activeFile && isAnnotatedPdf(activeFile.name);
    /** True whenever a non-CodeMirror surface owns the focused pane. */
    const isCanvas = isDrawing || isPdf;

    // ── Per-document editor state ──────────────────────────────────────────
    // Each document's full EditorState (doc + undo history + selection) is
    // cached here by DOCUMENT (OpenTab.id), and adopted by whichever pane shows
    // it next — so undo survives tab switches and being dragged into a split,
    // and can never reach across documents.
    //
    // By id rather than by path, which is the same reason the panes below are
    // keyed by it: a rename that overwrites an open file leaves two different
    // documents answering to one path for a commit, and keyed by path the
    // survivor adopted the loser's text and undo history — then saved it over
    // the file that had just replaced it (see OpenTab.id).
    const [stateCache] = useState(() => new Map<string, EditorState>());

    // ── Linked mentions popover ────────────────────────────────────────────
    const [showBacklinks, setShowBacklinks] = useState(false);
    const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null);
    const backlinksBtnRef = useRef<HTMLButtonElement | null>(null);

    const backlinkNodes = useMemo<GraphNode[]>(
        () => getBacklinkNodes(graph, activeFile?.path),
        [graph, activeFile?.path]
    );

    const closeBacklinks = useCallback(() => setShowBacklinks(false), []);

    const toggleBacklinks = useCallback(() => {
        setShowBacklinks(prev => {
            const next = !prev;
            if (next && backlinksBtnRef.current) {
                const r = backlinksBtnRef.current.getBoundingClientRect();
                setPopoverPos({
                    top: Math.round(r.bottom + 6),
                    right: Math.max(8, Math.round(window.innerWidth - r.right)),
                });
            }
            return next;
        });
    }, []);

    // Dismiss the popover on outside-click, Escape, or window resize.
    useEffect(() => {
        if (!showBacklinks) return;
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('.backlinks-popover') || target.closest('.backlinks-toggle')) return;
            setShowBacklinks(false);
        };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowBacklinks(false); };
        const onResize = () => setShowBacklinks(false);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', onResize);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onResize);
        };
    }, [showBacklinks]);

    // The [[ autocomplete reads targets through this ref so its (created-once)
    // extension always sees the current vault, deduped by link name since
    // wikilinks resolve by name, not path. One stable getter for every pane.
    const graphRef = useRef<GraphData>(graph);
    useEffect(() => { graphRef.current = graph; }, [graph]);
    const [getWikiLinkTargets] = useState(() => () => {
        const seen = new Set<string>();
        const targets: WikiLinkTarget[] = [];
        for (const node of graphRef.current.nodes) {
            const key = node.name.toLowerCase();
            if (!node.name || seen.has(key)) continue;
            seen.add(key);
            targets.push({ name: node.name, unresolved: node.unresolved });
        }
        return targets;
    });

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
    const visibleKey = group ? group.paths.join('\n') : '';
    useEffect(() => {
        const visible = new Set(visibleKey ? visibleKey.split('\n') : []);
        setImageDelete(prev => (prev && visible.has(prev.path) ? prev : null));
    }, [visibleKey]);

    // Drop cached editor states for documents that are no longer open. Keyed on
    // the joined key string so it doesn't run on every keystroke.
    const openTabsKey = tabs.map(paneKey).join('\n');
    useEffect(() => {
        const open = new Set(openTabsKey ? openTabsKey.split('\n') : []);
        for (const key of stateCache.keys()) {
            if (!open.has(key)) stateCache.delete(key);
        }
    }, [openTabsKey, stateCache]);

    // ── Merging a tab into this one ────────────────────────────────────────
    // A tab dragged out of the bar and dropped on the panes below joins them.
    // The drop zone is a layer OVER the panes rather than handlers on them:
    // CodeMirror handles `drop` itself (it would insert the dragged text), and
    // a PDF pane would swallow it entirely. It exists only while a tab is
    // actually in flight, so nothing else is ever intercepted.
    const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
    const [dropAt, setDropAt] = useState<DropTarget | null>(null);
    /** Whether the pointer is actually over the panes. The zone exists for the
     *  whole drag (it has to, to keep CodeMirror off the drop), but what it says
     *  is only about where the pointer IS. */
    const [overZone, setOverZone] = useState(false);

    const endDrag = useCallback(() => {
        setDraggingGroupId(null);
        setDropAt(null);
        setOverZone(false);
    }, []);

    const mergeable = canMergeIntoActive(layout, draggingGroupId);
    /** Dragged onto a tab that can't take it — say why rather than look broken.
     *  Gated on the pointer being over the panes: ungated it announced itself
     *  from the moment the drag started, so merely re-ordering a tab along the
     *  strip raised a message about something the user wasn't doing. */
    const dropFull = overZone && !!draggingGroupId && !!group && draggingGroupId !== group.id && !mergeable;

    const handleDropOver = (e: React.DragEvent<HTMLDivElement>) => {
        setOverZone(true);
        if (!mergeable || paneCount === 0) { setDropAt(null); return; }
        e.preventDefault();                     // without this the drop is refused
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100;
        // Which pane the pointer is in, walked along the real boundaries: the
        // columns are no longer equal, so neither the pane nor its midpoint can
        // be divided out of the width any more.
        let pane = 0;
        while (pane + 1 < paneCount && x >= edges[pane + 1]) pane++;
        // Which half of that pane decides which side of it the new panes land.
        const right = x - edges[pane] > widths[pane] / 2;
        const index = right ? pane + 1 : pane;
        const side = right ? 'right' : 'left';
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
        if (draggingGroupId && dropAt && mergeable) onMergeGroups(draggingGroupId, dropAt.index);
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
    // frame would put a re-render of this component, the tab bar and every
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
     * repainting the row this gesture started from would drag the tab that
     * REPLACED it into a shape nobody chose.
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
        if (commit) onResizePanes(drag.groupId, drag.live);
        else if (restore) writePaneVars(drag.start);
    }, [onResizePanes, writePaneVars]);

    /** Ends a gesture whose own pointer never will. */
    const endsGesture = (e: React.PointerEvent<HTMLSpanElement>) =>
        e.pointerId === resizeRef.current?.pointerId;

    // The whole editor going away — ⌘ to the Neural Brain view — must not leave
    // the window stuck on a col-resize cursor with text selection off.
    useEffect(() => () => { if (resizeRef.current) endResize(false); }, [endResize]);

    /**
     * ...and neither must the divider going away UNDER the gesture.
     *
     * Every exit from the drag is a React handler on the handle, and React
     * delegates at the root: a handle removed from the document while it still
     * holds the capture gets its implicit `lostpointercapture` at a detached
     * node, which reaches no listener. Nothing would then release the body
     * class, the Escape listener, or startResize's own guard — dividers would
     * be dead and the whole app stuck on `col-resize` for the rest of the
     * session. ⌘N is enough to do it: `prompt()` for a name, and the new tab
     * takes the screen with a single pane.
     *
     * The same test covers the drag's premises moving without the handle going
     * anywhere (a pane closing beside it), since `start` describes a pane list
     * that no longer exists either way.
     */
    useEffect(() => {
        const drag = resizeRef.current;
        if (drag && (drag.groupId !== group?.id || drag.start.length !== paneCount)) {
            endResize(false, false);
        }
    }, [group?.id, paneCount, endResize]);

    const startResize = (e: React.PointerEvent<HTMLSpanElement>, edge: number) => {
        if (e.button !== 0 || !e.isPrimary || !group || resizeRef.current) return;
        // A tab holding a path with no open document draws fewer columns than it
        // has panes — the two structures' documented failure mode — and a row
        // that short is one setGroupSizes would decline, leaving the gesture to
        // move the columns and then silently not be recorded. Refuse it instead.
        if (widths.length !== group.paths.length) return;
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
            handle, pointerId: e.pointerId, edge, groupId: group.id, total,
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
        if (!group || widths.length !== group.paths.length) return;   // see startResize
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
        onResizePanes(group.id, next);
    };

    return (
        <div className="editor-pane" ref={paneRootRef} style={splitVars}>
            <div className="view-header">
                <TabBar
                    tabs={tabs}
                    groups={layout.groups}
                    activeGroupId={layout.activeId}
                    draggingGroupId={draggingGroupId}
                    onSelectGroup={onSelectGroup}
                    onCloseGroup={onCloseGroup}
                    onReorderGroups={onReorderGroups}
                    onDragStart={setDraggingGroupId}
                    onDragEnd={endDrag}
                />
                {saveStatus && <span className="save-status">{saveStatus}</span>}
                {/* A plain PDF can't hold annotations, so this spawns its
                    annotated sibling and switches to it. On an annotated file the
                    View/Annotate toggle below takes over instead. */}
                {isPdf && !isAnnotatable && activeFile && (
                    <button
                        className="view-header-action"
                        onClick={() => onAnnotatePdf(activeFile)}
                        title="Annotate — creates a copy with “(annotated)” in the name"
                        aria-label="Annotate this PDF"
                    >
                        <PenTool size={15} />
                    </button>
                )}
                {/* An annotated PDF reuses the per-tab mode: read = view the real
                    PDF (text selectable), edit = draw on it. */}
                {isAnnotatable && activeFile && (
                    <button
                        className="view-header-action"
                        onClick={() => onToggleMode(activeFile.path)}
                        title={editorMode === 'read' ? 'Viewing — switch to annotating (⌘E)' : 'Annotating — switch to viewing (⌘E)'}
                        aria-label="Toggle view/annotate mode"
                    >
                        {editorMode === 'read' ? <PenTool size={15} /> : <Eye size={15} />}
                    </button>
                )}
                {/* Read/edit and linked-mentions are markdown concepts — a canvas has neither. */}
                {activeFile && !activeFile.isHelp && !isCanvas && (
                    <>
                        <button
                            className="view-header-action"
                            onClick={() => onToggleMode(activeFile.path)}
                            title={editorMode === 'read' ? 'Reading — switch to edit (⌘E)' : 'Editing — switch to reading (⌘E)'}
                            aria-label="Toggle read/edit mode"
                        >
                            {editorMode === 'read' ? <Eye size={15} /> : <Edit2 size={15} />}
                        </button>
                        <button
                            ref={backlinksBtnRef}
                            className={`view-header-action backlinks-toggle${showBacklinks ? ' active' : ''}`}
                            onClick={toggleBacklinks}
                            title="Linked mentions"
                            aria-label="Linked mentions"
                            aria-expanded={showBacklinks}
                        >
                            <Link size={15} />
                            {backlinkNodes.length > 0 && (
                                <span className="view-header-action-count">{backlinkNodes.length}</span>
                            )}
                        </button>
                    </>
                )}
            </div>

            {/* The panes of the tab on screen: columns, left to right, as wide
                as the reader left them (even until a divider is dragged). */}
            <div className="editor-split" ref={splitRef}>
                {paneTabs.map((tab, i) => (
                    <DocumentPane
                        key={paneKey(tab)}
                        stateKey={paneKey(tab)}
                        tab={tab}
                        isFocused={tab.file.path === focusedPath}
                        showHeader={paneCount > 1}
                        widthStyle={paneCount > 1 ? PANE_WIDTH_STYLE[i] : undefined}
                        theme={theme}
                        tabSize={tabSize}
                        stateCache={stateCache}
                        getWikiLinkTargets={getWikiLinkTargets}
                        onContentChange={onContentChange}
                        onFocusPane={onFocusPane}
                        onClosePane={onClosePane}
                        onSplitOffPane={onSplitOffPane}
                        onOpenNote={onOpenNote}
                        onImageDelete={handleImageDelete}
                        onNotify={onNotify}
                        revealRequest={revealRequest}
                        onRevealHandled={onRevealHandled}
                    />
                ))}
                {/* Drawn over the panes rather than as a border on them (a PDF
                    pane floats above its slot and would otherwise cover it) —
                    and it is the handle that moves the boundary. Keyed by the
                    pane on its right, so a boundary's DOM stays with the
                    document it runs alongside rather than with an index a
                    merge or a close can shift under it — which is what keeps
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
                        aria-label={`Resize ${paneTabs[i].file.name} and ${right.file.name}`}
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
                        onDoubleClick={() => group && onResizePanes(group.id, null)}
                        // Now that this strip takes pointer events it is also a
                        // drop target, and a file dropped from the desktop on an
                        // uncancelled one navigates the whole app away to it.
                        // It used to fall through to .view-content, which
                        // cancels its own.
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => e.preventDefault()}
                    />
                ))}
                {draggingGroupId && group && paneCount > 0 && (
                    <div
                        className="editor-split-dropzone"
                        onDragEnter={handleDropOver}
                        onDragOver={handleDropOver}
                        onDragLeave={handleDropLeave}
                        onDrop={handleDrop}
                    >
                        {/* The half of the pane the tab would land beside —
                            that pane's own half, since the columns can differ.
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
                                One tab holds up to {MAX_SPLIT_PANES} panes
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* One pane per OPEN PDF tab — kept mounted and merely hidden while
                off screen, so switching tabs never reloads the document or loses
                the reading position. That is why they live out here rather than
                inside a DocumentPane, which exists only while its tab is shown;
                each is positioned over the slot its document occupies. Panes
                defer their disk/pdf.js work until first shown. */}
            {tabs.filter(t => !t.file.isHelp && isPdfFile(t.file.name)).map(tab => {
                // From the RENDERED panes, not the group's paths: a path with no
                // open document draws no pane, and its column is not there to
                // stand in.
                const slot = paneGeom.get(tab.file.path);
                const visible = !!slot;
                const split = visible && paneCount > 1;
                // The placeholder has to stand in the SAME column as the pane it
                // is standing in for: bare `.pdf-pane` is full width and sits
                // above the pane headers, so on the restore path — the one that
                // can put a PDF straight into a split — it covered the notes
                // beside it until the lazy chunk arrived. Through the same
                // variables as the pane itself, so it lines up even mid-drag.
                const fallbackStyle = split
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
                            <div
                                className={`pdf-pane pdf-pane-message${split ? ' pdf-pane-split' : ''}`}
                                style={fallbackStyle}
                            >
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
                            isSplit={split}
                            onFocusPane={onFocusPane}
                            mode={tab.mode}
                            content={tab.content}
                            onContentChange={onContentChange}
                            onFlushNow={onFlushNow}
                            theme={theme}
                            isDirty={tab.dirty}
                        />
                    </Suspense>
                );
            })}

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
            {showBacklinks && activeFile && !activeFile.isHelp && (
                <BacklinksPanel
                    nodes={backlinkNodes}
                    onOpenNode={onOpenNode}
                    onClose={closeBacklinks}
                    style={popoverPos ? { position: 'fixed', top: popoverPos.top, right: popoverPos.right } : undefined}
                />
            )}
        </div>
    );
}
