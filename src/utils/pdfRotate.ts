// Turning a PDF's pages — the edit itself.
//
// IT IS A REAL EDIT, not a view filter. The angle goes into each page's
// `/Rotate`, so a scan that opens sideways is fixed everywhere at once: in this
// reader, in the annotate canvas, in the thumbnails, in the saved file, and in
// whatever else the user opens it with. Every consumer in this app already
// honours `/Rotate` — pdf.js applies it when it builds a viewport, and
// `pdfBuild.displaySpace()` undoes it when it stamps annotations — so there is
// no second coordinate system for a view-only rotation to keep in step with.
// That is the whole reason this is written into the file.
//
// pdf-lib ONLY. Imported dynamically (App's rotate handler), like every other
// pdf-lib caller, or ~400kB lands in the main bundle for sessions that never
// open a PDF — see the module-split rules in the `pdf-and-drawings` skill.

import { PDFDocument, degrees } from 'pdf-lib';
import { asQuarter, turn } from './pdfRotation';

export interface RotateResult {
    bytes: Uint8Array;
    /** What the pages now read, for the notice the app shows. */
    angle: number;
}

/**
 * Turn `delta` degrees: every page, or just `pageIndex` when one is named.
 *
 * Returns the whole file re-serialized. `pdf-lib` rewrites the document rather
 * than appending an incremental update, which is what keeps a file rotated
 * twice from growing twice — and the pages themselves are untouched objects, so
 * text, links and any already-stamped ink ride along exactly as they are.
 */
export async function rotatePdfPages(
    bytes: Uint8Array,
    delta: number,
    pageIndex?: number,
): Promise<RotateResult> {
    // A copy, because pdf-lib keeps a reference to what it is handed and the
    // caller still holds these bytes for the viewer.
    const doc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
    const pages = doc.getPages();
    if (!pages.length) throw new Error('This PDF has no pages to rotate.');

    const chosen = pageIndex === undefined
        ? pages
        : [pages[Math.min(pages.length - 1, Math.max(0, pageIndex))]];
    let angle = 0;
    for (const page of chosen) {
        angle = turn(asQuarter(page.getRotation().angle), delta);
        page.setRotation(degrees(angle));
    }
    // useObjectStreams defaults true and is what keeps a rewritten file from
    // bloating; nothing here needs the uncompressed form.
    return { bytes: await doc.save(), angle };
}
