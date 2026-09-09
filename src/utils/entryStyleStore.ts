// The open vault's icons and colours — files and folders alike — as a store.
//
// A STORE AND NOT A PROP, for the reason `utils/contextMenu.ts` spells out at
// length: `FileExplorer` is `React.memo`'d and `TreeNode` memoized specifically
// so the file tree stops re-rendering while the reader types. Threading a
// styles map through the recursion would re-render EVERY visible row whenever
// any one row's icon changed — and re-render them all again on every vault
// switch — for a value each row reads exactly one entry of.
//
// The IO lives in App, which owns every filesystem call; this module holds only
// what has been read, and notifies the rows that care.

import { emptyEntryStyles, type EntryStyle, type EntryStyleFile } from './entryStyle';

let styles: EntryStyleFile = emptyEntryStyles();
const listeners = new Set<() => void>();

/** Identity-stable between changes, as `useSyncExternalStore` requires. */
export function getEntryStyles(): EntryStyleFile {
    return styles;
}

export function setEntryStyles(next: EntryStyleFile): void {
    if (next === styles) return;
    styles = next;
    for (const listener of listeners) listener();
}

export function subscribeEntryStyles(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * One entry's look.
 *
 * Returns the STORED OBJECT, not a copy, which is what lets a row subscribe to
 * this by path: the reference only changes when that folder's own entry does, so
 * every other row's `useSyncExternalStore` sees an unchanged snapshot and does
 * not re-render. Returning a fresh `{}` here would re-render the whole tree on
 * every change.
 */
export function getEntryStyle(path: string): EntryStyle | undefined {
    return styles.entries[path];
}
