// "Open an inline name box in THIS folder" — as an external store.
//
// One name box is open at a time, so one module-level slot describes it, and the
// row that owns it reads the slot rather than being handed a prop. The reason is
// the one `utils/contextMenu.ts` sets out at length: `FileExplorer` is
// `React.memo`'d and `TreeNode` memoized specifically so the tree stops
// re-rendering while the reader types, and the toolbar's New note button has to
// reach a row several levels down the recursion. A `creatingIn` prop would have
// to travel every level and re-render every visible row for a value exactly one
// of them cares about.
//
// It also replaced the state it addresses. Before this, a folder's own "New
// note" used local row state while the header's button used FileExplorer's —
// two implementations of one name box, and only one of them reachable from the
// toolbar. Now both raise a request and whichever row matches renders the box.

import { ensureDrawingExt, ensureNotebookExt } from './fileTypes';

/** What the name box is about to make. The last two differ from `file` only in
 *  the extension forced onto the typed name — see utils/fileTypes.ts. */
export type CreateKind = 'file' | 'folder' | 'notebook' | 'drawing';

export interface CreateRequest {
    /** Vault path of the folder to create in. `''` is the vault root. */
    path: string;
    kind: CreateKind;
}

let current: CreateRequest | null = null;
const listeners = new Set<() => void>();

export function requestCreate(path: string, kind: CreateKind): void {
    current = { path, kind };
    for (const listener of listeners) listener();
}

export function clearCreateRequest(): void {
    if (!current) return;
    current = null;
    for (const listener of listeners) listener();
}

export function subscribeCreateRequest(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * The kind of thing this folder is being asked to create, or null.
 *
 * Returns a STRING, not the request object, and that is what makes a
 * per-row subscription cheap: every other row's snapshot is `null` on both
 * sides of any change, so `useSyncExternalStore` sees no difference and does
 * not re-render them.
 */
export function getCreateKindFor(path: string): CreateKind | null {
    return current && current.path === path ? current.kind : null;
}

/** Every folder that must be open for `path` to be on screen: for `a/b/c`,
 *  `a` then `a/b` then `a/b/c`. The row cannot expand its own ancestors — it is
 *  not rendered until they already are. */
export function ancestorsOf(path: string): string[] {
    if (!path) return [];
    const parts = path.split('/');
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * The extension a kind forces onto the typed name. `folder` never reaches here —
 * a folder is made by a different call — and `file` takes the name as typed,
 * since a note may legitimately be anything the editor can open.
 */
export function nameForKind(kind: CreateKind | null, name: string): string {
    if (kind === 'notebook') return ensureNotebookExt(name);
    if (kind === 'drawing') return ensureDrawingExt(name);
    return name;
}

/** What the empty name box suggests. Lives beside `nameForKind` so the hint and
 *  the extension actually applied cannot drift apart. */
export function placeholderFor(kind: CreateKind | null): string {
    switch (kind) {
        case 'notebook': return 'Untitled.notebook';
        case 'drawing': return 'Untitled.tldraw';
        case 'folder': return 'New folder';
        default: return 'Untitled.md';
    }
}
