// Which editor a file opens in: `.tldraw` files render as a tldraw whiteboard,
// everything else textual goes to CodeMirror.
//
// Deliberately separate from vaultSearch's isTextFile(): a drawing IS text on
// disk (it's a JSON snapshot), so it must keep flowing through the normal
// readFile/writeFile/autosave path. It just must not be *shown* as text, nor
// content-indexed by search.

export const DRAWING_EXT = '.tldraw';

export function isDrawingFile(name: string): boolean {
    return name.toLowerCase().endsWith(DRAWING_EXT);
}

/** Append `.tldraw` unless the user already typed it. */
export function ensureDrawingExt(name: string): string {
    return isDrawingFile(name) ? name : `${name}${DRAWING_EXT}`;
}
