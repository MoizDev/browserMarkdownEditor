// The two attachment names that define the annotated-PDF format, shared by the
// writer (pdfBuild.ts, pdf-lib) and the reader (pdfAnnotation.ts, pdf.js).
//
// Their own module ON PURPOSE. Either side importing the other would drag that
// side's PDF library along with these two strings: the reader runs on the main
// thread, so importing the writer would put ~400kB of pdf-lib in the UI bundle,
// and the writer runs in a DOM-less worker that must not see pdf.js at all.

/** Pristine, unannotated source PDF. Every save rebuilds from this. */
export const ORIGINAL_ATTACHMENT = 'original.pdf';

/** tldraw snapshot: the editable form of the strokes stamped on the pages. */
export const SNAPSHOT_ATTACHMENT = 'tldraw-snapshot.json';
