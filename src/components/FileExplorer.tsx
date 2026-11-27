import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { getExpandedPaths, isExpanded, subscribeExpandedPaths } from '../utils/expandedPaths';
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
    ancestorsOf, clearCreateRequest, getCreateKindFor, getCreateRequest, nameForKind, placeholderFor,
    requestCreate, subscribeCreateRequest, type CreateKind,
} from '../utils/createRequest';
import { getActiveFilePath, subscribeActiveFile } from '../utils/activeFile';
import { collectFiles } from '../utils/tree';
import { createSortCache, isTimeSort, sortTree, TREE_SORT_ORDERS, type TreeSortOrder } from '../utils/treeSort';
import { areIndexTimesReady, getFileTimes, getFileTimesVersion, statFileTimes, subscribeFileTimes } from '../utils/fileTimes';
import { readJSON, writeJSON } from '../utils/storage';
import type { SearchController } from '../utils/searchController';
import type { FileTreeNode, FileTreeFileNode, TextRange } from '../types';
import { orderListFor, type EntryOrder, type IconNode } from '../utils/entryStyle';

function isExternalFileDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes('Files');
}

const SORT_ROWS: { id: TreeSortOrder; label: string }[] = [
    { id: 'name-asc', label: 'File name (A to Z)' },
    { id: 'name-desc', label: 'File name (Z to A)' },
    { id: 'mtime-desc', label: 'Modified time (new to old)' },
    { id: 'mtime-asc', label: 'Modified time (old to new)' },
    { id: 'custom', label: 'Custom' },
];

const NO_ORDER: EntryOrder = Object.freeze({}) as EntryOrder;

function readSortOrder(): TreeSortOrder {
    const stored = readJSON<unknown>('fileTreeSortOrder', 'name-asc');
    return TREE_SORT_ORDERS.includes(stored as TreeSortOrder) ? stored as TreeSortOrder : 'name-asc';
}

const TREE_OVERSCAN = 8;
interface VisibleRow { node: FileTreeNode; depth: number; createRow?: boolean }

interface FileExplorerProps {
    readSnapshot: (handle: FileSystemFileHandle) => Promise<File>;
    rootHandle: FileSystemDirectoryHandle | null;
    search: SearchController;
    fileTree: FileTreeNode[];
    onFileClick: (node: FileTreeNode) => void;
    onCreateFile: (parentHandle: FileSystemDirectoryHandle | null, name: string, parentPath?: string) => void | Promise<void>;
    onCreateFolder: (parentHandle: FileSystemDirectoryHandle | null, name: string) => void | Promise<void>;
    onCollapse: () => void;
    searchOpen: boolean;
    onOpenSearch: () => void;
    onCloseSearch: () => void;
    onTrash: (node: FileTreeNode) => void;
    onOpenAsVault: (node: FileTreeNode) => void | Promise<void>;
    onStyleEntry: (path: string, icon: string | undefined, color: string | undefined, nodes?: IconNode[]) => void;
    onToggleExpand: (path: string) => void;
    onExpandPaths: (paths: string[]) => void;
    onCollapsePaths: (paths: string[]) => void;
    onMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
    onSetTreeOrder: (folderPath: string, names: readonly string[] | null) => void;
    onRenameFile: (node: FileTreeNode, newName: string) => unknown;
    onImportFiles: (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => Promise<string[]>;
    onOpenSearchResult: (node: FileTreeFileNode, range: TextRange | null) => void;
}

function FileExplorer({
    readSnapshot,
    rootHandle,
    search,
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
    onToggleExpand,
    onExpandPaths,
    onCollapsePaths,
    onMoveFile,
    onSetTreeOrder,
    onRenameFile,
    onImportFiles,
    onOpenSearchResult,
}: FileExplorerProps) {
    const creatingInRoot = useSyncExternalStore(
        subscribeCreateRequest,
        useCallback(() => getCreateKindFor(''), []),
    );
    const [rootDragOver, setRootDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const treeRef = useRef<HTMLDivElement | null>(null);

    const [openMenu, setOpenMenu] = useState<'create' | 'sort' | null>(null);
    const clearOpenMenu = useCallback(() => setOpenMenu(null), []);

    const [sortOrder, setSortOrder] = useState<TreeSortOrder>(readSortOrder);
    useEffect(() => { writeJSON('fileTreeSortOrder', sortOrder); }, [sortOrder]);
    const reordering = sortOrder === 'custom';
    useEffect(() => {
        setTreeReorderMode(reordering);
        return () => setTreeReorderMode(false);
    }, [reordering]);

    const [autoReveal, setAutoReveal] = useState<boolean>(() => readJSON<unknown>('fileTreeAutoReveal', false) === true);
    useEffect(() => { writeJSON('fileTreeAutoReveal', autoReveal); }, [autoReveal]);

    const [sortCache] = useState(createSortCache);
    const timesVersion = useSyncExternalStore(
        subscribeFileTimes,
        useCallback(() => (isTimeSort(sortOrder) ? getFileTimesVersion() : 0), [sortOrder]),
    );
    const indexTimesReady = useSyncExternalStore(subscribeFileTimes, areIndexTimesReady);
    const customOrder = useSyncExternalStore(
        subscribeEntryStyles,
        useCallback(() => (reordering ? getEntryOrder() : NO_ORDER), [reordering]),
    );
    const displayTree = useMemo(() => {
        void timesVersion; // the times map is mutable; its version is the dependency
        return sortTree(fileTree, sortOrder, getFileTimes(), sortCache, customOrder);
    }, [fileTree, sortOrder, timesVersion, customOrder, sortCache]);

    const dropIndex = useMemo<TreeIndex | null>(
        () => (reordering ? indexTree(displayTree) : null),
        [reordering, displayTree],
    );

    useEffect(() => {
        if (!isTimeSort(sortOrder) || indexTimesReady) return;
        let current = true;
        void statFileTimes(collectFiles(fileTree), () => current, readSnapshot);
        return () => { current = false; };
    }, [fileTree, sortOrder, readSnapshot, indexTimesReady]);

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
    const expandedPaths = useSyncExternalStore(subscribeExpandedPaths, getExpandedPaths);
    const anyExpanded = useMemo(
        () => folderPaths.some(p => expandedPaths.has(p)),
        [folderPaths, expandedPaths],
    );
    const createRequest = useSyncExternalStore(subscribeCreateRequest, getCreateRequest);
    const visibleRows = useMemo(() => {
        const rows: VisibleRow[] = [];
        const walk = (nodes: FileTreeNode[], depth: number) => {
            for (const node of nodes) {
                rows.push({ node, depth });
                if (node.kind === 'directory') {
                    if (createRequest?.path === node.path) rows.push({ node, depth, createRow: true });
                    if (expandedPaths.has(node.path)) walk(node.children, depth + 1);
                }
            }
        };
        walk(displayTree, 0);
        return rows;
    }, [displayTree, expandedPaths, createRequest]);
    const [viewport, setViewport] = useState({ top: 0, height: 0, rowHeight: 28 });
    const [draggedPath, setDraggedPath] = useState<string | null>(null);
    const updateViewport = useCallback(() => {
        const tree = treeRef.current;
        if (!tree) return;
        const rowHeight = parseFloat(getComputedStyle(tree).getPropertyValue('--nav-item-height')) || 28;
        setViewport(previous => {
            const next = { top: tree.scrollTop, height: tree.clientHeight, rowHeight };
            return previous.top === next.top && previous.height === next.height && previous.rowHeight === next.rowHeight ? previous : next;
        });
    }, []);
    useLayoutEffect(() => {
        const tree = treeRef.current;
        if (!tree) return;
        updateViewport();
        const observer = new ResizeObserver(updateViewport);
        observer.observe(tree);
        return () => observer.disconnect();
    }, [searchOpen, updateViewport]);
    const rootOffset = creatingInRoot ? viewport.rowHeight : 0;
    const start = Math.max(0, Math.floor((viewport.top - rootOffset) / viewport.rowHeight) - TREE_OVERSCAN);
    const end = Math.min(visibleRows.length, Math.ceil((viewport.top + viewport.height - rootOffset) / viewport.rowHeight) + TREE_OVERSCAN);
    // A native drag ends if its source unmounts. Keep just that row, even when
    // auto-scrolling carries the viewport far away from it.
    const draggedIndex = draggedPath ? visibleRows.findIndex(row => !row.createRow && row.node.path === draggedPath) : -1;
    const rowIndices = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
    if (draggedIndex >= 0 && (draggedIndex < start || draggedIndex >= end)) {
        rowIndices.push(draggedIndex);
        rowIndices.sort((a, b) => a - b);
    }
    const revealPathRef = useRef<string | null>(null);
    const focusPathRef = useRef<string | null>(null);
    useLayoutEffect(() => {
        if (!createRequest?.path) return;
        revealPathRef.current = createRequest.path;
        onExpandPaths(ancestorsOf(createRequest.path));
    }, [createRequest, onExpandPaths]);
    useLayoutEffect(() => {
        const path = revealPathRef.current;
        const tree = treeRef.current;
        if (!path || !tree) return;
        const index = visibleRows.findIndex(row => !row.createRow && row.node.path === path);
        if (index < 0) return;
        const top = rootOffset + (index + (createRequest?.path === path ? 1 : 0)) * viewport.rowHeight;
        if (top < tree.scrollTop) tree.scrollTop = top;
        else if (top + viewport.rowHeight > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + viewport.rowHeight - tree.clientHeight;
        revealPathRef.current = null;
        updateViewport();
    }, [visibleRows, rootOffset, viewport.rowHeight, updateViewport, createRequest]);
    useLayoutEffect(() => {
        const path = focusPathRef.current;
        if (!path) return;
        const row = treeRef.current?.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(path)}"]`);
        if (row) { row.focus(); focusPathRef.current = null; }
    }, [start, end, visibleRows]);

    const filePathSet = useMemo(() => new Set(collectFiles(fileTree).map(f => f.path)), [fileTree]);
    const revealedRef = useRef<string | null>(null);
    useEffect(() => { revealedRef.current = null; }, [autoReveal, searchOpen]);
    useEffect(() => {
        if (!autoReveal || searchOpen) return;
        const reveal = () => {
            const path = getActiveFilePath();
            if (!path || !filePathSet.has(path) || path === revealedRef.current) return;
            revealedRef.current = path;
            const slash = path.lastIndexOf('/');
            if (slash !== -1) onExpandPaths(ancestorsOf(path.slice(0, slash)));
            revealPathRef.current = path;
            const index = visibleRows.findIndex(row => !row.createRow && row.node.path === path);
            const tree = treeRef.current;
            if (index >= 0 && tree) {
                const top = rootOffset + index * viewport.rowHeight;
                if (top < tree.scrollTop) tree.scrollTop = top;
                else if (top + viewport.rowHeight > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + viewport.rowHeight - tree.clientHeight;
                revealPathRef.current = null;
                updateViewport();
            }
        };
        reveal();
        const unsubscribe = subscribeActiveFile(reveal);
        return unsubscribe;
    }, [autoReveal, searchOpen, filePathSet, onExpandPaths, visibleRows, rootOffset, viewport.rowHeight, updateViewport]);

    useEffect(() => {
        if (creatingInRoot && inputRef.current) {
            inputRef.current.focus();
        }
    }, [creatingInRoot]);

    const createTarget = () => {
        const active = getActiveFilePath();
        if (!active) return '';
        const node = collectFiles(fileTree).find(f => f.path === active);
        if (!node) return '';
        const slash = node.path.lastIndexOf('/');
        return slash === -1 ? '' : node.path.slice(0, slash);
    };

    const startCreateInRoot = (kind: CreateKind) => {
        onCloseSearch();
        const target = createTarget();
        onExpandPaths(ancestorsOf(target));
        requestCreate(target, kind);
    };

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
        onCloseSearch();
    };

    const handleRootCreate = async (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            const name = (e.target as HTMLInputElement).value.trim();
            if (!name) {
                clearCreateRequest();
                return;
            }
            if (creatingInRoot === 'notebook' || creatingInRoot === 'drawing') {
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

    const handleRootContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('.tree-item')) return;
        e.preventDefault();
        const container = e.currentTarget;
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

    const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (target.closest('input, button')) return;
        const rows = visibleRows.filter(row => !row.createRow);
        const path = target.closest<HTMLElement>('.tree-item[data-path]')?.dataset.path;
        let index = rows.findIndex(row => row.node.path === path);
        if (e.key === 'ArrowDown') index = Math.min(rows.length - 1, index + 1);
        else if (e.key === 'ArrowUp') index = index < 0 ? rows.length - 1 : Math.max(0, index - 1);
        else if (index >= 0 && e.key === 'ArrowRight') {
            const node = rows[index].node;
            if (node.kind === 'directory' && !expandedPaths.has(node.path)) onToggleExpand(node.path);
            else if (node.kind === 'directory' && index + 1 < rows.length) index++;
        } else if (index >= 0 && e.key === 'ArrowLeft') {
            const node = rows[index].node;
            if (node.kind === 'directory' && expandedPaths.has(node.path)) onToggleExpand(node.path);
            else {
                const parent = node.path.slice(0, node.path.lastIndexOf('/'));
                const parentIndex = rows.findIndex(row => row.node.path === parent);
                if (parentIndex >= 0) index = parentIndex;
            }
        } else if (index >= 0 && (e.key === 'Enter' || e.key === ' ')) {
            const node = rows[index].node;
            if (node.kind === 'directory') onToggleExpand(node.path); else onFileClick(node);
            e.preventDefault();
            return;
        } else return;
        e.preventDefault();
        const row = rows[index];
        if (!row) return;
        const absolute = visibleRows.findIndex(item => item === row);
        const tree = treeRef.current;
        if (!tree) return;
        focusPathRef.current = row.node.path;
        const top = rootOffset + absolute * viewport.rowHeight;
        if (top < tree.scrollTop) tree.scrollTop = top;
        else if (top + viewport.rowHeight > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + viewport.rowHeight - tree.clientHeight;
        updateViewport();
        const element = tree.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(row.node.path)}"]`);
        if (element) { element.focus(); focusPathRef.current = null; }
    };

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
        else spot = isExpanded(node.path) && node.children.length > 0 ? 'first-child' : 'after';
        return { path: node.path, spot, plan: planTreeDrop(dropIndex, dragged, node.path, spot) };
    };

    const clearReorderTarget = () => {
        setTreeDropTarget(null);
        setRootDragOver(false);
    };

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

    const dragCounterRef = useRef(0);

    const handleRootDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        if (isTabDrag(e.dataTransfer)) return;
        e.preventDefault();
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
        e.dataTransfer.dropEffect = isExternalFileDrag(e) ? 'copy' : 'move';
    };

    const handleRootDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        if (reordering && peekDraggedNode()) {
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
                    search={search}
                    onOpenResult={handleSearchResult}
                    onClose={onCloseSearch}
                />
            ) : (
                <div
                    ref={treeRef}
                    className={`nav-files-container${rootDragOver ? ' drag-over-root' : ''}`}
                    onDragStartCapture={e => setDraggedPath((e.target as HTMLElement).closest<HTMLElement>('.tree-item[data-path]')?.dataset.path ?? null)}
                    onDragEndCapture={() => setDraggedPath(null)}
                    onDragEnter={handleRootDragEnter}
                    onDragOver={handleRootDragOver}
                    onDragLeave={handleRootDragLeave}
                    onDrop={handleRootDrop}
                    onContextMenu={handleRootContextMenu}
                    onScroll={updateViewport}
                    onKeyDown={handleTreeKeyDown}
                    role="tree"
                    aria-label="Vault files"
                    tabIndex={0}
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
                    {rowIndices.map((index, position) => {
                        const { node, depth, createRow } = visibleRows[index];
                        const key = `${node.path}${createRow ? '/\u0000create' : ''}`;
                        const gap = index - (position ? rowIndices[position - 1] + 1 : 0);
                        return <React.Fragment key={key}>
                        {gap > 0 && <div key="gap" style={{ height: gap * viewport.rowHeight }} />}
                        <TreeNode
                            key="row"
                            node={node}
                            depth={depth}
                            createRow={createRow}
                            onFileClick={onFileClick}
                            onCreateFile={onCreateFile}
                            onCreateFolder={onCreateFolder}
                            onTrash={onTrash}
                            onOpenAsVault={onOpenAsVault}
                            onStyleEntry={onStyleEntry}
                            onToggleExpand={onToggleExpand}
                            onMoveFile={onMoveFile}
                            onRenameFile={onRenameFile}
                            onImportFiles={onImportFiles}
                        />
                        </React.Fragment>;
                    })}
                    <div style={{ height: (visibleRows.length - (rowIndices.at(-1) ?? -1) - 1) * viewport.rowHeight }} />
                </div>
            )}
        </div>
    );
}

export default React.memo(FileExplorer);
