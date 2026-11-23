// Quarter turns, and nothing else — the arithmetic behind rotating a PDF page,
// kept apart from the pdf-lib work in `pdfRotate.ts` so it can be imported
// (and tested) without pulling a 400kB PDF library along.
//
// WHY IT NEEDS A MODULE AT ALL: `/Rotate` is a PDF page attribute, and the spec
// says it must be a multiple of 90 — pdf-lib throws on anything else. A file in
// the wild can still carry 450, -90 or 0.5 (hand-written PDFs and some
// scanners), so every angle is normalized on the way in as well as on the way
// out, and an unusable one falls back to 0 rather than failing the rotation.

/** The only angles a PDF page may be displayed at. */
export type Quarter = 0 | 90 | 180 | 270;

const QUARTERS: Quarter[] = [0, 90, 180, 270];

/** Read an angle off a page: anything unusable reads as 0, which is what a
 *  viewer does with it anyway. */
export function asQuarter(angle: number): Quarter {
    if (!Number.isFinite(angle)) return 0;
    // Round to the nearest quarter first: 89.9 from a rounding-happy writer is
    // 90, and treating it as 0 would rotate the page a quarter turn too far.
    const steps = Math.round(angle / 90);
    return QUARTERS[((steps % 4) + 4) % 4];
}

/** Where a page ends up after turning it by `delta` degrees. */
export function turn(angle: number, delta: number): Quarter {
    return asQuarter(asQuarter(angle) + asQuarter(delta));
}

/** A quarter turn clockwise / anticlockwise, as the buttons mean it. */
export const RIGHT = 90;
export const LEFT = -90;
