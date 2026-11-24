// Which document is on screen, as an external store.
//
// A PROP FOR THIS IS THE EXPENSIVE KIND. `activeFilePath` travelled the whole
// TreeNode recursion, so switching tabs changed a prop on EVERY row and
// re-rendered all of them — measured at 440 rows of work to move a highlight
// between two of them, and a vault of 2,300 rows pays that on every tab click.
// The memo on TreeNode could not help: the prop really had changed.
//
// Read as a BOOLEAN per row instead. `useActiveFile(path)` answers "is this row
// the active one", so a switch changes the snapshot for exactly the two rows
// whose answer moved and every other row's `useSyncExternalStore` sees `false`
// before and `false` after. Same reasoning as utils/contextMenu.ts, and the
// same shape.

let activePath: string | null = null;
const listeners = new Set<() => void>();

export function setActiveFilePath(path: string | null): void {
    if (path === activePath) return;
    activePath = path;
    for (const listener of listeners) listener();
}

/** The open document's vault path, for code that wants the value rather than a
 *  subscription — read at the moment it is needed (a click), not per render. */
export function getActiveFilePath(): string | null {
    return activePath;
}

export function subscribeActiveFile(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** A boolean snapshot, which is what keeps a switch from re-rendering the tree:
 *  only the rows whose answer actually changed see a different value. */
export function isActiveFilePath(path: string): boolean {
    return activePath === path;
}
