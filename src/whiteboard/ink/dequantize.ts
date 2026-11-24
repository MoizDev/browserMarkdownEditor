import { InputGrid } from './inputGrid';
import type { SegmentKind } from './samples';

// Pointer samples moved back off the pointer's grid, each by less than one grid step.
//
// A mouse or trackpad reports positions on a grid (ink/inputGrid.ts), so a slow stroke arrives as a
// staircase, and the curve drawn THROUGH every sample (ink/curve.ts) drew it: measured at DPR 2, a
// slow whole-pixel arc showed a ~2 device px wobble on a 3–4 px line, and a line 3° off horizontal
// showed one-pixel steps every 19 px. Thinning alone cannot remove it: the samples it keeps are still
// grid points, and on a shallow line it keeps exactly the step corners (measured: knots at (128,101),
// (129,102), (147,102), (148,103)… — fewer steps, the same staircase).
//
// What the pointer actually says is that the hand was somewhere inside each sample's grid cell. So a
// sample's position is re-estimated from its neighbours and kept inside its own cell:
//   - of the windows around the sample (k samples each way, k up to DQ_WINDOW, cut at the stroke's
//     first sample, a boundary and the newest sample), the widest one in which ONE parabola, in the
//     frame of the window's chord, passes through every cell (least squares; every residual within
//     the cell's half-extent across the chord) gives the estimate. A gentle arc or a shallow line fits
//     a wide window; across a corner, a tiny loop, a 3 px zig-zag or the turn of a small letter no
//     window wider than three samples fits, and three samples fit exactly, so such a sample stays
//     where the pointer put it. The widest window, not the first that fails: least squares is not
//     the best fit, so a narrow window can miss a cell a wider one meets, and stopping there left
//     neighbouring samples on different windows (measured: 0.1 px dips on a line 3° off horizontal);
//   - the estimate is the parabola at the sample, clamped to the sample's cell, so nothing ever moves
//     more than half a grid step on either axis: no detail larger than the pointer's own resolution can
//     be smoothed away, and a stroke never pulls behind the cursor or shrinks at its ends.
// The first sample, the newest one and every sample at a straight run or pin stay exactly where the
// pointer was. A sample is settled — handed to the thinning builder, never to move again — once
// DQ_LOOKAHEAD samples or DQ_LOOKAHEAD_PX of stroke have arrived after it; until then it is a
// provisional tail drawn at its current estimate, so the wet ink reaches the cursor and the settling
// is at most half a grid step. Precise input (a pen's fractional positions) has no grid, and passes
// straight through with no tail at all.
//
// Measured on synthetic slow strokes at DPR 2 (total absolute turning beyond the true shape's, from
// the curve the app draws; whole-pixel samples): a circle of radius 80 went from 12075° to 37° and
// kept 103 samples instead of 382; a line 10° off horizontal from 5893° to 12°, 8 samples instead of
// 243; a 3 px zig-zag and 4 px loops kept their shape (largest distance from the true path unchanged).

/** Samples behind the estimated one a window may reach. */
const DQ_WINDOW = 32;
/** Samples ahead a sample waits for before it settles… */
const DQ_LOOKAHEAD = 24;
/** …or this many CSS pixels of stroke, whichever comes first: a window wider than a tread of the
 * shallowest staircase worth straightening (a line 3° off an axis steps every 19 px) needs no more. */
const DQ_LOOKAHEAD_PX = 40;

export type DequantizedSample = Readonly<{ x: number; y: number; pressure: number | undefined; kind: SegmentKind; pins: number; }>;

export class PointerDequantizer {
    private readonly grid: InputGrid;
    // Raw samples since the last boundary: the window's past and the provisional tail.
    private xs: number[] = [];
    private ys: number[] = [];
    private readonly meta: { pressure: number | undefined; kind: SegmentKind; pins: number; }[] = [];
    /** Index (into the arrays above) of the first sample not yet settled. */
    private pending = 0;
    /** Index of the first sample after the last boundary; it stays exact. Negative once trimmed away. */
    private anchor = 0;
    private readonly lookaheadWorld: number;
    constructor(pixelWorld: number, captureDeviceScale: number) {
        this.grid = new InputGrid(pixelWorld, captureDeviceScale);
        this.lookaheadWorld = DQ_LOOKAHEAD_PX * pixelWorld;
    }

    /** Takes one raw sample; returns the samples that settled because of it, in order. */
    push(x: number, y: number, pressure: number | undefined, kind: SegmentKind, pins: number): DequantizedSample[] {
        this.grid.observe(x, y);
        const settled: DequantizedSample[] = [];
        // A straight run's endpoints and a pinned sample are exact, and no window reaches across them.
        if (kind === 'straight' || pins) this.settleAll(settled);
        this.xs.push(x); this.ys.push(y); this.meta.push({ pressure, kind, pins });
        const last = this.xs.length - 1;
        if (kind === 'straight' || pins) { this.anchor = last; }
        if (this.grid.quantumWorld === 0 && this.grid.decided) { this.settleAll(settled); this.trim(); return settled; }
        let ahead = 0;
        for (let i = last; i > this.pending; i--) ahead += Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
        while (this.pending < last) {
            const count = last - this.pending;
            if (count < DQ_LOOKAHEAD && ahead < this.lookaheadWorld) break;
            settled.push(this.estimate(this.pending, last));
            ahead -= Math.hypot(this.xs[this.pending + 1] - this.xs[this.pending], this.ys[this.pending + 1] - this.ys[this.pending]);
            this.pending++;
        }
        this.trim();
        return settled;
    }
    /** The provisional tail as it is drawn now: every unsettled sample at its current estimate. */
    provisional(): DequantizedSample[] {
        const out: DequantizedSample[] = [], last = this.xs.length - 1;
        for (let i = this.pending; i <= last; i++) out.push(this.estimate(i, last));
        return out;
    }
    /** Settles the whole tail exactly as `provisional()` draws it (pen up, or a boundary). */
    flush(): DequantizedSample[] {
        const out: DequantizedSample[] = [];
        this.settleAll(out);
        this.trim();
        return out;
    }

    private settleAll(out: DequantizedSample[]): void {
        const last = this.xs.length - 1;
        for (let i = this.pending; i <= last; i++) out.push(this.estimate(i, last));
        this.pending = last + 1;
    }
    private trim(): void {
        const drop = this.pending - DQ_WINDOW;
        if (drop <= 0) return;
        this.xs.splice(0, drop); this.ys.splice(0, drop); this.meta.splice(0, drop);
        this.pending -= drop; this.anchor -= drop;
    }
    private estimate(i: number, last: number): DequantizedSample {
        const m = this.meta[i], x = this.xs[i], y = this.ys[i];
        const q = this.grid.quantumWorld;
        const exact = { x, y, pressure: m.pressure, kind: m.kind, pins: m.pins };
        if (q === 0 || i <= this.anchor || i >= last) return exact;
        const next = this.meta[i + 1];
        // The sample that starts a straight run is that run's exact endpoint.
        if (next && (next.kind === 'straight' || next.pins)) return exact;
        let fit: readonly [number, number] | null = null;
        for (let k = 2; k <= DQ_WINDOW; k++) {
            const lo = Math.max(0, this.anchor, i - k), hi = Math.min(last, i + k);
            if (lo === Math.max(0, this.anchor, i - k + 1) && hi === Math.min(last, i + k - 1)) break;
            fit = this.fit(lo, hi, i, q) ?? fit;
        }
        if (!fit) return exact;
        const half = q / 2;
        return {
            ...exact,
            x: Math.min(x + half, Math.max(x - half, fit[0])),
            y: Math.min(y + half, Math.max(y - half, fit[1])),
        };
    }
    /** The window's parabola at sample `i`, or null when it misses a cell or the window doubles back. */
    private fit(lo: number, hi: number, i: number, q: number): readonly [number, number] | null {
        const ox = this.xs[lo], oy = this.ys[lo];
        const cx = this.xs[hi] - ox, cy = this.ys[hi] - oy, chord = Math.hypot(cx, cy);
        if (!(chord > 2 * q)) return null;
        const tx = cx / chord, ty = cy / chord, nx = -ty, ny = tx;
        // Normalized abscissa in [0, 1] keeps the normal equations well conditioned.
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, r0 = 0, r1 = 0, r2 = 0, previous = -Infinity;
        for (let j = lo; j <= hi; j++) {
            const dx = this.xs[j] - ox, dy = this.ys[j] - oy;
            const u = (dx * tx + dy * ty) / chord, v = dx * nx + dy * ny;
            // A window that doubles back along its chord is not one arc.
            if (u <= previous) return null;
            previous = u;
            const u2 = u * u;
            s0++; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2; r0 += v; r1 += u * v; r2 += u2 * v;
        }
        // Solve [s0 s1 s2; s1 s2 s3; s2 s3 s4] [a b c] = [r0 r1 r2] by Cramer's rule.
        const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
        if (!(Math.abs(det) > 1e-12)) return null;
        const a = (r0 * (s2 * s4 - s3 * s3) - s1 * (r1 * s4 - s3 * r2) + s2 * (r1 * s3 - s2 * r2)) / det;
        const b = (s0 * (r1 * s4 - r2 * s3) - r0 * (s1 * s4 - s3 * s2) + s2 * (s1 * r2 - r1 * s2)) / det;
        const c = (s0 * (s2 * r2 - s3 * r1) - s1 * (s1 * r2 - s2 * r1) + r0 * (s1 * s3 - s2 * s2)) / det;
        // A cell is the box of half-side q/2 around its sample; across the chord it reaches this far.
        const reach = q / 2 * (Math.abs(nx) + Math.abs(ny)) * (1 + 1e-9);
        let ui = 0;
        for (let j = lo; j <= hi; j++) {
            const dx = this.xs[j] - ox, dy = this.ys[j] - oy;
            const u = (dx * tx + dy * ty) / chord, v = dx * nx + dy * ny;
            if (Math.abs(a + b * u + c * u * u - v) > reach) return null;
            if (j === i) ui = u;
        }
        const v = a + b * ui + c * ui * ui, along = ui * chord;
        return [ox + along * tx + v * nx, oy + along * ty + v * ny];
    }
}
