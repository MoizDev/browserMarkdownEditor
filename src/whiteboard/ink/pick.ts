import type { Affine } from '../../platform/types';
import type { InkCoverage } from './outline';

// R-13/WB-D24, ink.md §6.2: CSS distances, not world radii or device pixels.
export const INK_FINE_MARGIN_CSS = 4;
export const INK_COARSE_MARGIN_CSS = 8;
export const INK_CENTRELINE_FLOOR_CSS = 8;
export const INK_PICK_TOLERANCE_DEVICE_PX = 1 / 64;
export type InkPickQuery =
    | Readonly<{ kind: 'point'; x: number; y: number; pointer: 'mouse' | 'pen' | 'touch' | 'coarse'; }>
    | Readonly<{ kind: 'rectangle'; x: number; y: number; width: number; height: number; }>;
export type InkPickDecision = 'hit' | 'miss' | 'uncertain';
export interface InkPickResult {
    readonly decision: InkPickDecision;
    readonly toleranceDevicePx: number;
    readonly geometryErrorDevicePx: number;
    readonly visits: number;
}

function maxScale(m: Affine): number {
    const norm = Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
    if (!norm) return 0;
    const a = m[0] / norm, b = m[1] / norm, c = m[2] / norm, d = m[3] / norm;
    return norm * Math.sqrt((a * a + b * b + c * c + d * d + Math.hypot(a * a + b * b - c * c - d * d, 2 * (a * c + b * d))) / 2);
}

// Distance by support-plane lower bounds and an inscribed simplex upper bound. Mathematical
// reference: Gilbert/Johnson/Keerthi, IEEE J. Robotics and Automation 4(2), 193–203 (1988), §III.
// Our 2D simplex reduction and analytic swept-disc support are derived here, no library code.
export class ConvexDistance {
    lower = 0;
    upper = Infinity;
    inside = false;
    private readonly simplex = new Float64Array(8);
    private readonly supportPoint = new Float64Array(2);
    private ax = 0; private ay = 0; private r0 = 0;
    private bx = 0; private by = 0; private r1 = 0;
    private hx = 0; private hy = 0;
    constructor(private readonly m: Affine, private readonly qx: number, private readonly qy: number,
        private readonly tolerance: number) { }
    private support(dx: number, dy: number): void {
        const m = this.m, ux = m[0] * dx + m[1] * dy, uy = m[2] * dx + m[3] * dy, norm = Math.hypot(ux, uy);
        const useB = this.bx * dx + this.by * dy + this.r1 * norm > this.ax * dx + this.ay * dy + this.r0 * norm;
        const radius = useB ? this.r1 : this.r0, factor = norm ? radius / norm : 0;
        this.supportPoint[0] = (useB ? this.bx : this.ax) + factor * (m[0] * ux + m[2] * uy) + (dx >= 0 ? this.hx : -this.hx);
        this.supportPoint[1] = (useB ? this.by : this.ay) + factor * (m[1] * ux + m[3] * uy) + (dy >= 0 ? this.hy : -this.hy);
    }
    run(ax: number, ay: number, r0: number, bx: number, by: number, r1: number, hx: number, hy: number): void {
        const m = this.m;
        this.ax = m[0] * ax + m[2] * ay + m[4] - this.qx;
        this.ay = m[1] * ax + m[3] * ay + m[5] - this.qy;
        this.bx = m[0] * bx + m[2] * by + m[4] - this.qx;
        this.by = m[1] * bx + m[3] * by + m[5] - this.qy;
        this.r0 = r0; this.r1 = r1; this.hx = hx; this.hy = hy;
        this.lower = 0; this.upper = Infinity; this.inside = false;
        this.support(1, 0);
        const s = this.simplex;
        s[0] = s[6] = this.supportPoint[0]; s[1] = s[7] = this.supportPoint[1];
        let count = 1;
        const magnitude = Math.max(1, Math.abs(this.ax), Math.abs(this.ay), Math.abs(this.bx), Math.abs(this.by),
            r0 * maxScale(m), r1 * maxScale(m), hx, hy);
        for (let iteration = 0; iteration < 64; iteration++) {
            const distance = Math.hypot(s[6], s[7]);
            const numeric = 256 * Number.EPSILON * magnitude * (iteration + 1);
            if (!Number.isFinite(distance) || !Number.isFinite(numeric)) throw new RangeError('Ink pick transform overflows');
            this.upper = Math.min(this.upper, distance + numeric);
            if (distance <= numeric) { this.lower = 0; return; }
            const dx = -s[6] / distance, dy = -s[7] / distance;
            this.support(dx, dy);
            const px = this.supportPoint[0], py = this.supportPoint[1];
            if (!Number.isFinite(px) || !Number.isFinite(py)) throw new RangeError('Ink pick support overflows');
            this.lower = Math.max(this.lower, -px * dx - py * dy - numeric, 0);
            if (this.upper - this.lower <= this.tolerance) return;
            s[2 * count] = px; s[2 * count + 1] = py; count++;
            if (count === 3) {
                const abx = s[2] - s[0], aby = s[3] - s[1], bcx = s[4] - s[2], bcy = s[5] - s[3];
                const area = abx * (s[5] - s[1]) - aby * (s[4] - s[0]);
                const e0 = abx * -s[1] + aby * s[0], e1 = bcx * -s[3] + bcy * s[2];
                const e2 = (s[0] - s[4]) * -s[5] + (s[1] - s[5]) * s[4];
                const determinantError = numeric * magnitude * 8;
                if ((area > determinantError && e0 > determinantError && e1 > determinantError && e2 > determinantError)
                    || (area < -determinantError && e0 < -determinantError && e1 < -determinantError && e2 < -determinantError)) {
                    this.lower = 0; this.upper = numeric; this.inside = true; return;
                }
            }
            // Closest point on a triangle outside the origin is on one of its three edges.
            // Retain only that edge (or vertex), so the next iteration has at most three supports.
            let best = Infinity, bestA = 0, bestB = 0, bestT = 0, cx = 0, cy = 0;
            const edges = count === 2 ? 1 : 3;
            for (let edge = 0; edge < edges; edge++) {
                const a = edge, b = (edge + 1) % count, x = s[2 * a], y = s[2 * a + 1];
                const ex = s[2 * b] - x, ey = s[2 * b + 1] - y, square = ex * ex + ey * ey;
                const t = square ? Math.max(0, Math.min(1, -(x * ex + y * ey) / square)) : 0;
                const qx = x + t * ex, qy = y + t * ey, length = Math.hypot(qx, qy);
                if (length < best) { best = length; bestA = a; bestB = b; bestT = t; cx = qx; cy = qy; }
            }
            const x0 = s[2 * bestA], y0 = s[2 * bestA + 1], x1 = s[2 * bestB], y1 = s[2 * bestB + 1];
            if (bestT === 0 || bestT === 1) {
                s[0] = bestT ? x1 : x0; s[1] = bestT ? y1 : y0; count = 1;
            } else { s[0] = x0; s[1] = y0; s[2] = x1; s[3] = y1; count = 2; }
            s[6] = cx; s[7] = cy;
        }
        // No convergence is not a miss. Bounds remain available and the caller refines/retries.
    }
}

export class InkPickJob {
    private readonly distance: ConvexDistance;
    private readonly scale: number;
    private readonly paintError: number;
    private readonly centreError: number;
    private readonly tolerance: number;
    private readonly margin: number;
    private readonly hx: number;
    private readonly hy: number;
    private readonly rectangle: boolean;
    private phase = 0;
    private index = 0;
    private possible = false;
    private visits = 0;
    private output: InkPickResult | undefined;
    private cancelled = false;
    private failure: unknown;
    constructor(private readonly coverage: InkCoverage, presentedLocalToCss: Affine, query: InkPickQuery,
        private readonly dpr: number, toleranceDevicePx = INK_PICK_TOLERANCE_DEVICE_PX) {
        if (!presentedLocalToCss.every(Number.isFinite) || !Number.isFinite(dpr) || dpr <= 0
            || !Number.isFinite(query.x) || !Number.isFinite(query.y)
            || !Number.isFinite(toleranceDevicePx) || toleranceDevicePx <= 0) throw new RangeError('Invalid presented ink pick metric');
        this.rectangle = query.kind === 'rectangle';
        if (query.kind === 'rectangle' && (!Number.isFinite(query.width) || query.width < 0 || !Number.isFinite(query.height) || query.height < 0)) {
            throw new RangeError('Invalid ink marquee rectangle');
        }
        const matrix = Object.freeze([...presentedLocalToCss]) as Affine;
        this.scale = maxScale(matrix); this.tolerance = toleranceDevicePx / dpr;
        this.paintError = this.scale * (coverage.centreErrorWorld + coverage.radiusErrorWorld + coverage.dashPhaseErrorWorld);
        this.centreError = this.scale * coverage.centreErrorWorld;
        this.hx = query.kind === 'rectangle' ? query.width / 2 : 0;
        this.hy = query.kind === 'rectangle' ? query.height / 2 : 0;
        this.margin = query.kind === 'rectangle' ? 0 : query.pointer === 'touch' || query.pointer === 'coarse' ? INK_COARSE_MARGIN_CSS : INK_FINE_MARGIN_CSS;
        this.distance = new ConvexDistance(matrix, query.x + this.hx, query.y + this.hy, this.tolerance);
    }
    cancel(): void { this.cancelled = true; }
    get result(): InkPickResult {
        if (!this.output) throw new Error('Ink pick has not completed');
        return this.output;
    }
    step(maxVisits: number): 'pending' | 'complete' | 'cancelled' {
        if (this.failure) throw this.failure;
        try { return this.advance(maxVisits); }
        catch (error) { this.failure = error; throw error; }
    }
    private advance(maxVisits: number): 'pending' | 'complete' | 'cancelled' {
        if (this.cancelled) return 'cancelled';
        if (this.output) return 'complete';
        if (!Number.isInteger(maxVisits) || maxVisits <= 0) throw new RangeError('Invalid pick work slice');
        const c = this.coverage;
        for (let work = 0; work < maxVisits; work++) {
            const data = this.phase === 0 ? c.segments : this.phase === 1 ? c.discs : c.centreline;
            const stride = this.phase === 0 ? 6 : this.phase === 1 ? 3 : 4;
            if (this.index >= data.length) {
                this.phase++; this.index = 0;
                if (this.phase >= (this.rectangle ? 2 : 3)) { this.finish(this.possible ? 'uncertain' : 'miss'); return 'complete'; }
                continue;
            }
            const i = this.index; this.index += stride; this.visits++;
            const ax = data[i], ay = data[i + 1], r0 = this.phase === 2 ? 0 : data[i + 2];
            const bx = this.phase === 0 ? data[i + 3] : this.phase === 2 ? data[i + 2] : ax;
            const by = this.phase === 0 ? data[i + 4] : this.phase === 2 ? data[i + 3] : ay;
            const r1 = this.phase === 0 ? data[i + 5] : r0;
            const error = this.phase === 2 ? this.centreError : this.paintError;
            const threshold = this.phase === 2 ? INK_CENTRELINE_FLOOR_CSS : this.margin;
            this.distance.run(ax, ay, r0, bx, by, r1, this.hx, this.hy);
            if (!this.rectangle && this.distance.upper + error <= threshold) { this.finish('hit'); return 'complete'; }
            const possible = this.distance.lower - error <= threshold;
            if (possible) this.possible = true;
            if (this.rectangle && possible) {
                // Paired centre/radius enclosures give an INNER swept-disc set too. This supplies
                // a robust witness even for a zero-area marquee; no inverse scalar CSS radius is
                // used, and the contracted primitive is still transformed forward by its support.
                const worldError = c.centreErrorWorld + c.radiusErrorWorld + c.dashPhaseErrorWorld;
                if (Math.max(r0, r1) > worldError) {
                    const from = r0 < worldError ? (worldError - r0) / (r1 - r0) : 0;
                    const to = r1 < worldError ? (worldError - r0) / (r1 - r0) : 1;
                    const x0 = ax + (bx - ax) * from, y0 = ay + (by - ay) * from;
                    const x1 = ax + (bx - ax) * to, y1 = ay + (by - ay) * to;
                    const inner0 = Math.max(0, (1 - from) * r0 + from * r1 - worldError);
                    const inner1 = Math.max(0, (1 - to) * r0 + to * r1 - worldError);
                    this.distance.run(x0, y0, inner0, x1, y1, inner1, this.hx, this.hy);
                    if (this.distance.inside) { this.finish('hit'); return 'complete'; }
                }
                // Eroding the query, NOT inflating paint, supplies an intersection witness robust
                // to the canonical coverage error. A narrow/tangent query stays explicitly uncertain.
                const erosion = error + 2 * this.tolerance;
                if (this.hx >= erosion && this.hy >= erosion) {
                    this.distance.run(ax, ay, r0, bx, by, r1, this.hx - erosion, this.hy - erosion);
                    if (this.distance.upper <= this.tolerance) { this.finish('hit'); return 'complete'; }
                }
            }
        }
        return 'pending';
    }
    private finish(decision: InkPickDecision): void {
        this.output = Object.freeze({
            decision, toleranceDevicePx: this.tolerance * this.dpr,
            geometryErrorDevicePx: this.paintError * this.dpr, visits: this.visits
        });
    }
}
