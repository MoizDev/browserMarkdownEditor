import { InputGrid } from './inputGrid';
import type { SegmentKind } from './samples';

const DQ_WINDOW = 32;
const DQ_LOOKAHEAD = 24;
const DQ_LOOKAHEAD_PX = 40;

export type DequantizedSample = Readonly<{ x: number; y: number; pressure: number | undefined; kind: SegmentKind; pins: number; }>;

export class PointerDequantizer {
    private readonly grid: InputGrid;
    private xs: number[] = [];
    private ys: number[] = [];
    private readonly meta: { pressure: number | undefined; kind: SegmentKind; pins: number; }[] = [];
    private pending = 0;
    private anchor = 0;
    private readonly lookaheadWorld: number;
    constructor(pixelWorld: number, captureDeviceScale: number) {
        this.grid = new InputGrid(pixelWorld, captureDeviceScale);
        this.lookaheadWorld = DQ_LOOKAHEAD_PX * pixelWorld;
    }

    push(x: number, y: number, pressure: number | undefined, kind: SegmentKind, pins: number): DequantizedSample[] {
        this.grid.observe(x, y);
        const settled: DequantizedSample[] = [];
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
    provisional(): DequantizedSample[] {
        const out: DequantizedSample[] = [], last = this.xs.length - 1;
        for (let i = this.pending; i <= last; i++) out.push(this.estimate(i, last));
        return out;
    }
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
    private fit(lo: number, hi: number, i: number, q: number): readonly [number, number] | null {
        const ox = this.xs[lo], oy = this.ys[lo];
        const cx = this.xs[hi] - ox, cy = this.ys[hi] - oy, chord = Math.hypot(cx, cy);
        if (!(chord > 2 * q)) return null;
        const tx = cx / chord, ty = cy / chord, nx = -ty, ny = tx;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, r0 = 0, r1 = 0, r2 = 0, previous = -Infinity;
        for (let j = lo; j <= hi; j++) {
            const dx = this.xs[j] - ox, dy = this.ys[j] - oy;
            const u = (dx * tx + dy * ty) / chord, v = dx * nx + dy * ny;
            if (u <= previous) return null;
            previous = u;
            const u2 = u * u;
            s0++; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2; r0 += v; r1 += u * v; r2 += u2 * v;
        }
        const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
        if (!(Math.abs(det) > 1e-12)) return null;
        const a = (r0 * (s2 * s4 - s3 * s3) - s1 * (r1 * s4 - s3 * r2) + s2 * (r1 * s3 - s2 * r2)) / det;
        const b = (s0 * (r1 * s4 - r2 * s3) - r0 * (s1 * s4 - s3 * s2) + s2 * (s1 * r2 - r1 * s2)) / det;
        const c = (s0 * (s2 * r2 - s3 * r1) - s1 * (s1 * r2 - s2 * r1) + r0 * (s1 * s3 - s2 * s2)) / det;
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
