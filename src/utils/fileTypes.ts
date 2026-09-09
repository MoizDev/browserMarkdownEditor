// Which editor a file opens in: `.tldraw` and `.notebook` files render as a
// tldraw canvas, everything else textual goes to CodeMirror.
//
// Deliberately separate from vaultSearch's isTextFile(): both canvas kinds ARE
// text on disk (they're JSON snapshots), so they must keep flowing through the
// normal readFile/writeFile/autosave path. They just must not be *shown* as
// text, nor content-indexed by search.

export const DRAWING_EXT = '.tldraw';

/** A notebook is a drawing on ruled pages, with an export to PDF. Its own
 *  extension rather than a flag inside a `.tldraw`, so the file tree can say
 *  which is which and "New notebook" makes something unambiguous. */
export const NOTEBOOK_EXT = '.notebook';

export function isDrawingFile(name: string): boolean {
    return name.toLowerCase().endsWith(DRAWING_EXT);
}

export function isNotebookFile(name: string): boolean {
    return name.toLowerCase().endsWith(NOTEBOOK_EXT);
}

/** Either kind of tldraw-backed document: a canvas rather than a text editor. */
export function isCanvasFile(name: string): boolean {
    return isDrawingFile(name) || isNotebookFile(name);
}

/** Append `.tldraw` unless the user already typed it. */
export function ensureDrawingExt(name: string): string {
    return isDrawingFile(name) ? name : `${name}${DRAWING_EXT}`;
}

/** Append `.notebook` unless the user already typed it. */
export function ensureNotebookExt(name: string): string {
    return isNotebookFile(name) ? name : `${name}${NOTEBOOK_EXT}`;
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

/** "Assignment.pdf" -> "Assignment". Exported so the notebook a PDF came from
 *  can be looked for beside it by name, when the stored path has gone stale. */
export function stripPdfExt(name: string): string {
    return isPdfFile(name) ? stripExt(name) : name;
}

/** "Assignment 3.notebook" -> "Assignment 3.pdf", the file Export writes. */
export function notebookPdfName(name: string): string {
    return `${isNotebookFile(name) ? name.slice(0, -NOTEBOOK_EXT.length) : name}${PDF_EXT}`;
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
