// Handoff between a live notebook canvas and "Export to PDF".
//
// Turning ink into page overlays needs the mounted tldraw editor, but the write
// belongs to App (which owns every filesystem call). So each open notebook
// leaves an exporter here, keyed by path, and the export handler calls it.
//
// A FUNCTION rather than parked bytes, unlike pdfRenderCache: an annotated PDF
// re-exports on a debounce because every save rebuilds the document, whereas a
// notebook exports only when asked. Holding overlays for a notebook nobody is
// exporting would be megabytes of binary kept warm for nothing.
//
// DELIBERATELY FREE OF pdf-lib/pdf.js/tldraw IMPORTS, like pdfRenderCache: App
// reaches this module, and App is the main bundle.

import type { NotebookPaper } from './paper';
import type { PageOverlay } from './pdfOverlay';

export interface NotebookExport {
    paper: NotebookPaper;
    /** One per page index; undefined = nothing written on that page. */
    overlays: Array<PageOverlay | undefined>;
}

/** Returns null if the canvas has gone away since it registered. */
export type NotebookExporter = () => Promise<NotebookExport | null>;

const exporters = new Map<string, NotebookExporter>();

export function setNotebookRenderData(path: string, exporter: NotebookExporter): void {
    exporters.set(path, exporter);
}

export function getNotebookExporter(path: string): NotebookExporter | undefined {
    return exporters.get(path);
}

/** Drop a closed notebook's exporter so it stops pinning the editor it closes
 *  over for the rest of the session. */
export function clearNotebookRenderData(path: string): void {
    exporters.delete(path);
}

/** Follow a rename or a move, or the next export looks under the new path,
 *  finds nothing, and silently does nothing — the same trap movePdfRenderData
 *  exists to close. */
export function moveNotebookRenderData(from: string, to: string): void {
    const exporter = exporters.get(from);
    if (!exporter) return;
    exporters.delete(from);
    exporters.set(to, exporter);
}
