// A "a file just finished saving" signal, as an external store.
//
// The search index now primes successful writes with their text and version
// before publishing its own revision; a closed edited note needs no forced
// disk re-read. This legacy notification used to be App state, threaded as a
// prop through FileExplorer to SearchPanel.
//
// The problem: FileExplorer is React.memo'd precisely so the whole file tree
// stops re-rendering while the user types, and every one of its other props is
// referentially stable — so this counter was the single thing defeating that
// memo, roughly once per second during continuous typing, re-rendering every
// visible row for a value only SearchPanel reads (and only while search is
// open, which is usually never).
//
// As a store, the notification reaches only subscribers, without becoming a
// prop that defeats the tree's memoization.

let epoch = 0;
const listeners = new Set<() => void>();

/** Called after each completed save-flush. */
export function bumpSaveEpoch(): void {
    epoch++;
    for (const listener of listeners) listener();
}

export function subscribeSaveEpoch(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSaveEpoch(): number {
    return epoch;
}
