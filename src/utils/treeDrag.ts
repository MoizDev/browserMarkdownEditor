// The tree node currently being dragged.
//
// HTML5 dataTransfer can only carry strings, so the node object itself has to be
// parked somewhere both the drag source (TreeNode) and every drop target
// (TreeNode's folders, and FileExplorer's root container) can reach.
//
// Its own module rather than a property on the TreeNode component: TreeNode is
// wrapped in React.memo, so the inner function and the exported wrapper are two
// different objects and a static hung off "the component" is ambiguous about
// which one it lands on. A module variable has exactly one identity.

import type { FileTreeNode } from '../types';

let draggedNode: FileTreeNode | null = null;

export function setDraggedNode(node: FileTreeNode | null): void {
    draggedNode = node;
}

/** Read the dragged node and clear it in one step — a drop consumes it. */
export function takeDraggedNode(): FileTreeNode | null {
    const node = draggedNode;
    draggedNode = null;
    return node;
}
