// Handoff between the annotate canvas and the save path.
//
// An annotated tab's `content` is its tldraw snapshot — a string, so it rides
// the normal buffer/dirty/autosave machinery untouched. But turning that into a
// PDF also needs the pristine original and the rasterized overlays, which only
// the live canvas can produce. The canvas parks them here per path; the app's
// save picks them up.
//
// DELIBERATELY ITS OWN MODULE, free of pdf-lib/pdf.js imports: App must reach
// this on every save without dragging ~1.3MB of PDF machinery into the main
// bundle. Fold it back into pdfAnnotation.ts and a markdown-only session pays
// for a PDF library it never uses.
//
// Also deliberately outside React state: these are megabytes of binary that
// must never land in a re-render path or in localStorage.

export interface PdfRenderData {
    /** Pristine original, extracted once when the file was opened. */
    original: Uint8Array;
    /** Transparent overlay PNG per page index; undefined = page unannotated. */
    overlays: Array<Uint8Array | undefined>;
}

const renderCache = new Map<string, PdfRenderData>();

export function setPdfRenderData(path: string, data: PdfRenderData): void {
    renderCache.set(path, data);
}

export function getPdfRenderData(path: string): PdfRenderData | undefined {
    return renderCache.get(path);
}

/** Drop a closed tab's bytes so they don't pin memory for the session. */
export function clearPdfRenderData(path: string): void {
    renderCache.delete(path);
}
