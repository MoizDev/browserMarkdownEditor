// Which folders are open in the file tree, as a store.
//
// A STORE AND NOT STATE, for the reason utils/contextMenu.ts and
// utils/entryStyleStore.ts give at length: `TreeNode` is memoized so the tree
// stops re-rendering while the reader types, and a `Set` handed down as a prop
// is a NEW object on every toggle. Every mounted row's memo then compared
// unequal — a thousand rows reconciled, each with its own hooks and
// subscriptions — to turn one chevron. Here a row subscribes to its own path
// and reads a BOOLEAN, so opening a folder re-renders that folder's row and
// the rows that appeared under it, and nothing else in the tree.
//
// One record for every vault (it always has been), persisted to localStorage.

import { readJSON, writeJSON } from './storage';

const KEY = 'expandedPaths';

let paths = new Set<string>(readJSON<string[]>(KEY, []));
/** Replaced, never mutated: `getExpandedPaths` is a `useSyncExternalStore`
 *  snapshot and has to change identity exactly when the set does. */
const listeners = new Set<() => void>();
const rowListeners = new Map<string, Set<() => void>>();

/** The whole set — for the explorer, which needs "is anything open?" and the
 *  drop rules. Identity-stable between changes. */
export function getExpandedPaths(): ReadonlySet<string> {
    return paths;
}

export function subscribeExpandedPaths(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** One folder's own answer, as a primitive — what a row subscribes to. */
export function isExpanded(path: string): boolean {
    return paths.has(path);
}

export function subscribeExpanded(path: string, listener: () => void): () => void {
    let set = rowListeners.get(path);
    if (!set) rowListeners.set(path, (set = new Set()));
    set.add(listener);
    return () => {
        set.delete(listener);
        if (!set.size) rowListeners.delete(path);
    };
}

/** Publish `next`, waking the rows whose answer actually moved and nobody
 *  else. `touched` is the paths that could have changed; a toggle names one. */
function commit(next: Set<string>, touched: Iterable<string>): void {
    const woken = new Set<() => void>();
    for (const path of touched) {
        if (paths.has(path) === next.has(path)) continue;
        const rows = rowListeners.get(path);
        if (rows) for (const row of rows) woken.add(row);
    }
    paths = next;
    writeJSON(KEY, [...next]);
    for (const row of woken) row();
    for (const listener of listeners) listener();
}

export function toggleExpanded(path: string): void {
    const next = new Set(paths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    commit(next, [path]);
}

/** Open every one of `paths` — Expand all, auto-reveal, and the New-something
 *  buttons opening the way down to their target. One commit for the lot, and
 *  nothing at all when they are already open. */
export function expandPaths(wanted: readonly string[]): void {
    if (wanted.every(p => paths.has(p))) return;
    const next = new Set(paths);
    for (const p of wanted) next.add(p);
    commit(next, wanted);
}

/** Close every one of `wanted` — Collapse all, handed THIS vault's folders.
 *  Not a blanket clear: the record covers every vault, and emptying it closed
 *  the folders of vaults the reader was not even looking at. */
export function collapsePaths(wanted: readonly string[]): void {
    if (!wanted.some(p => paths.has(p))) return;
    const next = new Set(paths);
    for (const p of wanted) next.delete(p);
    commit(next, wanted);
}

/**
 * Keep the disclosure state with the folder it describes.
 *
 * Keyed by path, so a renamed folder — and everything the reader had opened up
 * inside it — silently collapsed, which after a rename looks like the contents
 * went somewhere. It is the same folder; it answers to a new name.
 */
export function retargetExpandedPaths(fromPath: string, newPath: string): void {
    if (newPath === fromPath) return;
    const prefix = `${fromPath}/`;
    const next = new Set<string>();
    const touched: string[] = [];
    let moved = false;
    for (const path of paths) {
        if (path === fromPath || path.startsWith(prefix)) {
            const to = newPath + path.slice(fromPath.length);
            next.add(to);
            touched.push(path, to);
            moved = true;
        } else {
            next.add(path);
        }
    }
    if (!moved) return;
    commit(next, touched);
}
