import { nextUp } from '../geom/numeric';

// How far a freehand span's curve can leave its two samples: every control of the span lies exactly
// this fraction of the span's chord from one of its endpoints (ink/curve.ts writeControl), and the
// cubic lies in the hull of its controls. Shared by the sample builder and the file reader's point
// inspection, which both summarize a stroke's extent without building a single cubic.
export const CURVE_CONTROL_REACH = 1 / 3;

/** Accumulates, one sample at a time, a box that provably encloses the curve through the samples
 * (each sample's box grown by REACH × its longer adjacent chord) and the farthest reach of any
 * control, which a non-uniformly scaled stroke needs (see scene/bounds.ts). Pure arithmetic: no
 * allocation per point. */
export class CurveReach {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    private maxSpan = 0;
    private maxRounding = 0;
    private lastX = 0; private lastY = 0; private count = 0;
    add(x: number, y: number): void {
        if (this.count++) {
            const chord = Math.hypot(x - this.lastX, y - this.lastY), r = chord * CURVE_CONTROL_REACH;
            // Rounding of r itself: a relative ulp bound keeps the box an enclosure, not an estimate.
            const reach = r + 4 * Number.EPSILON * (r + Math.abs(x) + Math.abs(y) + Math.abs(this.lastX) + Math.abs(this.lastY));
            this.maxSpan = Math.max(this.maxSpan, chord); this.maxRounding = Math.max(this.maxRounding, reach - r);
            this.grow(this.lastX, this.lastY, reach); this.grow(x, y, reach);
        } else this.grow(x, y, 0);
        this.lastX = x; this.lastY = y;
    }
    /** The farthest any control can lie from its own sample (plus `slack`), in the same units. */
    maxReach(slack = 0): number { return this.maxSpan * CURVE_CONTROL_REACH + this.maxRounding + slack; }
    clone(): CurveReach { return Object.assign(new CurveReach(), this); }
    /** [x, y, w, h] with outward-rounded extents, so x + w never falls short of maxX; grown by
     * `slack` for coordinates that are stored up to that far from the ones accumulated. */
    box(slack = 0): readonly [number, number, number, number] {
        const x = this.minX - slack, y = this.minY - slack, w = this.maxX + slack - x, h = this.maxY + slack - y;
        return Object.freeze([x, y, w ? nextUp(w) : 0, h ? nextUp(h) : 0] as const);
    }
    private grow(x: number, y: number, reach: number): void {
        this.minX = Math.min(this.minX, x - reach); this.minY = Math.min(this.minY, y - reach);
        this.maxX = Math.max(this.maxX, x + reach); this.maxY = Math.max(this.maxY, y + reach);
    }
}
