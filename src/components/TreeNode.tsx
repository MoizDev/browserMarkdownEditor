import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BookOpen, ChevronRight, ChevronDown, FileText, FolderIcon, FilePlus, FolderPlus, Trash2, Edit2, PenTool, Notebook } from './icons';
import { isCanvasFile, isEpubFile, isNativeDrawingFile, isNotebookFile, isPdfFile, noteDisplayName } from '../utils/fileTypes';
import { requestConversionRestore } from '../utils/conversionRestore';
import { boardRowOrigin, makeEditableCopyOf, type BoardRowOrigin } from '../utils/oldBoards';
import {
    clearCreateRequest, getCreateKindFor, nameForKind, placeholderFor, requestCreate,
    subscribeCreateRequest, type CreateKind,
} from '../utils/createRequest';
import {
    getTreeDropPosition, isTreeReorderMode, peekDraggedNode, setDraggedNode, setTreeDropTarget,
    subscribeTreeDropTarget, takeDraggedNode,
} from '../utils/treeDrag';
import { isTabDrag } from '../utils/tabDrag';
import { getContextMenu, openContextMenu } from '../utils/contextMenu';
import { isActiveFilePath, subscribeActiveFile } from '../utils/activeFile';
import { isExpanded, subscribeExpanded } from '../utils/expandedPaths';
import LucideGlyph from './LucideGlyph';
import { getEntryStyle, getEntryStyles, subscribeEntryStyles } from '../utils/entryStyleStore';
import { entryColorVar, type IconNode } from '../utils/entryStyle';
import type { ContextMenuEntry } from '../utils/contextMenu';
import type { FileTreeNode } from '../types';

interface TreeNodeProps {
    node: FileTreeNode;
    onFileClick: (node: FileTreeNode) => void;
    onCreateFile: (handle: FileSystemDirectoryHandle, name: string, path: string) => void | Promise<void>;
    onCreateFolder: (handle: FileSystemDirectoryHandle, name: string) => void | Promise<void>;
    onTrash: (node: FileTreeNode) => void;
    onOpenAsVault: (node: FileTreeNode) => void | Promise<void>;
    onStyleEntry: (path: string, icon: string | undefined, color: string | undefined, nodes?: IconNode[]) => void;
    onToggleExpand: (path: string) => void;
    onMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
    onRenameFile: (node: FileTreeNode, newName: string) => unknown;
    onImportFiles: (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => Promise<string[]>;
    depth?: number;
    createRow?: boolean;
}


function TreeNode({ node, onFileClick, onCreateFile, onCreateFolder, onTrash, onOpenAsVault, onStyleEntry, onToggleExpand, onMoveFile, onRenameFile, onImportFiles, depth = 0, createRow = false }: TreeNodeProps) {
    const style = useSyncExternalStore(
        subscribeEntryStyles,
        useCallback(() => getEntryStyle(node.path), [node.path]),
    );
    const customIconNodes = style?.icon ? getEntryStyles().icons[style.icon] : undefined;
    const isActive = useSyncExternalStore(
        subscribeActiveFile,
        useCallback(() => node.kind === 'file' && isActiveFilePath(node.path), [node.kind, node.path]),
    );
    const dropPosition = useSyncExternalStore(
        subscribeTreeDropTarget,
        useCallback(() => getTreeDropPosition(node.path), [node.path]),
    );
    const paddingLeft = 12 + depth * 20;
    const rowStyle = { paddingLeft, ['--tree-indent' as string]: `${paddingLeft}px` };
    const dropClass = dropPosition === 'before' ? ' drop-before'
        : dropPosition === 'after' ? ' drop-after'
            : dropPosition === 'first-child' ? ' drop-first-child' : '';
    const expanded = useSyncExternalStore(
        useCallback(listener => subscribeExpanded(node.path, listener), [node.path]),
        useCallback(() => isExpanded(node.path), [node.path]),
    );
    const [dragOver, setDragOver] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(node.name);
    const renameInputRef = useRef<HTMLInputElement | null>(null);

    const [marked, setMarked] = useState(false);

    const creating = useSyncExternalStore(
        subscribeCreateRequest,
        useCallback(() => getCreateKindFor(node.path), [node.path]),
    );
    const createInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (creating) createInputRef.current?.focus();
    }, [creating]);

    useEffect(() => {
        if (creating && !expanded) onToggleExpand(node.path);
    }, [creating, expanded, node.path, onToggleExpand]);

    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            if (node.kind === 'file') {
                const lastDotIdx = node.name.lastIndexOf('.');
                if (lastDotIdx > 0) {
                    renameInputRef.current.setSelectionRange(0, lastDotIdx);
                } else {
                    renameInputRef.current.select();
                }
            } else {
                renameInputRef.current.select();
            }
        }
    }, [isRenaming, node.kind, node.name]);

    const handleRenameSubmit = async () => {
        const newName = renameValue.trim();
        if (newName && newName !== node.name) {
            await onRenameFile(node, newName);
        } else {
            setRenameValue(node.name);
        }
        setIsRenaming(false);
    };

    const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            handleRenameSubmit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setRenameValue(node.name);
            setIsRenaming(false);
        }
    };

    const handleRenameBlur = () => {
        handleRenameSubmit();
    };

    const startCreate = (kind: CreateKind) => requestCreate(node.path, kind);

    const handleCreateKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            const name = (e.target as HTMLInputElement).value.trim();
            const kind = creating;
            clearCreateRequest();
            if (!name) return;
            if (node.kind !== 'directory') return;
            if (kind === 'folder') await onCreateFolder(node.handle, name);
            else await onCreateFile(node.handle, nameForKind(kind, name), node.path);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            clearCreateRequest();
        }
    };

    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isRenaming) return;
        e.preventDefault();
        e.stopPropagation();
        const row = e.currentTarget;

        const rename: ContextMenuEntry = {
            kind: 'command',
            id: 'rename',
            label: 'Rename',
            run: () => setIsRenaming(true),
        };
        const trash: ContextMenuEntry[] = [
            { kind: 'separator', id: 'sep-trash' },
            { kind: 'command', id: 'trash', label: 'Move to Trash', danger: true, run: () => onTrash(node) },
        ];

        const styleRow: ContextMenuEntry = {
            kind: 'entry-style', id: 'entry-style', label: 'Choose icon / colour',
            icon: style?.icon,
            color: style?.color,
            pick: (icon, color, nodes) =>
                onStyleEntry(node.path, icon, color, nodes as IconNode[] | undefined),
        };

        const editableCopy: ContextMenuEntry[] = [{ kind: 'command', id: 'make-editable-copy', label: 'Make an editable copy',
            run: () => makeEditableCopyOf(node) }];
        const fileEntries = (origin: BoardRowOrigin): ContextMenuEntry[] => [rename, ...(origin === 'old' ? editableCopy : []),
            ...(origin === 'converted' || isPdfFile(node.name)
                ? [{ kind: 'command' as const, id: 'restore-before-conversion', label: 'Restore the copy from before conversion', run: () => requestConversionRestore(node) }]
                : []), { kind: 'separator', id: 'sep-style' }, styleRow, ...trash];
        const entries: ContextMenuEntry[] = node.kind === 'file'
            ? fileEntries('other')
            : [
                { kind: 'command', id: 'new-note', label: 'New note', run: () => startCreate('file') },
                { kind: 'command', id: 'new-folder', label: 'New folder', run: () => startCreate('folder') },
                {
                    kind: 'command', id: 'open-as-vault', label: 'Open as Vault',
                    run: () => { void onOpenAsVault(node); },
                },
                { kind: 'separator', id: 'sep-style' },
                styleRow,
                { kind: 'separator', id: 'sep-rename' },
                rename,
                ...trash,
            ];

        const x = e.clientX, y = e.clientY;
        const raise = (menu: ContextMenuEntry[]) => {
            openContextMenu({
                x,
                y,
                entries: menu,
                label: node.kind === 'file' ? 'File actions' : 'Folder actions',
                opener: row,
                onClose: () => setMarked(false),
            });
            setMarked(true);
        };
        if (node.kind === 'file' && isCanvasFile(node.name) && !isNativeDrawingFile(node.name)) {
            const shown = getContextMenu();
            void boardRowOrigin(node).then(origin => { if (getContextMenu() === shown) raise(fileEntries(origin)); });
        } else raise(entries);
    };

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
        setDraggedNode(node);
    };

    const reorderOwnsDrag = () => isTreeReorderMode() && peekDraggedNode() !== null;

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (node.kind !== 'directory') return;
        if (reorderOwnsDrag()) return;
        if (isTabDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes('Files') ? 'copy' : 'move';
        setDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        if (reorderOwnsDrag()) return;
        e.stopPropagation();
        setDragOver(false);
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        if (reorderOwnsDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);

        if (node.kind === 'directory' && e.dataTransfer.files?.length) {
            await onImportFiles(e.dataTransfer.files, node.handle);
            if (!expanded) onToggleExpand(node.path);
            return;
        }

        const draggedNode = takeDraggedNode();
        if (!draggedNode) return;

        if (draggedNode.path === node.path) return;
        if (node.path.startsWith(draggedNode.path + '/')) return;

        if (onMoveFile) {
            await onMoveFile(draggedNode, node.handle as FileSystemDirectoryHandle, node.path);
        }
    };

    const handleDragEnd = () => {
        setDraggedNode(null);
        setTreeDropTarget(null);
    };

    if (createRow) {
        return creating && node.kind === 'directory' ? (
            <div className="tree-item tree-inline-input" style={{ paddingLeft: 12 + (depth + 1) * 20 }}>
                <input ref={createInputRef} className="inline-rename-input" type="text"
                    placeholder={placeholderFor(creating)} onKeyDown={handleCreateKeyDown}
                    onBlur={() => clearCreateRequest()} onClick={e => e.stopPropagation()} />
            </div>
        ) : null;
    }

    if (node.kind === 'file') {
        return (
            <div
                className={`tree-item tree-file${isActive ? ' is-active' : ''}${marked ? ' is-context-target' : ''}${dropClass}`}
                role="treeitem" aria-level={depth + 1} aria-selected={isActive} tabIndex={-1}
                data-path={node.path}
                style={rowStyle}
                onClick={() => { if (!isRenaming) onFileClick(node); }}
                onContextMenu={handleContextMenu}
                draggable={!isRenaming}
                onDragStart={!isRenaming ? handleDragStart : undefined}
                onDragEnd={!isRenaming ? handleDragEnd : undefined}
            >
                <span
                    className="tree-item-icon file-icon"
                    style={style?.color ? { ['--entry-color' as string]: entryColorVar(style.color) } : undefined}
                >
                    {style?.icon && customIconNodes ? <LucideGlyph nodes={customIconNodes} size={14} />
                        : isEpubFile(node.name) ? <BookOpen size={14} />
                            : isNotebookFile(node.name) ? <Notebook size={14} />
                            : isCanvasFile(node.name) ? <PenTool size={14} />
                                : <FileText size={14} />}
                </span>
                {isRenaming ? (
                    <div className="tree-inline-input" style={{ flex: 1, paddingRight: 0 }}>
                        <input
                            ref={renameInputRef}
                            className="inline-rename-input"
                            type="text"
                            // `renameValue` reaches FileSystemContext.renameFile
                            // VERBATIM, and that is one of the documented
                            // freeEntryName exceptions: it overwrites. So the box
                            // shows the real name, extension and all — a display
                            // name here would rename "A.md" to an extensionless
                            // "A" and removeEntry the original. The extension is
                            // already hidden presentationally: the effect above
                            // pre-selects everything before the last dot.
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            onBlur={handleRenameBlur}
                            onClick={(e) => e.stopPropagation()}
                        />
                    </div>
                ) : (
                    <span
                        className="tree-item-label"
                        data-tooltip={node.path}
                    >{noteDisplayName(node.name)}</span>
                )}
                {!isRenaming && (
                    <span className="tree-item-actions">
                        <button
                            className="tree-action-btn"
                            data-tooltip="Rename"
                            aria-label="Rename"
                            onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                        >
                            <Edit2 size={13} />
                        </button>
                        <button
                            className="tree-action-btn trash-btn"
                            data-tooltip="Move to Trash"
                            aria-label="Move to Trash"
                            onClick={(e) => { e.stopPropagation(); onTrash(node); }}
                        >
                            <Trash2 size={13} />
                        </button>
                    </span>
                )}
            </div>
        );
    }

    return (
        <div
                className={`tree-item tree-folder${dragOver || dropPosition === 'into' ? ' drag-over' : ''}${marked ? ' is-context-target' : ''}${dropClass}`}
                role="treeitem" aria-level={depth + 1} aria-expanded={expanded} tabIndex={-1}
                data-path={node.path}
                style={rowStyle}
                onClick={() => { if (!isRenaming) onToggleExpand(node.path); }}
                onContextMenu={handleContextMenu}
                draggable={!isRenaming}
                onDragStart={!isRenaming ? handleDragStart : undefined}
                onDragEnd={!isRenaming ? handleDragEnd : undefined}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <span className="tree-item-chevron">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span
                    className="tree-item-icon folder-icon"
                    style={style?.color
                        ? { ['--entry-color' as string]: entryColorVar(style.color) }
                        : undefined}
                >
                    {style?.icon && customIconNodes
                        ? <LucideGlyph nodes={customIconNodes} size={14} />
                        : <FolderIcon size={14} />}
                </span>
                {isRenaming ? (
                    <div className="tree-inline-input" style={{ flex: 1, paddingRight: 0 }}>
                        <input
                            ref={renameInputRef}
                            className="inline-rename-input"
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            onBlur={handleRenameBlur}
                            onClick={(e) => e.stopPropagation()}
                        />
                    </div>
                ) : (
                    <span className="tree-item-label">{node.name}</span>
                )}
                {!isRenaming && (
                    <span className="tree-item-actions">
                        <button
                            className="tree-action-btn"
                            data-tooltip="Rename folder"
                            aria-label="Rename folder"
                            onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                        >
                            <Edit2 size={13} />
                        </button>
                        <button
                            className="tree-action-btn"
                            data-tooltip="New file"
                            aria-label="New file"
                            onClick={(e) => { e.stopPropagation(); startCreate('file'); }}
                        >
                            <FilePlus size={14} />
                        </button>
                        <button
                            className="tree-action-btn"
                            data-tooltip="New folder"
                            aria-label="New folder"
                            onClick={(e) => { e.stopPropagation(); startCreate('folder'); }}
                        >
                            <FolderPlus size={14} />
                        </button>
                        <button
                            className="tree-action-btn trash-btn"
                            data-tooltip="Move to Trash"
                            aria-label="Move to Trash"
                            onClick={(e) => { e.stopPropagation(); onTrash(node); }}
                        >
                            <Trash2 size={13} />
                        </button>
                    </span>
                )}
        </div>
    );
}

const MemoTreeNode = React.memo(TreeNode);
export default MemoTreeNode;
