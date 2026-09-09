// What one page's annotations look like on their way from the canvas to the
// builder — the contract between PdfAnnotateCanvas (which authors them) and
// pdfBuild (which draws them into the PDF).
//
// ITS OWN MODULE, importing nothing but a type, for the same reason pdfFormat.ts
// is: the canvas runs on the main thread and the builder in a DOM-less worker,
// and either importing the other would drag that side's PDF library across.

import type { VectorOp } from './pdfVector';

/**
 * A page's annotations, as vector paths where possible and pixels where not.
 *
 * BOTH HALVES CAN BE PRESENT. Ink, arrows and shapes become paths, which stay
 * sharp at any zoom; a text label or a pasted image has no path form and is
 * rasterized. A page that mixes them carries one of each, and the builder draws
 * the bitmap first so the ink lands on top.
 *
 * `vector` empty and `raster` absent is a page with nothing on it — the builder
 * leaves such a page untouched rather than re-encoding it.
 */
export interface PageOverlay {
    /** Paths in page-local SVG space. See pdfVector.ts. */
    vector?: VectorOp[];
    /** Transparent page-sized PNG for whatever could not become a path. */
    raster?: Uint8Array;
}

/** True when this overlay would put nothing on the page. */
export function isEmptyOverlay(overlay: PageOverlay | undefined): boolean {
    return !overlay || (!overlay.vector?.length && !overlay.raster?.length);
}
