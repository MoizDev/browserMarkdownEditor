// Writing "<name> (annotated).pdf". See utils/pdfAnnotation.ts for the format.
//
// DELIBERATELY pdf-lib ONLY, with no pdf.js import: this module is loaded into a
// Web Worker (utils/pdfBuild.worker.ts), which has no DOM. Importing the
// renderer here would drag document/canvas code into the worker and bloat it.
//
// It lives apart from pdfAnnotation.ts for that reason alone — the two halves
// are one feature.

import { PDFDocument, degrees } from 'pdf-lib';
import type { PDFPage, PDFImage } from 'pdf-lib';
import { ORIGINAL_ATTACHMENT, SNAPSHOT_ATTACHMENT } from './pdfFormat';

/**
 * Stamp a page-sized overlay onto `page`, honouring the page's /Rotate flag.
 *
 * THE TRAP: a "landscape" PDF is usually a PORTRAIT page carrying /Rotate 90,
 * and the two libraries disagree about it. pdf.js APPLIES the flag, so the
 * canvas — and therefore the overlay authored on it — is landscape. pdf-lib
 * IGNORES it: getSize() reports the raw MediaBox (portrait), and drawing happens
 * in unrotated user space. Stamping the overlay at face value therefore lands it
 * rotated 90° against the page it belongs to.
 *
 * So map the overlay from display space back into user space by hand. pdf-lib's
 * drawImage places the image's bottom-left at (x,y) and rotates CCW about that
 * point, so each rotation needs its own anchor:
 *
 *   /Rotate    anchor (x, y)    image w x h     rotate
 *   0          (0,  0)          mW x mH           0
 *   90         (mW, 0)          mH x mW          90
 *   180        (mW, mH)         mW x mH         180
 *   270        (0,  mH)         mH x mW         270
 *
 * where mW/mH are the MediaBox dims. Every case covers exactly [0,mW]x[0,mH].
 */
function stampOverlay(page: PDFPage, png: PDFImage): void {
    const { width: mW, height: mH } = page.getSize();
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    // The overlay was authored at the DISPLAYED size, which swaps on a quarter turn.
    const quarterTurned = angle === 90 || angle === 270;
    const w = quarterTurned ? mH : mW;
    const h = quarterTurned ? mW : mH;
    const x = angle === 90 || angle === 180 ? mW : 0;
    const y = angle === 180 || angle === 270 ? mH : 0;
    page.drawImage(png, { x, y, width: w, height: h, rotate: degrees(angle) });
}

/**
 * Write the annotated PDF: `original`'s pages with `overlays` stamped on top,
 * carrying the pristine original and the snapshot as attachments.
 *
 * THE LOAD-BEARING RULE: `original` must always be the pristine source, never
 * the currently-stamped file. Rebuilding from stamped pages re-stamps strokes
 * over themselves, so every save would darken the annotations and grow the file.
 *
 * COST: ~150ms per annotated page (pdf-lib's embedPng dominates), and it scales
 * with the number of ANNOTATED pages, not the document's size — measured at
 * ~4.2s for 30 annotated pages. That is why this runs in a worker.
 *
 * @param overlays transparent PNG per page index; undefined = page unannotated
 */
export async function buildAnnotatedPdf(
    original: Uint8Array,
    snapshot: string,
    overlays: Array<Uint8Array | undefined> = [],
): Promise<Uint8Array> {
    const doc = await PDFDocument.load(original.slice());
    const pages = doc.getPages();

    for (let i = 0; i < pages.length; i++) {
        const overlay = overlays[i];
        if (!overlay?.length) continue;
        const png = await doc.embedPng(overlay.slice());
        stampOverlay(pages[i], png);
    }

    doc.attach(original.slice(), ORIGINAL_ATTACHMENT, {
        mimeType: 'application/pdf',
        description: 'Unannotated source. Every save rebuilds from this, so strokes never compound.',
    });
    doc.attach(new TextEncoder().encode(snapshot), SNAPSHOT_ATTACHMENT, {
        mimeType: 'application/json',
        description: 'tldraw snapshot: the editable form of the annotations stamped on the pages.',
    });

    return doc.save();
}
