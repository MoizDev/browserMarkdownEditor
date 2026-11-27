import type { FileTreeNode, FileTreeDirNode } from '../types';

export function shareTree(old: FileTreeNode[], next: FileTreeNode[]): FileTreeNode[] {
    return shareList(old, next, undefined);
}

function shareList(old: FileTreeNode[], next: FileTreeNode[], parent: FileSystemDirectoryHandle | undefined): FileTreeNode[] {
    if (old === next) return old;
    let byName: Map<string, FileTreeNode> | undefined;
    const out: FileTreeNode[] = new Array(next.length);
    let same = old.length === next.length;

    for (let i = 0; i < next.length; i++) {
        const n = next[i];
        let o: FileTreeNode | undefined = old[i];
        if (!o || o.name !== n.name) {
            byName ??= new Map(old.map(x => [x.name, x]));
            o = byName.get(n.name);
        }
        let r = o ? shareNode(o, n) : n;
        if (parent && r.parentHandle !== parent) r = { ...r, parentHandle: parent } as FileTreeNode;
        out[i] = r;
        if (r !== old[i]) same = false;
    }
    return same ? old : out;
}

function shareNode(o: FileTreeNode, n: FileTreeNode): FileTreeNode {
    if (o === n) return o;
    if (o.kind !== n.kind || o.name !== n.name || o.path !== n.path) return n;
    if (o.kind === 'file') return o;
    const nd = n as FileTreeDirNode;
    const children = shareList(o.children, nd.children, o.handle);
    return children === o.children ? o : { ...nd, handle: o.handle, children };
}

export function findDirNode(root: FileTreeNode[], dirPath: string): FileTreeDirNode | null {
    if (!dirPath) return null;
    let level = root;
    let found: FileTreeDirNode | null = null;
    for (const name of dirPath.split('/')) {
        const hit: FileTreeNode | undefined = level.find(c => c.name === name);
        if (!hit || hit.kind !== 'directory') return null;
        found = hit;
        level = hit.children;
    }
    return found;
}

export function spliceDir(root: FileTreeNode[], dirPath: string, newChildren: FileTreeNode[]): FileTreeNode[] {
    if (!dirPath) return newChildren;
    return spliceInto(root, dirPath.split('/'), 0, newChildren);
}

function spliceInto(level: FileTreeNode[], names: string[], depth: number, newChildren: FileTreeNode[]): FileTreeNode[] {
    const idx = level.findIndex(c => c.name === names[depth]);
    const hit = idx === -1 ? undefined : level[idx];
    if (!hit || hit.kind !== 'directory') return level;
    const children = depth === names.length - 1
        ? newChildren
        : spliceInto(hit.children, names, depth + 1, newChildren);
    if (children === hit.children) return level;
    const out = level.slice();
    out[idx] = { ...hit, children };
    return out;
}
