// A "a file just finished saving" signal, as an external store.
//
// The vault-search index re-validates after every save, so that a file which was
// edited, saved and then CLOSED stops serving its pre-edit disk text. That
// signal used to be a counter in App's state, threaded down as a prop through
// FileExplorer to SearchPanel.
//
// The problem: FileExplorer is React.memo'd precisely so the whole file tree
// stops re-rendering while the user types, and every one of its other props is
// referentially stable — so this counter was the single thing defeating that
// memo, roughly once per second during continuous typing, re-rendering every
// visible row for a value only SearchPanel reads (and only while search is
// open, which is usually never).
//
// As a store, the notification reaches exactly the component that wants it.

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
