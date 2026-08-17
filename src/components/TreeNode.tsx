import React, { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, FileText, FolderIcon, FilePlus, FolderPlus, Trash2, Edit2, PenTool } from './icons';
import { isDrawingFile } from '../utils/fileTypes';
import { setDraggedNode, takeDraggedNode } from '../utils/treeDrag';
import { isTabDrag } from '../utils/tabDrag';
import { openContextMenu } from '../utils/contextMenu';
import type { ContextMenuEntry } from '../utils/contextMenu';
import type { FileTreeNode } from '../types';

interface TreeNodeProps {
    node: FileTreeNode;
    activeFilePath: string | null;
    onFileClick: (node: FileTreeNode) => void;
    /** Create a file called `name` inside `handle`, which sits at `path`.
     *  THREE arguments, matching App.handleCreateFile: it opens the new file
     *  afterwards and needs the vault-root-relative path to key the tab the way
     *  buildFileTree keys the row. */
    onCreateFile: (handle: FileSystemDirectoryHandle, name: string, path: string) => void | Promise<void>;
    /** Create a folder called `name` inside `handle`. TWO arguments,
     *  deliberately unlike onCreateFile above: App.handleCreateFolder takes no
     *  path because it opens nothing afterwards and so has nothing to key. The
     *  asymmetry is the call surface App actually exposes — do not tidy the two
     *  into one shape. */
    onCreateFolder: (handle: FileSystemDirectoryHandle, name: string) => void | Promise<void>;
    onTrash: (node: FileTreeNode) => void;
    expandedPaths: Set<string>;
    onToggleExpand: (path: string) => void;
    onMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
    onRenameFile: (node: FileTreeNode, newName: string) => void | Promise<void>;
    /** Copy files dragged in from the OS into `targetDir`. */
    onImportFiles: (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => Promise<string[]>;
    depth?: number;
}


function TreeNode({ node, activeFilePath, onFileClick, onCreateFile, onCreateFolder, onTrash, expandedPaths, onToggleExpand, onMoveFile, onRenameFile, onImportFiles, depth = 0 }: TreeNodeProps) {
    const isActive = node.kind === 'file' && node.path === activeFilePath;
    const paddingLeft = 12 + depth * 16;
    const expanded = expandedPaths.has(node.path);
    const [dragOver, setDragOver] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(node.name);
    const renameInputRef = useRef<HTMLInputElement | null>(null);

    // "The right-click menu is on me" — LOCAL row state, and deliberately not a
    // prop threaded down from FileExplorer. This component is memoized (bottom
    // of the file) precisely so the tree stops re-rendering while the user types
    // in a note; a `contextTargetPath` prop would have to travel the whole
    // recursion and would re-render every visible row TWICE per menu — once when
    // it opens and once when it closes — for a value exactly one row cares
    // about. That is the same trap `saveEpoch` was moved out of the prop tree to
    // escape (AGENTS.md § Conventions). Local state re-renders this one row, and
    // the request carries an `onClose` that clears it however the menu was
    // dismissed.
    const [marked, setMarked] = useState(false);

    // The folder branch's "New note" / "New folder" flow. It used to be a
    // window.prompt() raised from FileExplorer; this is the app's own inline
    // input row instead — the same one the explorer header already opens at the
    // vault root, and the same direction 89824e7 took the rename dialog.
    const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
    const createInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (creating) createInputRef.current?.focus();
    }, [creating]);

    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            // Select text excluding extension if it's a file
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
            setRenameValue(node.name); // Revert if empty or unchanged
        }
        setIsRenaming(false);
    };

    const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            handleRenameSubmit();
        } else if (e.key === 'Escape') {
            setRenameValue(node.name);
            setIsRenaming(false);
        }
    };

    const handleRenameBlur = () => {
        handleRenameSubmit();
    };

    // ── Creating inside a folder ──
    /**
     * Open the inline input row inside this folder.
     *
     * Expanding first is not cosmetic: the row renders as the first child of
     * `.tree-children`, so a collapsed folder would take the name and show
     * nothing — neither the field being typed into nor the file that lands in
     * it. Going through `onToggleExpand` rather than a local flag keeps the one
     * description of what is open (App's `expandedPaths`, which is persisted and
     * which a rename carries across) telling the truth.
     */
    const startCreate = (kind: 'file' | 'folder') => {
        if (!expanded) onToggleExpand(node.path);
        setCreating(kind);
    };

    const handleCreateKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            const name = (e.target as HTMLInputElement).value.trim();
            const kind = creating;
            setCreating(null);
            if (!name) return;
            // Narrowing only: the input row is rendered on the folder branch
            // alone, so `node` is a directory whenever this runs.
            if (node.kind !== 'directory') return;
            // A name already taken in this folder is refused by
            // App.handleCreateFile / handleCreateFolder, which say so in the
            // app's own dialog and create nothing. The tree deliberately does
            // not second-guess that check: one place decides, so there is one
            // wording and no way for the two to disagree about what "taken"
            // means (a file and a folder cannot share a name — freeEntryName's
            // rule, FileSystemContext.tsx:21-25).
            if (kind === 'folder') await onCreateFolder(node.handle, name);
            else await onCreateFile(node.handle, name, node.path);
        } else if (e.key === 'Escape') {
            setCreating(null);
        }
    };

    /**
     * Raise the app's own menu for this row.
     *
     * `openContextMenu` is imported straight from the module store rather than
     * arriving as a prop, which is what keeps TreeNodeProps — and so the memo —
     * exactly as it was (see `marked` above).
     *
     * `preventDefault` suppresses the browser's own menu; `stopPropagation`
     * keeps FileExplorer's root-container handler from raising a second menu
     * behind this one. Nothing in the tree stopped bubbling before this handler
     * existed, and the container independently checks `closest('.tree-item')` —
     * belt and braces, because either one alone is a refactor away from
     * silently producing two menus.
     *
     * A row being RENAMED is the one case that gets neither: the row is a text
     * field then, and a text field wants the browser's own menu — its Paste is
     * the whole point of the gesture. The sharper reason is that raising ours
     * COMMITS the rename: ContextMenu focuses its first enabled row on mount
     * (ContextMenu.tsx:208-210), the field blurs, and `handleRenameBlur` writes
     * the half-typed name to disk through `renameFile`, which is copy-then-
     * delete and the deliberate overwrite exception. So a right-click meant to
     * paste renamed the file instead, and opened "File actions" over a row
     * whose name had already changed. Returning WITHOUT preventing is what
     * hands the field its native menu — the same rule, and the same reason,
     * FileExplorer's container handler states for `.tree-item`. It is also why
     * the row hides its own action buttons while it is being named.
     */
    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isRenaming) return;
        e.preventDefault();
        e.stopPropagation();
        // Read off the event synchronously: React clears `currentTarget` once
        // the handler returns, and the request outlives this call.
        const row = e.currentTarget;

        const rename: ContextMenuEntry = {
            kind: 'command',
            id: 'rename',
            label: 'Rename',
            // The row's existing inline rename — the same thing its pencil
            // button opens, so there is one rename UI and not two.
            run: () => setIsRenaming(true),
        };
        // Move to Trash goes through `onTrash`, which is App.handleTrash, and
        // never through the moveToTrash primitive. handleTrash owns five things
        // the primitive has none of: the app's own confirmation naming the file
        // and `.Garbage`, the in-flight guard that covers the QUESTION as well
        // as the copy, a flush of every doomed tab, a drain of the reconcile
        // queue, and the closing of every tab the deletion took. The menu closes
        // before `run` fires, so a second right-click cannot stack a second
        // question behind the first.
        const trash: ContextMenuEntry[] = [
            { kind: 'separator', id: 'sep-trash' },
            { kind: 'command', id: 'trash', label: 'Move to Trash', danger: true, run: () => onTrash(node) },
        ];

        const entries: ContextMenuEntry[] = node.kind === 'file'
            ? [rename, ...trash]
            : [
                { kind: 'command', id: 'new-note', label: 'New note', run: () => startCreate('file') },
                { kind: 'command', id: 'new-folder', label: 'New folder', run: () => startCreate('folder') },
                { kind: 'separator', id: 'sep-rename' },
                rename,
                ...trash,
            ];

        openContextMenu({
            x: e.clientX,
            y: e.clientY,
            entries,
            label: node.kind === 'file' ? 'File actions' : 'Folder actions',
            opener: row,
            onClose: () => setMarked(false),
        });
        // Marked AFTER the request is raised, not before, and the order is
        // load-bearing: openContextMenu closes whatever menu it replaces, which
        // runs that raiser's `onClose`. Right-clicking THIS row twice in a row
        // makes the two calls this row's own — `setMarked(false)` from the
        // outgoing request and `setMarked(true)` from this one — and React
        // batches both into one render, so raising the mark first would leave
        // the row unmarked underneath its own open menu.
        setMarked(true);
    };

    // ── Drag handlers ──
    const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
        // Store the node in a module-level variable since dataTransfer can't hold objects
        setDraggedNode(node);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (node.kind !== 'directory') return;
        // An editor tab being carried to the split view passes right over the
        // tree. Not preventing the default is what refuses the drop, so the row
        // never lights up offering something it could not do with it.
        if (isTabDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        // OS files are copied in; a tree node is moved. `types` is the only
        // readable signal here — `files` is empty during dragover by design.
        e.dataTransfer.dropEffect = Array.from(e.dataTransfer.types).includes('Files') ? 'copy' : 'move';
        setDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.stopPropagation();
        setDragOver(false);
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);

        // Dropped in from the OS — copy into this folder.
        if (node.kind === 'directory' && e.dataTransfer.files?.length) {
            await onImportFiles(e.dataTransfer.files, node.handle);
            if (!expanded) onToggleExpand(node.path);   // reveal what just landed
            return;
        }

        const draggedNode = takeDraggedNode();
        if (!draggedNode) return;

        // Don't drop into itself or its own parent
        if (draggedNode.path === node.path) return;
        // Don't drop a folder into its own descendant
        if (node.path.startsWith(draggedNode.path + '/')) return;

        if (onMoveFile) {
            await onMoveFile(draggedNode, node.handle as FileSystemDirectoryHandle, node.path);
        }
    };

    const handleDragEnd = () => {
        setDraggedNode(null);
    };

    if (node.kind === 'file') {
        return (
            <div
                className={`tree-item tree-file${isActive ? ' is-active' : ''}${marked ? ' is-context-target' : ''}`}
                style={{ paddingLeft }}
                onClick={() => { if (!isRenaming) onFileClick(node); }}
                onContextMenu={handleContextMenu}
                draggable={!isRenaming}
                onDragStart={!isRenaming ? handleDragStart : undefined}
                onDragEnd={!isRenaming ? handleDragEnd : undefined}
            >
                <span className="tree-item-icon file-icon">
                    {isDrawingFile(node.name) ? <PenTool size={14} /> : <FileText size={14} />}
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
                            title="Rename"
                            onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                        >
                            <Edit2 size={13} />
                        </button>
                        <button
                            className="tree-action-btn trash-btn"
                            title="Move to Trash"
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
        <div className="tree-item-container">
            <div
                className={`tree-item tree-folder${dragOver ? ' drag-over' : ''}${marked ? ' is-context-target' : ''}`}
                style={{ paddingLeft }}
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
                <span className="tree-item-icon folder-icon">
                    <FolderIcon size={14} />
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
                            title="Rename folder"
                            onClick={(e) => { e.stopPropagation(); setIsRenaming(true); }}
                        >
                            <Edit2 size={13} />
                        </button>
                        <button
                            className="tree-action-btn"
                            title="New file"
                            onClick={(e) => { e.stopPropagation(); startCreate('file'); }}
                        >
                            <FilePlus size={14} />
                        </button>
                        <button
                            className="tree-action-btn"
                            title="New folder"
                            onClick={(e) => { e.stopPropagation(); startCreate('folder'); }}
                        >
                            <FolderPlus size={14} />
                        </button>
                        <button
                            className="tree-action-btn trash-btn"
                            title="Move to Trash"
                            onClick={(e) => { e.stopPropagation(); onTrash(node); }}
                        >
                            <Trash2 size={13} />
                        </button>
                    </span>
                )}
            </div>
            {(expanded || creating) && (
                <div className="tree-children">
                    {creating && (
                        // The app's own input row, exactly the markup and the
                        // classes the explorer's root create flow already uses
                        // (FileExplorer's `creatingInRoot` row) — one indent
                        // level deeper, because what is being named lands inside
                        // this folder. It replaces a window.prompt(), which is
                        // the direction 89824e7 took the app: the question is
                        // asked where the answer will appear.
                        <div className="tree-item tree-inline-input" style={{ paddingLeft: 12 + (depth + 1) * 16 }}>
                            <input
                                ref={createInputRef}
                                className="inline-rename-input"
                                type="text"
                                placeholder={creating === 'file' ? 'Untitled.md' : 'New folder'}
                                onKeyDown={handleCreateKeyDown}
                                onBlur={() => setCreating(null)}
                                onClick={(e) => e.stopPropagation()}
                            />
                        </div>
                    )}
                    {expanded && node.children.map((child) => (
                        // The MEMO wrapper, not the bare function — otherwise
                        // recursion would re-render the whole subtree anyway.
                        <MemoTreeNode
                            key={child.path}
                            node={child}
                            activeFilePath={activeFilePath}
                            onFileClick={onFileClick}
                            onCreateFile={onCreateFile}
                            onCreateFolder={onCreateFolder}
                            onTrash={onTrash}
                            expandedPaths={expandedPaths}
                            onToggleExpand={onToggleExpand}
                            onMoveFile={onMoveFile}
                            onRenameFile={onRenameFile}
                            onImportFiles={onImportFiles}
                            depth={depth + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// Memoized: a save (or any other re-render of the explorer) used to reconcile
// every visible row recursively, since all its props are already stable and
// only the parent's identity churned. Local rename state is untouched by this.
const MemoTreeNode = React.memo(TreeNode);
export default MemoTreeNode;
