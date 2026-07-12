import React, { useState, useRef, useEffect } from 'react';
import TreeNode, { type TreeNodeStatic } from './TreeNode';
import SearchPanel from './SearchPanel';
import { FilePlus, FolderPlus, FolderOpen, Search } from './icons';
import { createVaultTextCache } from '../utils/vaultSearch';
import type { VaultTextCache } from '../utils/vaultSearch';
import type { FileTreeNode, FileTreeFileNode, TextRange } from '../types';

interface FileExplorerProps {
    rootHandle: FileSystemDirectoryHandle | null;
    fileTree: FileTreeNode[];
    activeFilePath: string | null;
    onFileClick: (node: FileTreeNode) => void;
    onCreateFile: (parentHandle: FileSystemDirectoryHandle | null, name: string, parentPath?: string) => void | Promise<void>;
    onCreateFolder: (parentHandle: FileSystemDirectoryHandle | null, name: string) => void | Promise<void>;
    onChangeVault: () => void;
    onTrash: (node: FileTreeNode) => void;
    expandedPaths: Set<string>;
    onToggleExpand: (path: string) => void;
    onMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
    onRenameFile: (node: FileTreeNode, newName: string) => void | Promise<void>;
    onOpenSearchResult: (node: FileTreeFileNode, range: TextRange | null) => void;
    getOpenTabContent: (path: string) => string | null;
    /** Bumped after each completed save-flush; re-validates the search index. */
    saveEpoch: number;
}

function FileExplorer({
    rootHandle,
    fileTree,
    activeFilePath,
    onFileClick,
    onCreateFile,
    onCreateFolder,
    onChangeVault,
    onTrash,
    expandedPaths,
    onToggleExpand,
    onMoveFile,
    onRenameFile,
    onOpenSearchResult,
    getOpenTabContent,
    saveEpoch
}: FileExplorerProps) {
    const [creatingInRoot, setCreatingInRoot] = useState<'file' | 'folder' | null>(null); // 'file' | 'folder' | null
    const [rootDragOver, setRootDragOver] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

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

    /** Open the inline "new file/folder" input, leaving search mode if needed
     *  (the input lives in the tree view, which search temporarily replaces). */
    const startCreateInRoot = (kind: 'file' | 'folder') => {
        setSearchOpen(false);
        setCreatingInRoot(kind);
    };

    const handleSearchResult = (node: FileTreeFileNode, range: TextRange | null) => {
        onOpenSearchResult(node, range);
        setSearchOpen(false); // picking a result returns the sidebar to the tree
    };

    const handleRootCreate = async (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            const name = (e.target as HTMLInputElement).value.trim();
            if (!name) {
                setCreatingInRoot(null);
                return;
            }
            if (creatingInRoot === 'file') {
                await onCreateFile(rootHandle, name, '');
            } else {
                await onCreateFolder(rootHandle, name);
            }
            setCreatingInRoot(null);
        } else if (e.key === 'Escape') {
            setCreatingInRoot(null);
        }
    };

    const handleRootCreateBlur = () => {
        setCreatingInRoot(null);
    };

    // Root-level drop handlers — use a counter to reliably track enter/leave
    const dragCounterRef = useRef(0);

    const handleRootDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        dragCounterRef.current++;
        setRootDragOver(true);
    };

    const handleRootDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    };

    const handleRootDragLeave = () => {
        dragCounterRef.current--;
        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setRootDragOver(false);
        }
    };

    const handleRootDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setRootDragOver(false);
        const draggedNode = (TreeNode as unknown as TreeNodeStatic)._draggedNode;
        if (!draggedNode || !rootHandle) return;
        (TreeNode as unknown as TreeNodeStatic)._draggedNode = null;
        if (onMoveFile) {
            await onMoveFile(draggedNode, rootHandle, '');
        }
    };

    // Failsafe: clear the highlight when any drag operation ends
    useEffect(() => {
        const resetDrag = () => {
            dragCounterRef.current = 0;
            setRootDragOver(false);
        };
        document.addEventListener('dragend', resetDrag);
        return () => document.removeEventListener('dragend', resetDrag);
    }, []);

    return (
        <div className="file-explorer">
            <div className="nav-header">
                <span className="nav-header-title">
                    {rootHandle ? rootHandle.name : 'Explorer'}
                </span>
                <div className="nav-header-actions">
                    <button
                        className={`nav-action-btn${searchOpen ? ' active' : ''}`}
                        title="Search vault"
                        aria-pressed={searchOpen}
                        onClick={() => setSearchOpen(open => !open)}
                    >
                        <Search size={15} />
                    </button>
                    <button
                        className="nav-action-btn"
                        title="New note"
                        onClick={() => startCreateInRoot('file')}
                    >
                        <FilePlus size={15} />
                    </button>
                    <button
                        className="nav-action-btn"
                        title="New folder"
                        onClick={() => startCreateInRoot('folder')}
                    >
                        <FolderPlus size={15} />
                    </button>
                    <button
                        className="nav-action-btn"
                        title="Open another vault"
                        onClick={onChangeVault}
                    >
                        <FolderOpen size={15} />
                    </button>
                </div>
            </div>

            {searchOpen ? (
                <SearchPanel
                    fileTree={fileTree}
                    cache={searchCache}
                    getOpenTabContent={getOpenTabContent}
                    saveEpoch={saveEpoch}
                    onOpenResult={handleSearchResult}
                    onClose={() => setSearchOpen(false)}
                />
            ) : (
                <div
                    className={`nav-files-container${rootDragOver ? ' drag-over-root' : ''}`}
                    onDragEnter={handleRootDragEnter}
                    onDragOver={handleRootDragOver}
                    onDragLeave={handleRootDragLeave}
                    onDrop={handleRootDrop}
                >
                    {creatingInRoot && (
                        <div className="tree-item tree-inline-input" style={{ paddingLeft: 12 }}>
                            <input
                                ref={inputRef}
                                className="inline-rename-input"
                                type="text"
                                placeholder={creatingInRoot === 'file' ? 'Untitled.md' : 'New folder'}
                                onKeyDown={handleRootCreate}
                                onBlur={handleRootCreateBlur}
                            />
                        </div>
                    )}
                    {fileTree.map((node) => (
                        <TreeNode
                            key={node.path}
                            node={node}
                            activeFilePath={activeFilePath}
                            onFileClick={onFileClick}
                            onCreateFile={(handle, path) => {
                                const name = prompt('Enter file name (e.g. "note.md"):');
                                if (name) onCreateFile(handle, name, path);
                            }}
                            onCreateFolder={(handle, _path) => {
                                const name = prompt('Enter folder name:');
                                if (name) onCreateFolder(handle, name);
                            }}
                            onTrash={onTrash}
                            expandedPaths={expandedPaths}
                            onToggleExpand={onToggleExpand}
                            onMoveFile={onMoveFile}
                            onRenameFile={onRenameFile}
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
