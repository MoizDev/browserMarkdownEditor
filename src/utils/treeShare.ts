// Structural sharing for the file tree.
//
// `buildFileTree` mints a brand-new node for every entry on every walk, so a
// refresh that changed NOTHING still handed React a tree where every row's
// props differed: `React.memo(TreeNode)` (which exists so the tree stops
// re-rendering while the user types) compared unequal on all of them, and every
// effect keyed on `fileTree` (graph, vault search, fileTimes, the idle prefetch)
// re-ran. `shareTree` puts the old nodes back wherever nothing about them
// changed, so a refresh costs exactly what actually differs:
//   * nothing changed          → the very same root array (no state change at all);
//   * one file added somewhere → new objects along that file's spine only.
//
// "Nothing changed" is name + kind + path + (recursively) children. The HANDLE
// is deliberately not compared: a FileSystemHandle is path-based (it names a
// location, not an inode — on local disk and in OPFS alike), so an old node's
// handle stays valid for a file that was replaced in place (every createWritable
// is a swap + rename) and an unchanged node keeps resolving. What matters is
// that handles stay CONSISTENT with each other, below.
//
// THE HANDLE-IDENTITY INVARIANT: a node's `parentHandle` is the very object that
// is its parent node's `handle`. FileSystemContext.moveFile once tested "already
// in that folder" with `parentHandle === targetDirHandle`; a tree in which a
// re-created directory node carried a NEW handle while its kept children still
// pointed at the OLD one would make that test false for a drop onto the folder
// the file already sits in — and the move that follows copies a file onto itself
// and then removes it. So a changed directory keeps its OLD handle, and any
// child that is new to it is re-pointed at that handle. (moveFile also uses
// isSameEntry now; this keeps every OTHER identity-minded reader right too.)
//
// Pure: no DOM, no React.

import type { FileTreeNode, FileTreeDirNode } from '../types';

/** `next`, with every unchanged node replaced by its `old` counterpart. Returns
 *  `old` itself (reference-equal) when nothing differs. `old` is never mutated.
 *
 *  Cost is O(nodes that are new or changed) plus one name comparison per child of
 *  every directory that was RE-LISTED: reused subtrees (`o === n`, which is what
 *  `spliceDir` and the watcher's re-list produce for untouched folders) are
 *  skipped whole. A full-vault walk compares everything once — a few ms per
 *  thousand nodes, with no I/O. */
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
        // Both lists are sorted the same way, so an unchanged directory matches
        // by position; the name index is built only once an insertion or a
        // removal shifts things.
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

/** The directory node at `dirPath` ('' = none: the root has no node), or null. */
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

/**
 * `root` with the children of the directory at `dirPath` replaced by
 * `newChildren` ('' replaces the root list). Path-copying: only the spine from
 * the root down to that directory is re-created; every sibling subtree keeps its
 * identity. Returns `root` itself when `dirPath` names nothing in it (a folder
 * that vanished, or one a parent's re-list has not produced yet) — a no-op, never
 * an error.
 */
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
