import React, { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import TreeNode from './TreeNode';
import {
    peekDraggedNode, setTreeDropTarget, setTreeReorderMode, takeDraggedNode, type TreeDropPosition,
} from '../utils/treeDrag';
import { indexTree, planTreeDrop, type TreeDropPlan, type TreeDropSpot, type TreeIndex } from '../utils/treeReorder';
import { getEntryOrder, subscribeEntryStyles } from '../utils/entryStyleStore';
import { isTabDrag } from '../utils/tabDrag';
import { openContextMenu } from '../utils/contextMenu';
import type { ContextMenuEntry } from '../utils/contextMenu';
import SearchPanel from './SearchPanel';
import {
    ArrowUpNarrowWide, ChevronsDownUp, ChevronsUpDown, FolderClosed, FolderPlus, GalleryVertical,
    PenTool, Search, SidebarLeft, SquarePen,
} from './icons';
import {
    ancestorsOf, clearCreateRequest, getCreateKindFor, nameForKind, placeholderFor,
    requestCreate, subscribeCreateRequest, type CreateKind,
} from '../utils/createRequest';
import { getActiveFilePath, subscribeActiveFile } from '../utils/activeFile';
import { collectFiles } from '../utils/tree';
import { createSortCache, isTimeSort, sortTree, TREE_SORT_ORDERS, type TreeSortOrder } from '../utils/treeSort';
import { getFileTimes, getFileTimesVersion, statFileTimes, subscribeFileTimes } from '../utils/fileTimes';
import { readJSON, writeJSON } from '../utils/storage';
import { createVaultTextCache } from '../utils/vaultSearch';
import type { VaultTextCache } from '../utils/vaultSearch';
import type { FileTreeNode, FileTreeFileNode, TextRange } from '../types';
import { orderListFor, type EntryOrder, type IconNode } from '../utils/entryStyle';

/**
 * True when the drag carries OS files rather than a tree node being moved.
 * `types` is readable during dragover (where `files` is deliberately empty for
 * privacy), so it's the only reliable signal at that point.
 */
function isExternalFileDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes('Files');
}

/** The sort menu's rows, in Obsidian's wording and order (image 8). Its two
 *  "Created time" rows are left out on purpose: the File System Access API
 *  exposes no creation time at all, so they could only lie. Custom is ours —
 *  Obsidian has none — the user's own drag-arranged order, in its own group
 *  at the bottom (the menu below slices this list by position). */
const SORT_ROWS: { id: TreeSortOrder; label: string }[] = [
    { id: 'name-asc', label: 'File name (A to Z)' },
    { id: 'name-desc', label: 'File name (Z to A)' },
    { id: 'mtime-desc', label: 'Modified time (new to old)' },
    { id: 'mtime-asc', label: 'Modified time (old to new)' },
    { id: 'custom', label: 'Custom' },
];

/** The order snapshot while Custom is NOT chosen: constant, so an order or icon
 *  change never re-renders the explorer of someone sorting another way. */
const NO_ORDER: EntryOrder = Object.freeze({}) as EntryOrder;

/** localStorage is user-editable: anything but a known order reads as the default. */
function readSortOrder(): TreeSortOrder {
    const stored = readJSON<unknown>('fileTreeSortOrder', 'name-asc');
    return TREE_SORT_ORDERS.includes(stored as TreeSortOrder) ? stored as TreeSortOrder : 'name-asc';
}

/** How many frames auto-reveal waits for a row the expand it just asked for
 *  to mount, before giving up (a file filtered out of the tree never will). */
const REVEAL_FRAMES = 10;

interface FileExplorerProps {
    rootHandle: FileSystemDirectoryHandle | null;
    fileTree: FileTreeNode[];
    onFileClick: (node: FileTreeNode) => void;
    onCreateFile: (parentHandle: FileSystemDirectoryHandle | null, name: string, parentPath?: string) => void | Promise<void>;
    onCreateFolder: (parentHandle: FileSystemDirectoryHandle | null, name: string) => void | Promise<void>;
    onCollapse: () => void;
    /** Whether the search panel replaces the tree — the Search tab is on, as
     *  opposed to Files. Owned by App; both toggles below are stable. */
    searchOpen: boolean;
    onOpenSearch: () => void;
    onCloseSearch: () => void;
    onTrash: (node: FileTreeNode) => void;
    /** Open a folder row as the vault. Directories only — App ignores the rest. */
    onOpenAsVault: (node: FileTreeNode) => void | Promise<void>;
    /** Give a folder an icon and colour, or clear them. Stable for the app's
     *  life: this component is memoized and TreeNode is too. */
    onStyleEntry: (path: string, icon: string | undefined, color: string | undefined, nodes?: IconNode[]) => void;
    expandedPaths: Set<string>;
    onToggleExpand: (path: string) => void;
    /** Open all of these folders in one update (Expand all, auto-reveal). */
    onExpandPaths: (paths: string[]) => void;
    /** Close all of these folders in one update (Collapse all). */
    onCollapsePaths: (paths: string[]) => void;
    onMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
    /** Store one folder's custom order (`null` forgets it). Stable per vault,
     *  like onStyleEntry: this component is memoized. */
    onSetTreeOrder: (folderPath: string, names: readonly string[] | null) => void;
    onRenameFile: (node: FileTreeNode, newName: string) => unknown;
    /** Copy files dragged in from the OS into `targetDir`. */
    onImportFiles: (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => Promise<string[]>;
    onOpenSearchResult: (node: FileTreeFileNode, range: TextRange | null) => void;
    getOpenTabContent: (path: string) => string | null;
}

function FileExplorer({
    rootHandle,
    fileTree,
    onFileClick,
    onCreateFile,
    onCreateFolder,
    onCollapse,
    searchOpen,
    onOpenSearch,
    onCloseSearch,
    onTrash,
    onOpenAsVault,
    onStyleEntry,
    expandedPaths,
    onToggleExpand,
    onExpandPaths,
    onCollapsePaths,
    onMoveFile,
    onSetTreeOrder,
    onRenameFile,
    onImportFiles,
    onOpenSearchResult,
    getOpenTabContent,
}: FileExplorerProps) {
    /* The name box at the vault ROOT. Driven by the same store the tree rows
       use, so the header's buttons can open it either here or inside a folder
       without two implementations of one control. */
    const creatingInRoot = useSyncExternalStore(
        subscribeCreateRequest,
        useCallback(() => getCreateKindFor(''), []),
    );
    const [rootDragOver, setRootDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const treeRef = useRef<HTMLDivElement | null>(null);

    /** Which of the action row's dropdowns is open, for its pressed look. Set
     *  only AFTER openContextMenu reports the menu open, and cleared by the
     *  menu's onClose — which also runs when another menu replaces it. */
    const [openMenu, setOpenMenu] = useState<'create' | 'sort' | null>(null);
    const clearOpenMenu = useCallback(() => setOpenMenu(null), []);

    // ── View preferences (global, like expandedPaths) ───────────────────────
    const [sortOrder, setSortOrder] = useState<TreeSortOrder>(readSortOrder);
    useEffect(() => { writeJSON('fileTreeSortOrder', sortOrder); }, [sortOrder]);
    // Hands a dragged tree node's drop to the container's handlers below
    // instead of the folder rows' (TreeNode reads it at event time).
    const reordering = sortOrder === 'custom';
    useEffect(() => {
        setTreeReorderMode(reordering);
        return () => setTreeReorderMode(false);
    }, [reordering]);

    const [autoReveal, setAutoReveal] = useState<boolean>(() => readJSON<unknown>('fileTreeAutoReveal', false) === true);
    useEffect(() => { writeJSON('fileTreeAutoReveal', autoReveal); }, [autoReveal]);

    // ── Sorted display tree ─────────────────────────────────────────────────
    /* The canonical tree stays in buildFileTree's order (folders first, A→Z) —
       graph, search and every collectFiles caller read it. What the rows show
       is a display copy, structurally shared (utils/treeSort.ts) so a re-sort
       that moves one file re-renders only the folders on its way.

       The file times are an external store, and this subscribes to them ONLY
       while a time order is chosen: the snapshot is a constant 0 otherwise, so
       a save's stamp (App.flushTab → recordFileWritten) never re-renders the
       explorer of a user sorting by name. The custom order is subscribed the
       same way, only while Custom is chosen: `.appearance.json` also changes
       with every icon pick. */
    const sortCacheRef = useRef(createSortCache());
    const timesVersion = useSyncExternalStore(
        subscribeFileTimes,
        useCallback(() => (isTimeSort(sortOrder) ? getFileTimesVersion() : 0), [sortOrder]),
    );
    const customOrder = useSyncExternalStore(
        subscribeEntryStyles,
        useCallback(() => (reordering ? getEntryOrder() : NO_ORDER), [reordering]),
    );
    const displayTree = useMemo(() => {
        void timesVersion; // the times map is mutable; its version is the dependency
        return sortTree(fileTree, sortOrder, getFileTimes(), sortCacheRef.current, customOrder);
    }, [fileTree, sortOrder, timesVersion, customOrder]);

    /** What a Custom-order drag measures against — only built under Custom, and
     *  once per display tree, not per `dragover`. */
    const dropIndex = useMemo<TreeIndex | null>(
        () => (reordering ? indexTree(displayTree) : null),
        [reordering, displayTree],
    );

    /* Stat every file while a time order is chosen, re-run whenever the tree
       changes shape (a refresh hands out new handles, and a moved file is a new
       file on disk). Never per keystroke: saves stamp their own path instead.
       The cleanup discards a walk the tree or the order has since outdated. */
    useEffect(() => {
        if (!isTimeSort(sortOrder)) return;
        let current = true;
        void statFileTimes(collectFiles(fileTree), () => current);
        return () => { current = false; };
    }, [fileTree, sortOrder]);

    // ── Expand all / Collapse all ───────────────────────────────────────────
    /** Every folder in the tree — the REAL ones, so a stale expandedPaths
     *  entry (a folder since deleted) cannot hold the toggle on Collapse. */
    const folderPaths = useMemo(() => {
        const paths: string[] = [];
        const walk = (nodes: FileTreeNode[]) => {
            for (const node of nodes) {
                if (node.kind === 'directory') { paths.push(node.path); walk(node.children); }
            }
        };
        walk(fileTree);
        return paths;
    }, [fileTree]);
    const anyExpanded = useMemo(
        () => folderPaths.some(p => expandedPaths.has(p)),
        [folderPaths, expandedPaths],
    );

    // ── Auto-reveal ─────────────────────────────────────────────────────────
    const filePathSet = useMemo(() => new Set(collectFiles(fileTree).map(f => f.path)), [fileTree]);
    /** The last path revealed. A tree refresh re-runs the effect below, and
     *  without this every create or rename elsewhere would re-open and scroll
     *  back to the active file — undoing a folder the user had just closed. */
    const revealedRef = useRef<string | null>(null);
    useEffect(() => { revealedRef.current = null; }, [autoReveal, searchOpen]);
    /* Subscribed inside an effect, not through useSyncExternalStore: a tab
       switch then costs this component nothing unless it actually reveals —
       the row highlight already rides each row's own boolean subscription. */
    useEffect(() => {
        if (!autoReveal || searchOpen) return;
        let frame = 0;
        const reveal = () => {
            const path = getActiveFilePath();
            // The Help tab's bare pseudo-path, and anything not in the tree yet
            // (a file just created — the refresh that brings it re-runs this).
            if (!path || !filePathSet.has(path) || path === revealedRef.current) return;
            revealedRef.current = path;
            const slash = path.lastIndexOf('/');
            if (slash !== -1) onExpandPaths(ancestorsOf(path.slice(0, slash)));
            // The expand has not committed yet, so the row may not exist until
            // a frame or two later.
            let tries = 0;
            cancelAnimationFrame(frame);
            const scroll = () => {
                const row = treeRef.current?.querySelector(`.tree-file[data-path="${CSS.escape(path)}"]`);
                if (row) { row.scrollIntoView({ block: 'nearest' }); return; }
                if (++tries < REVEAL_FRAMES) frame = requestAnimationFrame(scroll);
            };
            frame = requestAnimationFrame(scroll);
        };
        reveal();
        const unsubscribe = subscribeActiveFile(reveal);
        return () => { unsubscribe(); cancelAnimationFrame(frame); };
    }, [autoReveal, searchOpen, filePathSet, onExpandPaths]);

    // The indexed vault text lives here (not in SearchPanel) so reopening
    // search doesn't re-read unchanged files.
    const searchCacheRef = useRef<VaultTextCache | null>(null);
    const searchCache = (searchCacheRef.current ??= createVaultTextCache());

    // A different vault may reuse paths — never serve the old vault's text.
    useEffect(() => {
        searchCache.clear();
    }, [searchCache, rootHandle]);

    useEffect(() => {
        if (creatingInRoot && inputRef.current) {
            inputRef.current.focus();
        }
    }, [creatingInRoot]);

    /**
     * Where the header's New-something buttons put things.
     *
     * THE FOLDER OF THE FILE YOU HAVE OPEN, not the vault root. Making a note
     * while reading one almost always means making it next to that one, and
     * having it land at the root instead means moving it by hand every time.
     * With nothing open — or a file whose folder cannot be resolved — the root
     * is still the answer.
     */
    const createTarget = () => {
        // Read at CLICK time rather than memoized per render: as a memo this
        // re-ran on every tab switch, which meant subscribing the explorer to
        // the active file for a value only a button press ever looks at.
        const active = getActiveFilePath();
        if (!active) return '';
        const node = collectFiles(fileTree).find(f => f.path === active);
        if (!node) return '';
        const slash = node.path.lastIndexOf('/');
        return slash === -1 ? '' : node.path.slice(0, slash);
    };

    /** Open the inline "new file/folder" name box in `createTarget`, leaving
     *  search mode if needed (the box lives in the tree view, which search
     *  temporarily replaces). */
    const startCreateInRoot = (kind: CreateKind) => {
        onCloseSearch();
        const target = createTarget();
        // Every folder on the way down has to be open, or the row that renders
        // the box is not mounted to see the request. One update for the lot.
        onExpandPaths(ancestorsOf(target));
        requestCreate(target, kind);
    };

    /** Hung off the button's bottom-left corner, like the tab strip's ⌄, and
     *  `anchor`ed so a second press on the same button closes it. */
    const raiseMenu = (
        e: React.MouseEvent<HTMLButtonElement>,
        which: 'create' | 'sort',
        label: string,
        entries: ContextMenuEntry[],
    ) => {
        const button = e.currentTarget;
        const r = button.getBoundingClientRect();
        const opened = openContextMenu({
            x: Math.round(r.left),
            y: Math.round(r.bottom + 4),
            label,
            opener: button,
            anchor: button,
            onClose: clearOpenMenu,
            entries,
        });
        if (opened) setOpenMenu(which);
    };

    const openCreateMenu = (e: React.MouseEvent<HTMLButtonElement>) => raiseMenu(e, 'create', 'New drawing or notebook', [
        // The user's own wording and order.
        { kind: 'command', id: 'new-drawing', label: 'New Drawing', run: () => startCreateInRoot('drawing') },
        { kind: 'command', id: 'new-notebook', label: 'New Notebook', run: () => startCreateInRoot('notebook') },
    ]);

    const sortEntry = (row: { id: TreeSortOrder; label: string }): ContextMenuEntry => ({
        kind: 'command', id: row.id, label: row.label,
        checked: sortOrder === row.id,
        run: () => setSortOrder(row.id),
    });

    const openSortMenu = (e: React.MouseEvent<HTMLButtonElement>) => raiseMenu(e, 'sort', 'Sort order', [
        ...SORT_ROWS.slice(0, 2).map(row => sortEntry(row)),
        { kind: 'separator', id: 'sep-sort' },
        ...SORT_ROWS.slice(2, 4).map(row => sortEntry(row)),
        { kind: 'separator', id: 'sep-custom' },
        ...SORT_ROWS.slice(4).map(row => sortEntry(row)),
    ]);

    const handleSearchResult = (node: FileTreeFileNode, range: TextRange | null) => {
        onOpenSearchResult(node, range);
        onCloseSearch();      // picking a result returns the sidebar to the tree
    };

    const handleRootCreate = async (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            const name = (e.target as HTMLInputElement).value.trim();
            if (!name) {
                clearCreateRequest();
                return;
            }
            if (creatingInRoot === 'notebook' || creatingInRoot === 'drawing') {
                // Empty on disk until the first stroke: a notebook created and
                // never written in still opens as a blank one-page notebook,
                // exactly as a drawing opens as a blank canvas.
                await onCreateFile(rootHandle, nameForKind(creatingInRoot, name), '');
            } else if (creatingInRoot === 'file') {
                await onCreateFile(rootHandle, name, '');
            } else {
                await onCreateFolder(rootHandle, name);
            }
            clearCreateRequest();
        } else if (e.key === 'Escape') {
            // Handled: `dismissOnEscape` surfaces skip a prevented Escape, so
            // one press closes only this (#36).
            e.preventDefault();
            clearCreateRequest();
        }
    };

    const handleRootCreateBlur = () => {
        clearCreateRequest();
    };

    /**
     * The app's own menu for the empty tree area — the vault root.
     *
     * A right-click on a row raises that row's own menu and stops propagating,
     * so in principle this never sees one. It checks anyway: either mechanism
     * alone is one refactor away from silently raising two menus, and the cost
     * of the check is a `closest` call on a right-click. Returning WITHOUT
     * preventing is deliberate on that path — for a row we want the row's menu,
     * and for the inline input row (which also carries `.tree-item`) we want the
     * browser's own, because a text field wants its native Paste.
     *
     * `openContextMenu` is imported rather than passed in, so FileExplorerProps
     * — every entry of which is referentially stable across a keystroke — is
     * untouched and the memo below still holds.
     */
    const handleRootContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('.tree-item')) return;
        e.preventDefault();
        const container = e.currentTarget;
        // Present-and-disabled with the reason stated, never absent: a row that
        // does nothing and says nothing is indistinguishable from a broken one
        // (VaultMenu.messageFor states the rule for the vault list).
        const noVault = rootHandle ? undefined : 'Open a vault first';
        const entries: ContextMenuEntry[] = [
            {
                kind: 'command', id: 'new-note', label: 'New note',
                disabled: !rootHandle, reason: noVault,
                run: () => startCreateInRoot('file'),
            },
            {
                kind: 'command', id: 'new-folder', label: 'New folder',
                disabled: !rootHandle, reason: noVault,
                run: () => startCreateInRoot('folder'),
            },
        ];
        openContextMenu({
            x: e.clientX,
            y: e.clientY,
            entries,
            label: 'Vault actions',
            opener: container,
        });
    };

    // ── Custom order: placing a dragged tree node ──────────────────────────
    /**
     * Under Custom, EVERY drop of a tree node is decided here, from the row
     * under the pointer and where on it the pointer sits: the top or bottom
     * half of a file means before or after it; a folder splits in quarters —
     * top before it, middle into it (appended), bottom after it, or, when it is
     * open with children, first inside it, since the line under an open
     * folder's header is visually its first child's slot. Below every row is the
     * end of the vault root. Null when the drag is not a Custom reorder at all
     * (OS files, editor tabs, another order), which leaves today's paths alone.
     */
    const resolveReorder = (e: React.DragEvent<HTMLDivElement>): { path: string | null; spot: TreeDropSpot; plan: TreeDropPlan | null } | null => {
        if (!dropIndex || isTabDrag(e.dataTransfer)) return null;
        const dragged = peekDraggedNode();
        if (!dragged) return null;

        const row = (e.target as Element).closest('.tree-item[data-path]');
        const node = row && e.currentTarget.contains(row)
            ? dropIndex.byPath.get((row as HTMLElement).dataset.path!)
            : undefined;
        if (!row || !node) {
            return { path: null, spot: 'root-end', plan: planTreeDrop(dropIndex, dragged, null, 'root-end') };
        }

        const rect = row.getBoundingClientRect();
        const y = (e.clientY - rect.top) / rect.height;
        let spot: TreeDropPosition;
        if (node.kind === 'file') spot = y < 0.5 ? 'before' : 'after';
        else if (y < 0.25) spot = 'before';
        else if (y < 0.75) spot = 'into';
        else spot = expandedPaths.has(node.path) && node.children.length > 0 ? 'first-child' : 'after';
        return { path: node.path, spot, plan: planTreeDrop(dropIndex, dragged, node.path, spot) };
    };

    const clearReorderTarget = () => {
        setTreeDropTarget(null);
        setRootDragOver(false);
    };

    /** The folder handle a plan's destination resolves to. */
    const handleForFolder = (folderPath: string): FileSystemDirectoryHandle | null => {
        if (!folderPath) return rootHandle;
        const node = dropIndex?.byPath.get(folderPath);
        return node?.kind === 'directory' ? node.handle : null;
    };

    const dropReorder = async (plan: TreeDropPlan) => {
        const dragged = takeDraggedNode();
        if (!dragged) return;
        if (!plan.move) {
            onSetTreeOrder(plan.parentPath, plan.names);
            return;
        }
        const target = handleForFolder(plan.parentPath);
        if (!target) return;
        // The destination's order is written BEFORE the move, so the tree
        // refresh the move ends in already shows the node in its slot rather
        // than at the folder's end for a frame. The move's own re-key
        // (App.retargetTabs → renameEntry) takes it out of the old folder's list.
        const previous = orderListFor(getEntryOrder(), plan.parentPath) ?? null;
        onSetTreeOrder(plan.parentPath, plan.names);
        const moved = await onMoveFile(dragged, target, plan.parentPath);
        if (!moved) onSetTreeOrder(plan.parentPath, previous);
    };

    // Root-level drop handlers — use a counter to reliably track enter/leave
    const dragCounterRef = useRef(0);

    const handleRootDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        // An editor tab on its way to the split view has no meaning here (see
        // utils/tabDrag.ts) — leave the container inert rather than inviting a
        // drop it would silently ignore.
        if (isTabDrag(e.dataTransfer)) return;
        e.preventDefault();
        // A Custom reorder draws its own target on every dragover instead.
        if (reordering && peekDraggedNode()) return;
        dragCounterRef.current++;
        setRootDragOver(true);
    };

    const handleRootDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (isTabDrag(e.dataTransfer)) return;
        e.preventDefault();
        const reorder = resolveReorder(e);
        if (reorder) {
            const { path, spot, plan } = reorder;
            setTreeDropTarget(plan && path !== null && spot !== 'root-end' ? { path, position: spot } : null);
            setRootDragOver(!!plan && spot === 'root-end');
            e.dataTransfer.dropEffect = plan ? 'move' : 'none';
            return;
        }
        // Files dragged from the OS are copied in, not moved out of the vault —
        // showing 'move' would promise Explorer we're removing their original.
        e.dataTransfer.dropEffect = isExternalFileDrag(e) ? 'copy' : 'move';
    };

    const handleRootDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        if (reordering && peekDraggedNode()) {
            // Only leaving the container clears it; row-to-row crossings are
            // the next dragover's to redraw.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clearReorderTarget();
            return;
        }
        dragCounterRef.current--;
        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setRootDragOver(false);
        }
    };

    const handleRootDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const reorder = isExternalFileDrag(e) ? null : resolveReorder(e);
        if (reorder) {
            clearReorderTarget();
            if (reorder.plan) await dropReorder(reorder.plan);
            else takeDraggedNode();
            return;
        }
        dragCounterRef.current = 0;
        setRootDragOver(false);

        // Dragged in from the OS (Explorer/Finder) — copy into the vault root.
        if (isExternalFileDrag(e) && e.dataTransfer.files?.length && rootHandle) {
            await onImportFiles(e.dataTransfer.files, rootHandle);
            return;
        }

        const draggedNode = takeDraggedNode();
        if (!draggedNode || !rootHandle) return;
        if (onMoveFile) {
            await onMoveFile(draggedNode, rootHandle, '');
        }
    };

    // Failsafe: clear the highlight when any drag operation ends
    useEffect(() => {
        const resetDrag = () => {
            dragCounterRef.current = 0;
            setRootDragOver(false);
            setTreeDropTarget(null);
        };
        document.addEventListener('dragend', resetDrag);
        return () => document.removeEventListener('dragend', resetDrag);
    }, []);

    return (
        <div className="file-explorer">
            {/* Obsidian's two rows: the view tabs with the collapse toggle,
                then (on the Files tab only, as there) the tree's own actions. */}
            <div className="nav-tabs-header">
                <div className="nav-tabs" role="group" aria-label="Sidebar view">
                    <button
                        className={`nav-tab${searchOpen ? '' : ' is-active'}`}
                        data-tooltip="Files"
                        aria-label="Files"
                        aria-pressed={!searchOpen}
                        onClick={onCloseSearch}
                    >
                        <FolderClosed size={18} strokeWidth={1.75} />
                    </button>
                    <button
                        className={`nav-tab${searchOpen ? ' is-active' : ''}`}
                        data-tooltip="Search"
                        aria-label="Search"
                        aria-pressed={searchOpen}
                        onClick={onOpenSearch}
                    >
                        <Search size={18} strokeWidth={1.75} />
                    </button>
                </div>
                <button
                    className="nav-tab nav-collapse-btn"
                    data-tooltip="Collapse sidebar (⌘\)"
                    aria-label="Collapse sidebar"
                    onClick={onCollapse}
                >
                    <SidebarLeft size={18} strokeWidth={1.75} />
                </button>
            </div>

            {!searchOpen && (
                <div className="nav-buttons-container">
                    <button
                        className="nav-action-btn"
                        data-tooltip="New note"
                        aria-label="New note"
                        onClick={() => startCreateInRoot('file')}
                    >
                        <SquarePen size={18} strokeWidth={1.75} />
                    </button>
                    <button
                        className="nav-action-btn"
                        data-tooltip="New folder"
                        aria-label="New folder"
                        onClick={() => startCreateInRoot('folder')}
                    >
                        <FolderPlus size={18} strokeWidth={1.75} />
                    </button>
                    <button
                        className={`nav-action-btn${openMenu === 'create' ? ' is-active' : ''}`}
                        data-tooltip="New drawing or notebook"
                        aria-label="New drawing or notebook"
                        aria-haspopup="menu"
                        aria-expanded={openMenu === 'create'}
                        onClick={openCreateMenu}
                    >
                        <PenTool size={18} strokeWidth={1.75} />
                    </button>
                    <button
                        className={`nav-action-btn${openMenu === 'sort' ? ' is-active' : ''}`}
                        data-tooltip="Change sort order"
                        aria-label="Change sort order"
                        aria-haspopup="menu"
                        aria-expanded={openMenu === 'sort'}
                        onClick={openSortMenu}
                    >
                        <ArrowUpNarrowWide size={18} strokeWidth={1.75} />
                    </button>
                    <button
                        className={`nav-action-btn${autoReveal ? ' is-active' : ''}`}
                        data-tooltip="Auto-reveal current file"
                        aria-label="Auto-reveal current file"
                        aria-pressed={autoReveal}
                        onClick={() => setAutoReveal(on => !on)}
                    >
                        <GalleryVertical size={18} strokeWidth={1.75} />
                    </button>
                    {/* One toggle, as in Obsidian: it offers whichever of the
                        two would change something — Collapse once any folder
                        is open, Expand when none is. */}
                    <button
                        className="nav-action-btn"
                        data-tooltip={anyExpanded ? 'Collapse all' : 'Expand all'}
                        aria-label={anyExpanded ? 'Collapse all' : 'Expand all'}
                        onClick={() => (anyExpanded ? onCollapsePaths(folderPaths) : onExpandPaths(folderPaths))}
                    >
                        {anyExpanded
                            ? <ChevronsDownUp size={18} strokeWidth={1.75} />
                            : <ChevronsUpDown size={18} strokeWidth={1.75} />}
                    </button>
                </div>
            )}

            {searchOpen ? (
                <SearchPanel
                    fileTree={fileTree}
                    cache={searchCache}
                    getOpenTabContent={getOpenTabContent}
                    onOpenResult={handleSearchResult}
                    onClose={onCloseSearch}
                />
            ) : (
                <div
                    ref={treeRef}
                    className={`nav-files-container${rootDragOver ? ' drag-over-root' : ''}`}
                    onDragEnter={handleRootDragEnter}
                    onDragOver={handleRootDragOver}
                    onDragLeave={handleRootDragLeave}
                    onDrop={handleRootDrop}
                    onContextMenu={handleRootContextMenu}
                >
                    {creatingInRoot && (
                        <div className="tree-item tree-inline-input" style={{ paddingLeft: 12 }}>
                            <input
                                ref={inputRef}
                                className="inline-rename-input"
                                type="text"
                                placeholder={placeholderFor(creatingInRoot)}
                                onKeyDown={handleRootCreate}
                                onBlur={handleRootCreateBlur}
                            />
                        </div>
                    )}
                    {displayTree.map((node) => (
                        <TreeNode
                            key={node.path}
                            node={node}
                            onFileClick={onFileClick}
                            // Straight through — no wrapper. The two that used
                            // to sit here each raised a window.prompt() for the
                            // name; a folder row now opens the app's own inline
                            // input instead and hands the name it collected to
                            // these, which are already stable useCallbacks from
                            // App (a fresh arrow here would defeat TreeNode's
                            // memo for every row).
                            onCreateFile={onCreateFile}
                            onCreateFolder={onCreateFolder}
                            onTrash={onTrash}
                            onOpenAsVault={onOpenAsVault}
                            onStyleEntry={onStyleEntry}
                            expandedPaths={expandedPaths}
                            onToggleExpand={onToggleExpand}
                            onMoveFile={onMoveFile}
                            onRenameFile={onRenameFile}
                            onImportFiles={onImportFiles}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// Memoized: its props are referentially stable across editor keystrokes, so the
// whole file tree stops re-rendering while the user types in a note.
export default React.memo(FileExplorer);
