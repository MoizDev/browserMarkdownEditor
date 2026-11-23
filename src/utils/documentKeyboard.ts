/**
 * "The person just opened this document from outside the panes — give it the keyboard."
 *
 * The file tree lives outside `EditorPane`, which owns the keyboard-target registry (one "take the keyboard"
 * function per open path) and the timing that hands it over once a pane has mounted. A tab-bar click already
 * goes through that; a tree click did not, so the keyboard stayed on the tree row and the first tool shortcut
 * after opening a drawing went nowhere (measured: B.drawing opened, R and D pressed, the board still on its
 * previous tool, `document.activeElement` the `.tree-file` row). A plain event, not state: nothing renders it.
 */
type Listener = (path: string) => void;
const listeners = new Set<Listener>();

export function requestDocumentKeyboard(path: string): void {
    for (const listener of [...listeners]) listener(path);
}

export function subscribeDocumentKeyboard(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
