import React, { useEffect, useRef, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import type { EditorState } from '@codemirror/state';
import BacklinksPanel from './BacklinksPanel';
import DocumentPane from './DocumentPane';
import type { PaneImageDelete } from './DocumentPane';
import TabBar from './TabBar';
import { Link, Eye, Edit2, PenTool } from './icons';
import { getBacklinkNodes } from '../utils/graph';
import { isPdfFile, isAnnotatedPdf, isDrawingFile } from '../utils/fileTypes';
import { activeGroup as activeGroupOf, canMergeIntoActive, MAX_SPLIT_PANES } from '../utils/tabGroups';
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
export default function EditorPane({ tabs, layout, theme, tabSize, saveStatus, onSelectGroup, onCloseGroup, onReorderGroups, onMergeGroups, onFocusPane, onClosePane, onSplitOffPane, onToggleMode, onContentChange, onFlushNow, onAnnotatePdf, onOpenNote, graph, onOpenNode, revealRequest, onRevealHandled }: EditorPaneProps) {
    const group = activeGroupOf(layout);
    const byPath = useMemo(() => new Map(tabs.map(t => [t.file.path, t])), [tabs]);
    const paneTabs = useMemo(
        () => (group ? group.paths.map(p => byPath.get(p)).filter((t): t is OpenTab => !!t) : []),
        [group, byPath]
    );
    const paneCount = paneTabs.length;

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
    // cached here by PATH, and adopted by whichever pane shows it next — so
    // undo survives tab switches and being dragged into a split, and can never
    // reach across documents. Sound because a path is open at most once, and so
    // can be in at most one pane at a time.
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

    // Escape cancels, wherever focus happens to be.
    useEffect(() => {
        if (!imageDelete) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); setImageDelete(null); }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [imageDelete]);

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
    // the joined path string so it doesn't run on every keystroke.
    const openTabsKey = tabs.map(t => t.file.path).join('\n');
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
        const paneWidth = r.width / paneCount;
        const x = e.clientX - r.left;
        const pane = Math.max(0, Math.min(paneCount - 1, Math.floor(x / paneWidth)));
        // Which half of that pane decides which side of it the new panes land.
        const right = x - pane * paneWidth > paneWidth / 2;
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

    return (
        <div className="editor-pane">
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

            {/* The panes of the tab on screen: equal columns, left to right. */}
            <div className="editor-split">
                {paneTabs.map(tab => (
                    <DocumentPane
                        key={tab.file.path}
                        tab={tab}
                        isFocused={tab.file.path === focusedPath}
                        showHeader={paneCount > 1}
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
                        revealRequest={revealRequest}
                        onRevealHandled={onRevealHandled}
                    />
                ))}
                {/* Drawn over the panes rather than as a border on them: a PDF
                    pane floats above its slot and would otherwise cover it. */}
                {Array.from({ length: Math.max(0, paneCount - 1) }, (_, i) => (
                    <span
                        key={i}
                        className="editor-split-divider"
                        style={{ left: `${((i + 1) * 100) / paneCount}%` }}
                        aria-hidden="true"
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
                        {dropAt && (
                            <div
                                className="editor-split-drop-target"
                                style={{
                                    left: `${((dropAt.pane + (dropAt.side === 'right' ? 0.5 : 0)) * 100) / paneCount}%`,
                                    width: `${50 / paneCount}%`,
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
                const slot = group ? group.paths.indexOf(tab.file.path) : -1;
                const visible = slot >= 0;
                // The placeholder has to stand in the SAME column as the pane it
                // is standing in for: bare `.pdf-pane` is full width and sits
                // above the pane headers, so on the restore path — the one that
                // can put a PDF straight into a split — it covered the notes
                // beside it until the lazy chunk arrived.
                const fallbackStyle = visible && paneCount > 1
                    ? { left: `${(slot * 100) / paneCount}%`, width: `${100 / paneCount}%`, right: 'auto' as const }
                    : undefined;
                return (
                    <Suspense
                        key={tab.file.path}
                        fallback={visible ? (
                            <div
                                className={`pdf-pane pdf-pane-message${paneCount > 1 ? ' pdf-pane-split' : ''}`}
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
                            slotIndex={visible ? slot : 0}
                            slotCount={visible ? paneCount : 1}
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
                <div className="confirm-overlay" onMouseDown={closeImageDelete}>
                    <div
                        className="confirm-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="confirm-image-delete"
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <h3 className="confirm-title" id="confirm-image-delete">Delete image?</h3>
                        <p className="confirm-body">
                            <strong>{imageDelete.name}</strong> is removed from this note, and its file moves
                            to this folder’s <code>.Garbage</code> unless another note here still shows it.
                            Undo (⌘Z) brings both back.
                        </p>
                        <div className="confirm-actions">
                            <button className="confirm-btn" onClick={closeImageDelete}>Cancel</button>
                            <button className="confirm-btn confirm-btn-danger" onClick={runImageDelete} autoFocus>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
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
