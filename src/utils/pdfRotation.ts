// Quarter turns, and nothing else — the arithmetic behind rotating a PDF page,
// shared by the rotation writer (pdf/writing/rotationUpdate.ts) and its verifier.
//
// WHY IT NEEDS A FUNCTION AT ALL: `/Rotate` is a PDF page attribute, and the spec
// says it must be a multiple of 90. A file in the wild can still carry 450 or -90
// (hand-written PDFs and some scanners), so every angle is normalized on the way
// in as well as on the way out. (An angle that is not a multiple of 90 at all is
// refused by the writer rather than guessed at.)

/** The only angles a PDF page may be displayed at. */
export type Quarter = 0 | 90 | 180 | 270;

const QUARTERS: Quarter[] = [0, 90, 180, 270];

/** Read an angle off a page: anything unusable reads as 0, which is what a viewer does with it anyway. */
export function asQuarter(angle: number): Quarter {
    if (!Number.isFinite(angle)) return 0;
    // Round to the nearest quarter first: 89.9 from a rounding-happy writer is
    // 90, and treating it as 0 would rotate the page a quarter turn too far.
    const steps = Math.round(angle / 90);
    return QUARTERS[((steps % 4) + 4) % 4];
}
