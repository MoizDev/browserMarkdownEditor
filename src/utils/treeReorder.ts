// Where a drag in the Custom-ordered file tree lands, and the folder order that
// results. Pure — no DOM, no React: FileExplorer measures the pointer against a
// row and hands the answer here, which decides whether that drop means anything.
//
// A drop always yields the destination folder's WHOLE display order, dragged
// name placed, rather than a delta: what the user saw is what gets stored, so a
// folder's unlisted children are frozen where they stood the first time anything
// in it is moved, and stale names from an older list are dropped on the way.

import { parentVaultPath } from './paths';
import type { TreeDropPosition } from './treeDrag';
import type { FileTreeNode } from '../types';

/** The display tree, indexed for a drag: every node by path, and every folder's
 *  children in display order ('' = the vault root). */
export interface TreeIndex {
    byPath: Map<string, FileTreeNode>;
    childrenOf: Map<string, readonly FileTreeNode[]>;
}

export function indexTree(nodes: readonly FileTreeNode[]): TreeIndex {
    const byPath = new Map<string, FileTreeNode>();
    const childrenOf = new Map<string, readonly FileTreeNode[]>([['', nodes]]);
    const walk = (list: readonly FileTreeNode[]) => {
        for (const node of list) {
            byPath.set(node.path, node);
            if (node.kind === 'directory') {
                childrenOf.set(node.path, node.children);
                walk(node.children);
            }
        }
    };
    walk(nodes);
    return { byPath, childrenOf };
}

/** Relative to a row, or `root-end` — empty space below the rows, which means
 *  the end of the vault root. */
export type TreeDropSpot = TreeDropPosition | 'root-end';

export interface TreeDropPlan {
    /** The folder the dragged node ends up in ('' = the vault root). */
    parentPath: string;
    /** That folder's child names in their new order. */
    names: string[];
    /** True when the node changes folder — a real move on disk. */
    move: boolean;
}

/**
 * What dropping `dragged` at `spot` on the row at `targetPath` would do, or null
 * when it would do nothing or cannot be done — the caller shows no indicator
 * then, and a drop there is ignored.
 *
 * Refused: a folder into itself or anything inside it; `into` the folder the
 * node already sits in; any spot that leaves its folder's order as it is; and,
 * across folders, a spot beside a sibling that shares the dragged node's name
 * (the move would overwrite that very sibling — moveFile's rule on a taken name
 * — so "beside it" has no meaning).
 */
export function planTreeDrop(
    index: TreeIndex,
    dragged: FileTreeNode,
    targetPath: string | null,
    spot: TreeDropSpot,
): TreeDropPlan | null {
    let parentPath: string;
    if (spot === 'root-end') parentPath = '';
    else if (targetPath === null) return null;
    else if (spot === 'into' || spot === 'first-child') parentPath = targetPath;
    else parentPath = parentVaultPath(targetPath);

    if (dragged.kind === 'directory'
        && (parentPath === dragged.path || parentPath.startsWith(`${dragged.path}/`))) return null;

    const move = parentPath !== parentVaultPath(dragged.path);
    if (spot === 'into' && !move) return null;

    const current = (index.childrenOf.get(parentPath) ?? []).map(n => n.name);
    // The dragged node's own slot when it stays in this folder; the sibling it
    // would overwrite when it arrives from another.
    const others = current.filter(name => name !== dragged.name);

    let at: number;
    if (spot === 'first-child') at = 0;
    else if (spot === 'into' || spot === 'root-end') at = others.length;
    else {
        const i = others.indexOf(targetPath!.slice(parentPath ? parentPath.length + 1 : 0));
        if (i === -1) return null;       // the dragged row itself, or the sibling it would overwrite
        at = spot === 'before' ? i : i + 1;
    }

    const names = [...others.slice(0, at), dragged.name, ...others.slice(at)];
    if (!move && names.every((name, i) => name === current[i])) return null;
    return { parentPath, names, move };
}
