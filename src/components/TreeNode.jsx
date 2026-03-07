import React, { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, FileText, FolderIcon, FilePlus, FolderPlus, Trash2, Edit2 } from './icons.jsx';

export default function TreeNode({ node, activeFilePath, onFileClick, onCreateFile, onCreateFolder, onTrash, expandedPaths, onToggleExpand, onMoveFile, onRenameFile, depth = 0 }) {
    const isActive = node.kind === 'file' && node.path === activeFilePath;
    const paddingLeft = 12 + depth * 16;
    const expanded = expandedPaths.has(node.path);
    const [dragOver, setDragOver] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(node.name);
    const renameInputRef = useRef(null);

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

    const handleRenameKeyDown = (e) => {
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
    const handleDragStart = (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'move';
        // Store the node in a module-level variable since dataTransfer can't hold objects
        TreeNode._draggedNode = node;
    };

    const handleDragOver = (e) => {
        if (node.kind !== 'directory') return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setDragOver(true);
    };

    const handleDragLeave = (e) => {
        e.stopPropagation();
        setDragOver(false);
    };

    const handleDrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);

        const draggedNode = TreeNode._draggedNode;
        if (!draggedNode) return;
        TreeNode._draggedNode = null;

        // Don't drop into itself or its own parent
        if (draggedNode.path === node.path) return;
        // Don't drop a folder into its own descendant
        if (node.path.startsWith(draggedNode.path + '/')) return;

        if (onMoveFile) {
            await onMoveFile(draggedNode, node.handle);
        }
    };

    const handleDragEnd = () => {
        TreeNode._draggedNode = null;
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
                    <FileText size={14} />
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
                            depth={depth + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// Module-level storage for the dragged node reference
TreeNode._draggedNode = null;
