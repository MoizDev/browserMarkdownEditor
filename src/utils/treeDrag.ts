import type { FileTreeNode } from '../types';

let draggedNode: FileTreeNode | null = null;

export function setDraggedNode(node: FileTreeNode | null): void {
    draggedNode = node;
}

export function takeDraggedNode(): FileTreeNode | null {
    const node = draggedNode;
    draggedNode = null;
    return node;
}

export function peekDraggedNode(): FileTreeNode | null {
    return draggedNode;
}

let reorderMode = false;

export function setTreeReorderMode(on: boolean): void {
    reorderMode = on;
}

export function isTreeReorderMode(): boolean {
    return reorderMode;
}

export type TreeDropPosition = 'before' | 'after' | 'first-child' | 'into';

export interface TreeDropTarget {
    path: string;
    position: TreeDropPosition;
}

let dropTarget: TreeDropTarget | null = null;
const dropListeners = new Set<() => void>();

export function setTreeDropTarget(next: TreeDropTarget | null): void {
    if (next === dropTarget) return;
    if (next && dropTarget && next.path === dropTarget.path && next.position === dropTarget.position) return;
    dropTarget = next;
    for (const listener of dropListeners) listener();
}

export function subscribeTreeDropTarget(listener: () => void): () => void {
    dropListeners.add(listener);
    return () => { dropListeners.delete(listener); };
}

export function getTreeDropPosition(path: string): TreeDropPosition | null {
    return dropTarget?.path === path ? dropTarget.position : null;
}
