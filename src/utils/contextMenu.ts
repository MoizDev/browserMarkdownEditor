// The app's own right-click menu, as an external store.
//
// One menu is on screen at a time, so one module-level slot describes it. The
// store shape (the same one utils/saveEpoch.ts uses) is not a stylistic choice
// here — it is what satisfies three constraints that no prop could satisfy
// together:
//
//   · src/editor/ raises this menu (a right-click inside a table cell) and knows
//     nothing about React. A module function is reachable from a DOM handler
//     hung off a CodeMirror widget; a prop is not.
//   · A widget's handlers outlive the pane that built them, so anything they
//     call must be STABLE FOR THE APP'S LIFE (AGENTS.md § Split tabs — "a state
//     outliving its pane cuts a second way"). A module-level function is; a
//     useCallback with dependencies is not, and a per-pane ref only hides the
//     staleness.
//   · FileExplorer is React.memo'd and TreeNode is memoized specifically so the
//     file tree stops re-rendering while the user types. Threading a
//     `contextTarget` prop through the recursion would re-render every visible
//     row twice per menu — once on open and once on close — for a value only one
//     row cares about. Importing this module adds no prop at all, and the "the
//     menu is on me" highlight rides on the row's OWN local state, cleared by
//     the `onClose` the row hands over with the request.

/** One clickable row. */
export interface ContextMenuCommand {
    kind: 'command';
    /** Unique within one menu; React keys the row by it. */
    id: string;
    /** A STATIC string. Never note text, never a file's contents — the menu is
     *  not an HTML sink and must not become one by accident. */
    label: string;
    run: () => void | Promise<void>;
    danger?: boolean;
    disabled?: boolean;
    /** Becomes the row's `title`. REQUIRED when `disabled` — a dead row that
     *  says nothing is indistinguishable from a broken one, which is the rule
     *  VaultMenu.messageFor states for the vault list and which holds here too. */
    reason?: string;
}

/** A row that opens a matrix size picker beside itself (Insert table…). */
export interface ContextMenuGrid {
    kind: 'grid';
    id: string;
    label: string;
    maxRows: number;
    maxCols: number;
    /** `rows` INCLUDES the header row and is always >= 2 — GFM needs a header
     *  and at least one body row, or the table stops being a table. `cols` >= 1. */
    pick: (rows: number, cols: number) => void;
    /** A grid row is disabled for the same reasons a command row is — Insert
     *  table… in Reading mode is the one that exists — and it stays on screen
     *  and says why rather than vanishing, exactly as a command does. */
    disabled?: boolean;
    /** Becomes the row's `title`. REQUIRED when `disabled`, for the reason
     *  spelled out on ContextMenuCommand.reason. */
    reason?: string;
}

export interface ContextMenuSeparator {
    kind: 'separator';
    id: string;
}

export type ContextMenuEntry = ContextMenuCommand | ContextMenuGrid | ContextMenuSeparator;

export interface ContextMenuRequest {
    /** Viewport coordinates of the click the menu hangs from. */
    x: number;
    y: number;
    entries: ContextMenuEntry[];
    /** The menu's aria-label. */
    label: string;
    /** Focus returns here on close, if it is still `isConnected`. */
    opener: HTMLElement | null;
    /** Run exactly once when the menu closes, however it closed. Lets a raiser
     *  clear its own "the menu is on me" highlight without App knowing anything
     *  about it. */
    onClose?: () => void;
}

let current: ContextMenuRequest | null = null;
const listeners = new Set<() => void>();

export function openContextMenu(request: ContextMenuRequest): void {
    // Replacing one menu with another still closes the first, so a raiser's
    // highlight is never stranded on a row whose menu is long gone.
    const previous = current;
    current = request;
    if (previous && previous !== request) previous.onClose?.();
    for (const listener of listeners) listener();
}

export function closeContextMenu(): void {
    const closing = current;
    if (!closing) return;
    // Clear FIRST, then notify the raiser: onClose reaches out of the store (it
    // clears a tree row's highlight, i.e. it setStates), and a raiser that
    // re-entered here would otherwise see a menu that is still open.
    current = null;
    closing.onClose?.();
    for (const listener of listeners) listener();
}

export function subscribeContextMenu(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Identity-stable between changes, which is what useSyncExternalStore requires:
 *  two consecutive calls with nothing in between return the same object. */
export function getContextMenu(): ContextMenuRequest | null {
    return current;
}
