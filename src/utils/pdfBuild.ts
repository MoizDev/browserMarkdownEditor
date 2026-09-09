// Writing "<name> (annotated).pdf". See utils/pdfAnnotation.ts for the format.
//
// DELIBERATELY pdf-lib ONLY, with no pdf.js import: this module is loaded into a
// Web Worker (utils/pdfBuild.worker.ts), which has no DOM. Importing the
// renderer here would drag document/canvas code into the worker and bloat it.
//
// It lives apart from pdfAnnotation.ts for that reason alone — the two halves
// are one feature.

import { PDFDocument, degrees, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, setLineJoin, LineJoinStyle } from 'pdf-lib';
import type { PDFPage, PDFImage } from 'pdf-lib';
import { ORIGINAL_ATTACHMENT, SNAPSHOT_ATTACHMENT } from './pdfFormat';
import type { PageOverlay } from './pdfOverlay';
import type { VectorOp } from './pdfVector';

/**
 * How a page's annotations were authored versus how pdf-lib will draw them.
 *
 * THE TRAP: a "landscape" PDF is usually a PORTRAIT page carrying /Rotate 90,
 * and the two libraries disagree about it. pdf.js APPLIES the flag, so the
 * canvas — and therefore every annotation authored on it — is landscape. pdf-lib
 * IGNORES it: getSize() reports the raw MediaBox (portrait), and drawing happens
 * in unrotated user space. Stamping at face value therefore lands the
 * annotations rotated 90° against the page they belong to.
 *
 * So this returns the size the annotations were authored at, plus the matrix
 * that carries that display space into the page's user space. pdf-lib's
 * drawImage places an image's bottom-left at (x,y) and rotates CCW about that
 * point, which is where the anchors come from:
 *
 *   /Rotate    anchor (x, y)    image w x h     rotate
 *   0          (0,  0)          mW x mH           0
 *   90         (mW, 0)          mH x mW          90
 *   180        (mW, mH)         mW x mH         180
 *   270        (0,  mH)         mH x mW         270
 *
 * where mW/mH are the MediaBox dims. Every case covers exactly [0,mW]x[0,mH].
 * `ctm` is that same mapping written as a matrix, for the vector path — which
 * has to place many separate strokes rather than one page-sized image, so it
 * concatenates the transform once and draws inside it.
 */
function displaySpace(page: PDFPage) {
    const { width: mW, height: mH } = page.getSize();
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    // Annotations were authored at the DISPLAYED size, which swaps on a quarter turn.
    const quarterTurned = angle === 90 || angle === 270;
    const width = quarterTurned ? mH : mW;
    const height = quarterTurned ? mW : mH;

    // Display space is y-UP with its origin at the displayed page's bottom-left.
    // Each matrix below sends (u, v) there to the matching point in user space.
    const ctm: [number, number, number, number, number, number] =
        angle === 90 ? [0, 1, -1, 0, mW, 0]
            : angle === 180 ? [-1, 0, 0, -1, mW, mH]
                : angle === 270 ? [0, -1, 1, 0, 0, mH]
                    : [1, 0, 0, 1, 0, 0];

    return { angle, width, height, ctm };
}

/** Stamp a page-sized bitmap overlay, honouring the page's /Rotate flag. */
function stampRaster(page: PDFPage, png: PDFImage): void {
    const { angle, width, height } = displaySpace(page);
    const { width: mW, height: mH } = page.getSize();
    const x = angle === 90 || angle === 180 ? mW : 0;
    const y = angle === 180 || angle === 270 ? mH : 0;
    page.drawImage(png, { x, y, width, height, rotate: degrees(angle) });
}

/**
 * Draw the annotations as real paths — sharp at any zoom, and typically an order
 * of magnitude smaller than the equivalent PNG.
 *
 * Ops arrive in page-local SVG space (origin top-left, y down). `drawSvgPath`
 * already emits `scale(1, -1)` to work that way, so the only conversion needed
 * is flipping each origin into the y-up space established by the CTM below —
 * which is also why every op's rotation arrives pre-negated (see
 * pdfVector.decompose).
 */
function stampVector(page: PDFPage, ops: VectorOp[]): void {
    if (!ops.length) return;
    const { height, ctm } = displaySpace(page);

    page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...ctm),
        // tldraw's export sets stroke-linejoin="round" on the root <svg>, and
        // drawSvgPath has no option for it — PDF's default is a miter, which
        // spikes the corners of dashed strokes. Set once for the whole layer.
        setLineJoin(LineJoinStyle.Round),
    );

    for (const op of ops) {
        page.drawSvgPath(op.d, {
            x: op.x,
            y: height - op.y,
            scale: op.scale,
            rotate: degrees(op.rotate),
            // Both keys are always present, even as undefined: pdf-lib tests
            // them with `in`, and adds a black border when NEITHER appears.
            color: op.fill ? rgb(op.fill.r, op.fill.g, op.fill.b) : undefined,
            borderColor: op.stroke ? rgb(op.stroke.r, op.stroke.g, op.stroke.b) : undefined,
            // An opacity embeds a graphics-state dictionary per call, and pdf-lib
            // does not dedupe them. Opaque is the overwhelmingly common case
            // (only the highlighter is translucent), so don't pay for it there.
            opacity: op.fill && op.fillOpacity < 1 ? op.fillOpacity : undefined,
            borderOpacity: op.stroke && op.strokeOpacity < 1 ? op.strokeOpacity : undefined,
            borderWidth: op.stroke ? op.strokeWidth : 0,
            borderDashArray: op.dash,
            borderLineCap: op.lineCap,
        });
    }

    page.pushOperators(popGraphicsState());
}

/**
 * Write the annotated PDF: `original`'s pages with `overlays` drawn on top,
 * carrying the pristine original and the snapshot as attachments.
 *
 * THE LOAD-BEARING RULE: `original` must always be the pristine source, never
 * the currently-stamped file. Rebuilding from stamped pages re-stamps strokes
 * over themselves, so every save would darken the annotations and grow the file.
 *
 * COST: a vector page is cheap (path operators, no image encode); a rasterized
 * one is ~150ms (pdf-lib's embedPng dominates) and scales with the number of
 * RASTERIZED pages, not the document's size — measured at ~4.2s for 30 of them.
 * That is why this runs in a worker.
 *
 * @param overlays per page index; undefined = that page has no annotations
 */
export async function buildAnnotatedPdf(
    original: Uint8Array,
    snapshot: string,
    overlays: Array<PageOverlay | undefined> = [],
): Promise<Uint8Array> {
    // No defensive copy of `original`, on two independent grounds:
    //
    //  1. OWNERSHIP. This module is imported ONLY by pdfBuild.worker.ts, and the
    //     worker received `original` as a structured clone — nothing outside
    //     this thread can see it. The main thread's copy lives untouched in
    //     pdfRenderCache and is what every subsequent save rebuilds from.
    //  2. pdf-lib DOES NOT MUTATE IT (verified against 1.17.1): load() hands the
    //     array straight to a parser whose only reader, ByteStream, indexes it
    //     read-only and copies out with Uint8Array.slice; attach() stores the
    //     reference in a FileEmbedder that deflates from it at save time.
    //
    // Re-check both if this is ever called from the main thread, or on a pdf-lib
    // upgrade. The two .slice()s this replaces cost a full extra copy of the
    // document EACH, on a path that runs every ~2.5s while annotating.
    const doc = await PDFDocument.load(original);
    const pages = doc.getPages();

    for (let i = 0; i < pages.length; i++) {
        const overlay = overlays[i];
        if (!overlay) continue;

        // Raster first, then vector. A page needs both only when it mixes ink
        // with a shape that has no path form (a text label, a pasted image), and
        // in that mix the ink is what the reader expects to be on top.
        if (overlay.raster?.length) {
            // This copy STAYS. The ownership + non-mutation argument above was
            // established for load() and attach() by reading their code; pdf-lib's
            // PNG decode path has not been audited the same way, and an overlay is
            // small next to the document. Don't drop it without doing that reading.
            stampRaster(pages[i], await doc.embedPng(overlay.raster.slice()));
        }
        if (overlay.vector?.length) stampVector(pages[i], overlay.vector);
    }

    doc.attach(original, ORIGINAL_ATTACHMENT, {
        mimeType: 'application/pdf',
        description: 'Unannotated source. Every save rebuilds from this, so strokes never compound.',
    });
    doc.attach(new TextEncoder().encode(snapshot), SNAPSHOT_ATTACHMENT, {
        mimeType: 'application/json',
        description: 'tldraw snapshot: the editable form of the annotations stamped on the pages.',
    });

    return doc.save();
}
