/**
 * Escape-to-dismiss for the app's non-modal floating surfaces (the backlinks
 * popover, the vault menu): one press closes one thing.
 *
 * - ONE `keydown` listener on `document`, in the BUBBLE phase, so whatever has
 *   the keyboard gets its turn first — CodeMirror's keymap (search panel,
 *   autocomplete, a selection collapse) runs on its own DOM, React's handlers
 *   (a rename field) at `#root`, both below `document`.
 * - An Escape already `defaultPrevented` belongs to that thing, not to a
 *   surface: #36 — ⌘F's bar and the backlinks popover closed on the same press.
 *   So anything that consumes Escape must `preventDefault()` it.
 * - A STACK rather than a listener per surface: listeners on one target fire in
 *   registration order, so per-surface listeners each checking
 *   `defaultPrevented` closed the OLDEST open surface first. Only the most
 *   recently registered (= opened) one is dismissed, and the press is then
 *   prevented, so nothing further out treats it as unhandled either.
 * - `isComposing`: an Escape during IME composition cancels the composition.
 *
 * A surface drawn over CodeMirror, or a modal, must win outright instead —
 * capture phase, prevented AND stopped (ContextMenu, ConfirmDialog); this
 * bubble-phase stack is wrong for those.
 */

const stack: Array<() => void> = [];

function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    const top = stack[stack.length - 1];
    if (!top) return;
    e.preventDefault();
    top();
}

/** Register `onDismiss` to run on the next unhandled Escape while this surface
 *  is the most recently opened one. Call it when the surface opens (in the
 *  effect that opens it — registration order IS the stacking order); the
 *  returned unsubscriber goes in that effect's cleanup and is idempotent, so
 *  StrictMode's register → unregister → register leaves exactly one entry. */
export function dismissOnEscape(onDismiss: () => void): () => void {
    // A fresh wrapper per registration: two callers passing the same function
    // still get distinct entries, and unregistering removes only its own.
    const entry = () => onDismiss();
    stack.push(entry);
    if (stack.length === 1) document.addEventListener('keydown', onKeyDown);
    return () => {
        const i = stack.lastIndexOf(entry);
        if (i < 0) return;
        stack.splice(i, 1);
        if (stack.length === 0) document.removeEventListener('keydown', onKeyDown);
    };
}
