import type { FileTreeDirNode, FileTreeNode } from '../types';
import { orderListFor, type EntryOrder } from './entryStyle';

export type TreeSortOrder = 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc' | 'custom';

export const TREE_SORT_ORDERS: readonly TreeSortOrder[] = ['name-asc', 'name-desc', 'mtime-desc', 'mtime-asc', 'custom'];

export function isTimeSort(order: TreeSortOrder): boolean {
    return order === 'mtime-desc' || order === 'mtime-asc';
}

export interface SortCache {
    readonly dirs: WeakMap<FileTreeDirNode, FileTreeDirNode>;
    root: FileTreeNode[] | null;
}

export function createSortCache(): SortCache {
    return { dirs: new WeakMap(), root: null };
}

const compareNames = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

function sameSequence(a: readonly FileTreeNode[], b: readonly FileTreeNode[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export function sortTree(
    nodes: FileTreeNode[],
    order: TreeSortOrder,
    times: ReadonlyMap<string, number>,
    cache: SortCache,
    customOrder: Readonly<EntryOrder>,
): FileTreeNode[] {
    if (order === 'name-asc') return nodes;
    if (order === 'custom' && Object.keys(customOrder).length === 0) return nodes;

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

    const compareIn = (folderPath: string): ((a: FileTreeNode, b: FileTreeNode) => number) | null => {
        if (order !== 'custom') return compare;
        const list = orderListFor(customOrder, folderPath);
        if (!list) return null;
        const rank = new Map(list.map((name, i) => [name, i]));
        // Unlisted ranks just past the list — a finite number, since
        // Infinity - Infinity is NaN and a NaN comparator breaks the sort.
        const unlisted = list.length;
        return (a, b) => (rank.get(a.name) ?? unlisted) - (rank.get(b.name) ?? unlisted);
    };

    const sortList = (list: FileTreeNode[], folderPath: string): FileTreeNode[] => {
        const resolved = list.map(child => (child.kind === 'directory' ? sortDir(child) : child));
        const cmp = compareIn(folderPath);
        return cmp ? resolved.sort(cmp) : resolved;
    };

    const sortDir = (dir: FileTreeDirNode): FileTreeDirNode => {
        const children = sortList(dir.children, dir.path);
        if (sameSequence(children, dir.children)) return dir;
        const cached = cache.dirs.get(dir);
        if (cached && sameSequence(children, cached.children)) return cached;
        const clone: FileTreeDirNode = { ...dir, children };
        cache.dirs.set(dir, clone);
        return clone;
    };

    const root = sortList(nodes, '');
    if (sameSequence(root, nodes)) return nodes;
    if (cache.root && sameSequence(root, cache.root)) return cache.root;
    cache.root = root;
    return root;
}
