import React, { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, FileText, FolderIcon, FilePlus, FolderPlus, Trash2, Edit2, PenTool } from './icons';
import { isDrawingFile } from '../utils/fileTypes';
import type { FileTreeNode } from '../types';

interface TreeNodeProps {
    node: FileTreeNode;
    activeFilePath: string | null;
    onFileClick: (node: FileTreeNode) => void;
    onCreateFile: (handle: FileSystemDirectoryHandle, path: string) => void;
    onCreateFolder: (handle: FileSystemDirectoryHandle, path: string) => void;
    onTrash: (node: FileTreeNode) => void;
    expandedPaths: Set<string>;
    onToggleExpand: (path: string) => void;
    onMoveFile: (sourceNode: FileTreeNode, targetDirHandle: FileSystemDirectoryHandle, targetPath?: string) => Promise<boolean>;
    onRenameFile: (node: FileTreeNode, newName: string) => void | Promise<void>;
    /** Copy files dragged in from the OS into `targetDir`. */
    onImportFiles: (files: FileList | File[], targetDir: FileSystemDirectoryHandle) => Promise<string[]>;
    depth?: number;
}

/**
 * Shape of the module-level static drag-state stashed on the TreeNode function
 * component (dataTransfer can't hold object references). Exported so FileExplorer
 * (same bucket) reads/writes `TreeNode._draggedNode` through the same typed view.
 */
export interface TreeNodeStatic {
    _draggedNode: FileTreeNode | null;
}

export default function TreeNode({ node, activeFilePath, onFileClick, onCreateFile, onCreateFolder, onTrash, expandedPaths, onToggleExpand, onMoveFile, onRenameFile, onImportFiles, depth = 0 }: TreeNodeProps) {
    const isActive = node.kind === 'file' && node.path === activeFilePath;
    const paddingLeft = 12 + depth * 16;
    const expanded = expandedPaths.has(node.path);
    const [dragOver, setDragOver] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(node.name);
    const renameInputRef = useRef<HTMLInputElement | null>(null);

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

    // ── Drag handlers ──
    const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
        // Store the node in a module-level variable since dataTransfer can't hold objects
        (TreeNode as unknown as TreeNodeStatic)._draggedNode = node;
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (node.kind !== 'directory') return;
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

        const draggedNode = (TreeNode as unknown as TreeNodeStatic)._draggedNode;
        if (!draggedNode) return;
        (TreeNode as unknown as TreeNodeStatic)._draggedNode = null;

        // Don't drop into itself or its own parent
        if (draggedNode.path === node.path) return;
        // Don't drop a folder into its own descendant
        if (node.path.startsWith(draggedNode.path + '/')) return;

        if (onMoveFile) {
            await onMoveFile(draggedNode, node.handle as FileSystemDirectoryHandle, node.path);
        }
    };

    const handleDragEnd = () => {
        (TreeNode as unknown as TreeNodeStatic)._draggedNode = null;
    };

    if (node.kind === 'file') {
        return (
            <div
                className={`tree-item tree-file${isActive ? ' is-active' : ''}`}
                style={{ paddingLeft }}
                onClick={() => { if (!isRenaming) onFileClick(node); }}
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
                className={`tree-item tree-folder${dragOver ? ' drag-over' : ''}`}
                style={{ paddingLeft }}
                onClick={() => { if (!isRenaming) onToggleExpand(node.path); }}
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
                            onClick={(e) => { e.stopPropagation(); onCreateFile(node.handle, node.path); }}
                        >
                            <FilePlus size={14} />
                        </button>
                        <button
                            className="tree-action-btn"
                            title="New folder"
                            onClick={(e) => { e.stopPropagation(); onCreateFolder(node.handle, node.path); }}
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
            {expanded && node.children && (
                <div className="tree-children">
                    {node.children.map((child) => (
                        <TreeNode
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

// Module-level storage for the dragged node reference
(TreeNode as unknown as TreeNodeStatic)._draggedNode = null;
