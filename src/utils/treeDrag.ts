// The tree node currently being dragged — and, for the Custom sort order,
// where dropping it would land.
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

/** Read the dragged node WITHOUT consuming it — for the hover that decides
 *  where a drop would land, many times per drag. */
export function peekDraggedNode(): FileTreeNode | null {
    return draggedNode;
}

// ── Reorder mode (the sort menu's Custom) ────────────────────────────────────
//
// A flag rather than a prop because TreeNode is memoized and needs it only
// inside drag handlers, read at event time: threading it through the recursion
// would re-render every row when the sort order changes, for a value no row
// draws. FileExplorer owns it, setting it from its sort order.

let reorderMode = false;

export function setTreeReorderMode(on: boolean): void {
    reorderMode = on;
}

/** True while the tree is in Custom order, where a dragged tree node is placed
 *  by FileExplorer's delegated handlers instead of by the folder rows'. */
export function isTreeReorderMode(): boolean {
    return reorderMode;
}

// ── Where a reorder drop would land ──────────────────────────────────────────
//
// Drawn by the TARGET ROW itself (its insertion line, or the drag-over outline
// for `into`), so it is a store each row subscribes to by path and reads as a
// primitive — the activeFile pattern. `dragover` fires continuously; a pointer
// crossing from one row to the next then re-renders exactly those two rows,
// never the tree, and TreeNode's props (and so its memo) stay untouched.

/** Before or after the row, first inside an open folder, or into a folder. */
export type TreeDropPosition = 'before' | 'after' | 'first-child' | 'into';

export interface TreeDropTarget {
    path: string;
    position: TreeDropPosition;
}

let dropTarget: TreeDropTarget | null = null;
const dropListeners = new Set<() => void>();

/** Notifies only on a real change: `dragover` repeats the same target many
 *  times a second while the pointer rests. */
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

/** One row's snapshot: its own position, or null — so every other row's
 *  `useSyncExternalStore` sees an unchanged value and does not re-render. */
export function getTreeDropPosition(path: string): TreeDropPosition | null {
    return dropTarget?.path === path ? dropTarget.position : null;
}
