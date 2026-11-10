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
// pdf-lib ONLY, and imported ONLY by pdfBuild.worker.ts, like pdfBuild.ts: App
// reaches it through `pdfBuildClient.rotatePdfAsync`. It used to run on the
// main thread, where pdf-lib's idle ticks made a 1,105-page book take 1.3s
// focused and never finish with the window hidden — see SAVE_WITHOUT_TICKS.

import { PDFDocument, degrees } from 'pdf-lib';
import { LOAD_WITHOUT_TICKS, SAVE_WITHOUT_TICKS } from './pdfBuild';
import { asQuarter, turn } from './pdfRotation';

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
): Promise<Uint8Array> {
    // No defensive copy: the worker owns these bytes outright (App TRANSFERS
    // them), and pdf-lib's load() only reads its input — see the ownership note
    // in pdfBuild.buildAnnotatedPdf. The copy this replaces was a whole extra
    // document, 220MB for the largest textbook measured.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, ...LOAD_WITHOUT_TICKS });
    const pages = doc.getPages();
    if (!pages.length) throw new Error('This PDF has no pages to rotate.');

    const chosen = pageIndex === undefined
        ? pages
        : [pages[Math.min(pages.length - 1, Math.max(0, pageIndex))]];
    for (const page of chosen) {
        page.setRotation(degrees(turn(asQuarter(page.getRotation().angle), delta)));
    }
    // useObjectStreams defaults true and is what keeps a rewritten file from
    // bloating; nothing here needs the uncompressed form.
    return doc.save(SAVE_WITHOUT_TICKS);
}
