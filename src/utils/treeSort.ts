// The file tree's DISPLAY order, kept apart from the canonical tree.
//
// `buildFileTree` sorts once, folders first then A→Z, and everything that walks
// the vault — collectFiles, the graph, search, the bin, tab dedup — reads that
// canonical tree and must keep reading it whatever the explorer happens to show.
// So a chosen sort order never touches it: `sortTree` returns a re-ordered COPY
// for the explorer alone, and cloning is the only way to do that without
// mutating nodes those other readers hold.
//
// THE COPY MUST SHARE STRUCTURE, or it undoes the tree's memo. TreeNode is
// React.memo'd so the tree stops re-rendering while the user types, and under a
// Modified-time sort this runs again after every save (utils/fileTimes.ts
// bumps once per write). A naive clone hands every folder a fresh object each
// time, so all ~2,300 rows would re-render per autosave to move, at most, one
// file. Instead:
//   - a folder whose display order equals its canonical order is returned AS
//     ITSELF — no clone at all;
//   - otherwise its clone is cached against the source node, and handed back
//     unchanged while the source is the same object and the new child sequence
//     is element-for-element the cached one. Child identity is transitive (files
//     are never cloned, sub-folders come from this same cache), so an unchanged
//     subtree yields the very object it did last time, however deep;
//   - the root array is reused the same way.
// A save that does not change the order therefore re-renders nothing, and one
// that does re-renders only the folders on the path to the file that moved.
//
// The cache is a WeakMap keyed on source nodes: a tree refresh builds all-new
// nodes, and the old ones (with their clones) simply fall out of it.

import type { FileTreeDirNode, FileTreeNode } from '../types';

export type TreeSortOrder = 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc';

/** Every valid order, for clamping a `localStorage` read — it is user-editable. */
export const TREE_SORT_ORDERS: readonly TreeSortOrder[] = ['name-asc', 'name-desc', 'mtime-desc', 'mtime-asc'];

/** Whether this order needs file modification times (utils/fileTimes.ts). */
export function isTimeSort(order: TreeSortOrder): boolean {
    return order === 'mtime-desc' || order === 'mtime-asc';
}

export interface SortCache {
    /** Source folder node → the clone last produced for it. */
    readonly dirs: WeakMap<FileTreeDirNode, FileTreeDirNode>;
    /** The root array last produced (when it differed from the input). */
    root: FileTreeNode[] | null;
}

/** One per explorer instance, held for its life (a ref), so sharing spans calls. */
export function createSortCache(): SortCache {
    return { dirs: new WeakMap(), root: null };
}

// Exactly buildFileTree's `a.name.localeCompare(b.name, undefined, { sensitivity:
// 'base' })` — ECMA-402 defines localeCompare as that very Collator — but built
// once. With an options argument V8 builds an ICU collator per CALL: measured
// sorting 2,300 names, 44 ms that way against 1 ms here, and a time sort runs
// this over every folder after every save.
const compareNames = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

function sameSequence(a: readonly FileTreeNode[], b: readonly FileTreeNode[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * The explorer's display order for `nodes` (the canonical tree's root list).
 * Folders always come first, by name — reversed only for `name-desc`. Files
 * follow by name, or by modification time for the mtime orders, ties by name
 * A→Z. A path with NO known time sorts as the NEWEST: once a walk has landed,
 * the only such paths are files created, renamed or moved since (each a fresh
 * write on disk — moves copy), and sorting them as oldest flashed every new
 * note at the bottom of a new→old list until the next whole-vault walk. Before
 * the first walk every time is unknown, so the tree simply stays in name order.
 * Never mutates its input; see the header for what it guarantees about identity.
 */
export function sortTree(
    nodes: FileTreeNode[],
    order: TreeSortOrder,
    times: ReadonlyMap<string, number>,
    cache: SortCache,
): FileTreeNode[] {
    // buildFileTree already produced exactly this order.
    if (order === 'name-asc') return nodes;

    const byName = order === 'name-desc'
        ? (a: FileTreeNode, b: FileTreeNode) => compareNames(b.name, a.name)
        : (a: FileTreeNode, b: FileTreeNode) => compareNames(a.name, b.name);
    const fileOrder = isTimeSort(order)
        ? (a: FileTreeNode, b: FileTreeNode) => {
            const ta = times.get(a.path) ?? Infinity;
            const tb = times.get(b.path) ?? Infinity;
            if (ta !== tb) return order === 'mtime-desc' ? tb - ta : ta - tb;
            return compareNames(a.name, b.name);
        }
        : byName;
    const folderOrder = order === 'name-desc'
        ? byName
        : (a: FileTreeNode, b: FileTreeNode) => compareNames(a.name, b.name);

    const compare = (a: FileTreeNode, b: FileTreeNode): number => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.kind === 'directory' ? folderOrder(a, b) : fileOrder(a, b);
    };

    // Sub-folders are resolved (to themselves, a cached clone, or a new one)
    // BEFORE the sort, so the sequence compared below is of final identities.
    const sortList = (list: FileTreeNode[]): FileTreeNode[] =>
        list.map(child => (child.kind === 'directory' ? sortDir(child) : child)).sort(compare);

    const sortDir = (dir: FileTreeDirNode): FileTreeDirNode => {
        const children = sortList(dir.children);
        if (sameSequence(children, dir.children)) return dir;
        const cached = cache.dirs.get(dir);
        if (cached && sameSequence(children, cached.children)) return cached;
        const clone: FileTreeDirNode = { ...dir, children };
        cache.dirs.set(dir, clone);
        return clone;
    };

    const root = sortList(nodes);
    if (sameSequence(root, nodes)) return nodes;
    if (cache.root && sameSequence(root, cache.root)) return cache.root;
    cache.root = root;
    return root;
}
