import { parentVaultPath } from './paths';
import type { TreeDropPosition } from './treeDrag';
import type { FileTreeNode } from '../types';

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

export type TreeDropSpot = TreeDropPosition | 'root-end';

export interface TreeDropPlan {
    parentPath: string;
    names: string[];
    move: boolean;
}

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
    const others = current.filter(name => name !== dragged.name);

    let at: number;
    if (spot === 'first-child') at = 0;
    else if (spot === 'into' || spot === 'root-end') at = others.length;
    else {
        const i = others.indexOf(targetPath!.slice(parentPath ? parentPath.length + 1 : 0));
        if (i === -1) return null;
        at = spot === 'before' ? i : i + 1;
    }

    const names = [...others.slice(0, at), dragged.name, ...others.slice(at)];
    if (!move && names.every((name, i) => name === current[i])) return null;
    return { parentPath, names, move };
}
