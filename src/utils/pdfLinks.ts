// A PDF's own clickable links, read out of its /Link annotations.
//
// Two kinds matter: internal destinations (a table of contents, a cross
// reference, "see chapter 4") and external URLs. pdf.js hands both back from
// page.getAnnotations(); everything here is the translation from that raw
// annotation data into something the viewer can place and act on.
//
// DELIBERATELY HAND-ROLLED rather than pdf.js's own AnnotationLayer. That class
// needs a `linkService` shim implementing an interface pdf.js does not export
// (and reshapes between releases), plus its viewer stylesheet — which mostly
// styles form widgets, popups and comments this app deliberately doesn't
// render. What is actually needed is a few dozen lines over four stable, typed,
// public API calls: getAnnotations, getDestination, getPageIndex and
// convertToViewportPoint.
//
// This module imports pdfjs-dist for TYPES ONLY, so it adds nothing to the
// bundle — same discipline as pdfRenderCache/pdfFormat.

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/**
 * Where a link sits on its page, as PERCENTAGES of the rendered page box.
 *
 * Percentages, not pixels, for the same reason pdf.js's own layers use them:
 * the page element is sized `pageSize * scale`, so a layer built once stays
 * correct at every zoom level. Page /Rotate is already applied (the numbers
 * come out of the rotated viewport), so no CSS rotation is needed on top.
 */
export interface PdfLinkBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** What activating a link should do. */
export type PdfLinkTarget =
    /** An external address. Pre-sanitized by pdf.js to http/https/ftp/mailto/tel. */
    | { kind: 'url'; url: string }
    /** Somewhere in this document: a named destination, or an explicit dest array. */
    | { kind: 'dest'; dest: string | unknown[] }
    /** A named viewer action — NextPage, LastPage, … */
    | { kind: 'action'; action: string };

export interface PdfLink extends PdfLinkBox {
    target: PdfLinkTarget;
    /** Tooltip, when the annotation carries one. */
    title?: string;
}

/** The subset of pdf.js's untyped annotation data this module reads. */
interface RawAnnotation {
    subtype?: string;
    /** [x0, y0, x1, y1] in PDF user space, normalized by pdf.js. */
    rect?: number[];
    /** Per-quad [minX, maxY, maxX, maxY, minX, minY, maxX, minY], 8 numbers each. */
    quadPoints?: Float32Array;
    url?: string;
    dest?: string | unknown[];
    action?: string;
    alternativeText?: string;
}

/** A rectangle in PDF user space: [x0, y0, x1, y1], unordered. */
type UserRect = [number, number, number, number];

/**
 * Every clickable link on one page, ready to be placed over it.
 *
 * A link that wraps across lines carries QuadPoints — one quad per line — and
 * each becomes its own entry, so the gap between the lines is NOT clickable.
 * Falling back to the annotation's bounding rect there would swallow clicks on
 * whatever else happens to sit between the two lines.
 */
export async function readPageLinks(page: PDFPageProxy): Promise<PdfLink[]> {
    const annotations = (await page.getAnnotations({ intent: 'display' })) as RawAnnotation[];
    const viewport = page.getViewport({ scale: 1 });
    const links: PdfLink[] = [];

    for (const annotation of annotations) {
        if (annotation.subtype !== 'Link') continue;
        const target = targetOf(annotation);
        if (!target) continue;
        const title = annotation.alternativeText || (target.kind === 'url' ? target.url : undefined);

        for (const rect of rectsOf(annotation)) {
            const box = toPercentBox(viewport, rect);
            if (box) links.push({ ...box, target, title });
        }
    }
    return links;
}

/** Match pdf.js's own precedence (LinkAnnotationElement.render): URL, then a
 *  named action, then a destination. Anything else — attachments, optional
 *  content toggles, form actions — yields nothing, so no element is placed and
 *  the area stays plain, unclickable page. */
function targetOf(annotation: RawAnnotation): PdfLinkTarget | null {
    if (annotation.url) return { kind: 'url', url: annotation.url };
    if (annotation.action) return { kind: 'action', action: annotation.action };
    if (annotation.dest) return { kind: 'dest', dest: annotation.dest };
    return null;
}

function rectsOf(annotation: RawAnnotation): UserRect[] {
    const { quadPoints, rect } = annotation;
    if (quadPoints && quadPoints.length >= 8) {
        const rects: UserRect[] = [];
        for (let i = 0; i + 8 <= quadPoints.length; i += 8) {
            const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]];
            const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]];
            rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        }
        return rects;
    }
    if (rect && rect.length >= 4) return [[rect[0], rect[1], rect[2], rect[3]]];
    return [];
}

/**
 * PDF user space → page percentages.
 *
 * convertToViewportPoint does the whole job: it flips the y-axis, subtracts the
 * crop box origin AND applies the page's /Rotate, so the result is measured
 * from the top-left of the page exactly as it is drawn on screen.
 */
function toPercentBox(viewport: { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] }, [x0, y0, x1, y1]: UserRect): PdfLinkBox | null {
    const [ax, ay] = viewport.convertToViewportPoint(x0, y0);
    const [bx, by] = viewport.convertToViewportPoint(x1, y1);
    const width = Math.abs(bx - ax);
    const height = Math.abs(by - ay);
    // Zero-area links exist in the wild (a stale annotation, a collapsed rect)
    // and would render as an invisible but still clickable sliver.
    if (!(width > 0.5 && height > 0.5) || !viewport.width || !viewport.height) return null;
    return {
        left: (100 * Math.min(ax, bx)) / viewport.width,
        top: (100 * Math.min(ay, by)) / viewport.height,
        width: (100 * width) / viewport.width,
        height: (100 * height) / viewport.height,
    };
}

export interface PdfDestination {
    pageIndex: number;
    /** How far into that page the destination sits, in scale-1 page units
     *  (multiply by the layout scale for pixels). 0 = the page's top edge. */
    offset: number;
}

/**
 * Resolve a link's destination to a page and a position within it.
 *
 * Deliberately done on CLICK rather than when the links are built: a table of
 * contents can hold hundreds of them, and resolving each one costs a worker
 * round-trip (two, for a named destination) that a link nobody clicks never
 * needs to pay.
 *
 * @param getPage the viewer's page cache, so a destination on an already-open
 *        page costs nothing extra.
 */
export async function resolveDestination(
    doc: PDFDocumentProxy,
    dest: string | unknown[],
    getPage: (pageIndex: number) => Promise<PDFPageProxy>,
): Promise<PdfDestination | null> {
    // A named destination is a lookup into the document's /Dests; an explicit
    // one is already the array that lookup would return.
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;

    // First element: a page reference, or (for destinations that arrived from
    // an embedded/remote document) a plain 0-based page number.
    const ref = explicit[0];
    const pageIndex = typeof ref === 'number'
        ? ref
        : await doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;

    const [x, y] = destPoint(explicit);
    // "Fit the page" and friends carry no position — land on the page's top.
    if (y === null) return { pageIndex, offset: 0 };

    const viewport = (await getPage(pageIndex)).getViewport({ scale: 1 });
    const [, vy] = viewport.convertToViewportPoint(x ?? 0, y);
    // A destination just off the top of the page is common (authors point at
    // the heading's baseline plus a margin); clamp instead of overscrolling.
    return { pageIndex, offset: Math.min(Math.max(0, vy), viewport.height) };
}

/**
 * The [x, y] a destination array points at, in PDF user space, or nulls where
 * the destination type doesn't specify one. Shapes are from the PDF spec's
 * destination syntax (table 151).
 */
function destPoint(explicit: unknown[]): [number | null, number | null] {
    const name = (explicit[1] as { name?: string } | undefined)?.name;
    const at = (i: number) => (typeof explicit[i] === 'number' ? (explicit[i] as number) : null);
    switch (name) {
        case 'XYZ':                       // [ref, /XYZ, left, top, zoom]
            return [at(2), at(3)];
        case 'FitH':                      // [ref, /FitH, top]
        case 'FitBH':                     // [ref, /FitBH, top]
            return [null, at(2)];
        case 'FitR':                      // [ref, /FitR, left, bottom, right, top]
            return [at(2), at(5)];
        default:                          // Fit, FitB, FitV, FitBV — top of page
            return [null, null];
    }
}
