import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import TreeNode from './TreeNode';
import { takeDraggedNode } from '../utils/treeDrag';
import SearchPanel from './SearchPanel';
import VaultMenu from './VaultMenu';
import { FilePlus, FolderPlus, FolderOpen, Search, PenTool, PanelLeft } from './icons';
import { ensureDrawingExt } from '../utils/fileTypes';
import { createVaultTextCache } from '../utils/vaultSearch';
import type { VaultTextCache } from '../utils/vaultSearch';
import type { FileTreeNode, FileTreeFileNode, RecentVault, TextRange, VaultOpenResult } from '../types';

/**
 * True when the drag carries OS files rather than a tree node being moved.
 * `types` is readable during dragover (where `files` is deliberately empty for
 * privacy), so it's the only reliable signal at that point.
 */
function isExternalFileDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes('Files');
}

/* The vault menu hangs from the right edge of the vault button, which sits in
   the sidebar — so the room it has to grow into is everything from the left of
   the screen to that edge. Its width is content-driven (vault names vary), and
   left unbounded a long folder name pushed the whole menu off the left of the
   viewport with its shorter rows rendering outside the window entirely. */
const VAULT_MENU_MARGIN = 8;
const VAULT_MENU_MIN_WIDTH = 200;
const VAULT_MENU_MAX_WIDTH = 340;

interface VaultMenuPos { top: number; right: number; minWidth: number; maxWidth: number }

function vaultMenuPosFor(button: HTMLElement): VaultMenuPos {
    const r = button.getBoundingClientRect();
    const room = Math.max(0, Math.round(r.right - VAULT_MENU_MARGIN));
    return {
        top: Math.round(r.bottom + 6),
        right: Math.max(VAULT_MENU_MARGIN, Math.round(window.innerWidth - r.right)),
        minWidth: Math.min(VAULT_MENU_MIN_WIDTH, room),
        maxWidth: Math.min(VAULT_MENU_MAX_WIDTH, room),
    };
}

interface FileExplorerProps {
    rootHandle: FileSystemDirectoryHandle | null;
    fileTree: FileTreeNode[];
    activeFilePath: string | null;
    onFileClick: (node: FileTreeNode) => void;
    onCreateFile: (parentHandle: FileSystemDirectoryHandle | null, name: string, parentPath?: string) => void | Promise<void>;
    onCreateFolder: (parentHandle: FileSystemDirectoryHandle | null, name: string) => void | Promise<void>;
    /** Open the native folder picker — a double-click on the vault button. */
    onChangeVault: () => void;
    /** Folders previously opened as vaults, newest first (already labelled). */
    recentVaults: RecentVault[];
    /** Which of those is open right now, so the menu can mark it. */
    currentVaultId: string | null;
    /** How many of them the menu lists (Settings → Vault). */
    recentVaultLimit: number;
    onOpenRecentVault: (vault: RecentVault) => Promise<VaultOpenResult>;
    onCollapse: () => void;
    onTrash: (node: FileTreeNode) => void;
    expandedPaths: Set<string>;
    onToggleExpand: (path: string) => void;
    onMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
    onRenameFile: (node: FileTreeNode, newName: string) => void | Promise<void>;
    /** Copy files dragged in from the OS into `targetDir`. */
    onImportFiles: (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => Promise<string[]>;
    onOpenSearchResult: (node: FileTreeFileNode, range: TextRange | null) => void;
    getOpenTabContent: (path: string) => string | null;
}

function FileExplorer({
    rootHandle,
    fileTree,
    activeFilePath,
    onFileClick,
    onCreateFile,
    onCreateFolder,
    onChangeVault,
    recentVaults,
    currentVaultId,
    recentVaultLimit,
    onOpenRecentVault,
    onCollapse,
    onTrash,
    expandedPaths,
    onToggleExpand,
    onMoveFile,
    onRenameFile,
    onImportFiles,
    onOpenSearchResult,
    getOpenTabContent,
}: FileExplorerProps) {
    // 'drawing' creates a .tldraw whiteboard; it differs from 'file' only in the
    // extension it forces onto the typed name.
    const [creatingInRoot, setCreatingInRoot] = useState<'file' | 'folder' | 'drawing' | null>(null);
    const [rootDragOver, setRootDragOver] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // ── Vault menu ──────────────────────────────────────────────────────────
    const [vaultMenuPos, setVaultMenuPos] = useState<VaultMenuPos | null>(null);
    const vaultBtnRef = useRef<HTMLButtonElement | null>(null);

    const listedVaults = useMemo(
        () => recentVaults.slice(0, recentVaultLimit),
        [recentVaults, recentVaultLimit]
    );

    const closeVaultMenu = useCallback(() => setVaultMenuPos(null), []);

    /**
     * One click lists the vaults already known; two goes to the folder picker.
     *
     * `detail` counts the clicks in the current burst, so the second click of a
     * double-click is caught without delaying the first — waiting out the
     * double-click interval before showing the list would make the ordinary
     * case, picking a vault you already have, feel like the slow one. Keyboard
     * activation reports 0 and lists, which is the only thing it can do.
     */
    const handleVaultButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (e.detail >= 2) {
            setVaultMenuPos(null);
            onChangeVault();
            return;
        }
        if (vaultMenuPos) { setVaultMenuPos(null); return; }
        // Nothing to list (a first run, or the setting is off) — don't make the
        // user open an empty menu to get to the picker.
        if (listedVaults.length === 0) { onChangeVault(); return; }
        if (vaultBtnRef.current) setVaultMenuPos(vaultMenuPosFor(vaultBtnRef.current));
    };

    const browseForVault = useCallback(() => {
        setVaultMenuPos(null);
        onChangeVault();
    }, [onChangeVault]);

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
    const startCreateInRoot = (kind: 'file' | 'folder' | 'drawing') => {
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
            if (creatingInRoot === 'drawing') {
                await onCreateFile(rootHandle, ensureDrawingExt(name), '');
            } else if (creatingInRoot === 'file') {
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

    // Stable identities: these are passed to every TreeNode, so an inline arrow
    // here would give each row a fresh prop on every explorer render and defeat
    // TreeNode's memo entirely.
    const promptCreateFile = useCallback((handle: FileSystemDirectoryHandle, path: string) => {
        const name = prompt('Enter file name (e.g. "note.md"):');
        if (name) onCreateFile(handle, name, path);
    }, [onCreateFile]);

    const promptCreateFolder = useCallback((handle: FileSystemDirectoryHandle) => {
        const name = prompt('Enter folder name:');
        if (name) onCreateFolder(handle, name);
    }, [onCreateFolder]);

    // Root-level drop handlers — use a counter to reliably track enter/leave
    const dragCounterRef = useRef(0);

    const handleRootDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        dragCounterRef.current++;
        setRootDragOver(true);
    };

    const handleRootDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        // Files dragged from the OS are copied in, not moved out of the vault —
        // showing 'move' would promise Explorer we're removing their original.
        e.dataTransfer.dropEffect = isExternalFileDrag(e) ? 'copy' : 'move';
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
                        title="New drawing"
                        onClick={() => startCreateInRoot('drawing')}
                    >
                        <PenTool size={15} />
                    </button>
                    <button
                        className="nav-action-btn"
                        title="New folder"
                        onClick={() => startCreateInRoot('folder')}
                    >
                        <FolderPlus size={15} />
                    </button>
                    <button
                        ref={vaultBtnRef}
                        className={`nav-action-btn vault-menu-toggle${vaultMenuPos ? ' active' : ''}`}
                        title="Open another vault — double-click to browse for a folder"
                        aria-label="Open another vault"
                        aria-haspopup="menu"
                        aria-expanded={vaultMenuPos !== null}
                        onClick={handleVaultButtonClick}
                    >
                        <FolderOpen size={15} />
                    </button>
                    <button
                        className="nav-action-btn"
                        title="Collapse sidebar (⌘\)"
                        onClick={onCollapse}
                    >
                        <PanelLeft size={15} />
                    </button>
                </div>
            </div>

            {vaultMenuPos && (
                <VaultMenu
                    anchor={vaultBtnRef.current}
                    style={vaultMenuPos}
                    vaults={listedVaults}
                    currentVaultId={currentVaultId}
                    onOpen={onOpenRecentVault}
                    onBrowse={browseForVault}
                    onClose={closeVaultMenu}
                />
            )}

            {searchOpen ? (
                <SearchPanel
                    fileTree={fileTree}
                    cache={searchCache}
                    getOpenTabContent={getOpenTabContent}
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
                                placeholder={
                                    creatingInRoot === 'file' ? 'Untitled.md'
                                        : creatingInRoot === 'drawing' ? 'Untitled.tldraw'
                                            : 'New folder'
                                }
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
                            onCreateFile={promptCreateFile}
                            onCreateFolder={promptCreateFolder}
                            onTrash={onTrash}
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
