// The attachment names the app's PDFs are defined by, shared between the writer
// (pdfBuild.ts, pdf-lib) and the reader (pdfAnnotation.ts, pdf.js).
//
// Their own module ON PURPOSE. Either side importing the other would drag that
// side's PDF library along with these few strings: the reader runs on the main
// thread, so importing the writer would put ~400kB of pdf-lib in the UI bundle,
// and the writer runs in a DOM-less worker that must not see pdf.js at all.

/** Pristine, unannotated source PDF. Every save rebuilds from this. */
export const ORIGINAL_ATTACHMENT = 'original.pdf';

/** tldraw snapshot: the editable form of the strokes stamped on the pages. */
export const SNAPSHOT_ATTACHMENT = 'tldraw-snapshot.json';

/**
 * The notebook a PDF was exported from — present on exports, absent on
 * everything else.
 *
 * An exported PDF is an OUTPUT, and its notebook is the thing you actually
 * edit. Without this the two were strangers on disk: annotating
 * "Assignment.pdf" fell into the ordinary PDF flow and produced a third file,
 * "Assignment (annotated).pdf", whose strokes the notebook knew nothing about
 * and which the next export would not touch. Carrying the source path lets the
 * app send you back to the notebook instead.
 */
export const NOTEBOOK_SOURCE_ATTACHMENT = 'notebook-source.json';

/** What that attachment holds. The path is vault-root-relative, like every
 *  other path in the app (see utils/paths.ts). */
export interface NotebookSource {
    path: string;
    /** ms epoch, purely so a human opening the file can see how old it is. */
    exportedAt: number;
}
