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

/* ── PDFs ────────────────────────────────────────────────────────────────
 * A PDF opens in a pane with two modes: View (the real PDF — scrollable,
 * text selectable) and Annotate (a tldraw canvas over rasterized pages).
 * Annotating spawns a sibling "<name> (annotated).pdf", which is a genuine
 * PDF — strokes stamped onto the pages — that also carries the pristine
 * original and the tldraw snapshot as embedded attachments, so it opens in
 * any viewer AND stays editable here. See utils/pdfAnnotation.ts.
 * ──────────────────────────────────────────────────────────────────────── */

export const PDF_EXT = '.pdf';
export const ANNOTATED_SUFFIX = ' (annotated)';

export function isPdfFile(name: string): boolean {
    return name.toLowerCase().endsWith(PDF_EXT);
}

/** True for files this app produced, i.e. "Physics exercise 2 (annotated).pdf". */
export function isAnnotatedPdf(name: string): boolean {
    return isPdfFile(name) && stripExt(name).toLowerCase().endsWith(ANNOTATED_SUFFIX.toLowerCase());
}

function stripExt(name: string): string {
    return name.slice(0, -PDF_EXT.length);
}

/**
 * "Physics exercise 2.pdf" -> "Physics exercise 2 (annotated).pdf".
 *
 * Idempotent: an already-annotated name is returned unchanged, so re-entering
 * annotate mode edits that file in place instead of spawning
 * "… (annotated) (annotated).pdf".
 */
export function annotatedNameFor(name: string): string {
    if (isAnnotatedPdf(name)) return name;
    return `${stripExt(name)}${ANNOTATED_SUFFIX}${PDF_EXT}`;
}
