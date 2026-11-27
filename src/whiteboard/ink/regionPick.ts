import type { Affine } from '../../platform/types';
import { singularValues } from '../geom/affine';
import { orient2d } from '../geom/predicates';
import type { Vec2 } from '../geom/path';
import type { RegionQuery } from '../geom/types';
import type { InkCoverage } from './outline';
import { ConvexDistance, INK_PICK_TOLERANCE_DEVICE_PX, type InkPickDecision, type InkPickResult } from './pick';

type Primitive = { ax: number; ay: number; r0: number; bx: number; by: number; r1: number; centre: Vec2 };
export class InkRegionPickJob {
    private readonly matrix: Affine;
    private readonly distance: ConvexDistance;
    private readonly tolerance: number;
    private readonly worldError: number;
    private readonly error: number;
    private readonly edges: number;
    private readonly points: Vec2[] = [];
    private validationIndex = 0;
    private phase = 0;
    private index = 0;
    private primitive: Primitive | null = null;
    private edge = 0;
    private winding = 0;
    private boundary = false;
    private possibleBoundary = false;
    private uncertain = false;
    private any = false;
    private visits = 0;
    private output: InkPickResult | undefined;
    private cancelled = false;
    private failure: unknown;
    constructor(private readonly coverage: InkCoverage, localToSurface: Affine, private readonly query: RegionQuery,
        private readonly dpr: number) {
        if (!localToSurface.every(Number.isFinite) || !query.localToSurface.every(Number.isFinite)
            || !localToSurface.every((value, i) => value === query.localToSurface[i]) || !Number.isFinite(dpr) || dpr <= 0
            || (query.kind === 'polygon' ? query.points.length < 3 : !query.points.length || !Number.isFinite(query.radiusCss) || query.radiusCss < 0)
            || coverage.segments.length % 6 || coverage.discs.length % 3) throw new RangeError('Invalid ink region query');
        this.matrix = Object.freeze([...localToSurface]) as Affine;
        const [scale] = singularValues(this.matrix);
        this.worldError = coverage.centreErrorWorld + coverage.radiusErrorWorld + coverage.dashPhaseErrorWorld;
        this.error = scale * this.worldError;
        this.tolerance = INK_PICK_TOLERANCE_DEVICE_PX / dpr;
        if (!Number.isFinite(scale) || !Number.isFinite(this.worldError) || this.worldError < 0
            || !Number.isFinite(this.error) || !Number.isFinite(this.error * dpr) || !Number.isFinite(this.tolerance) || this.tolerance <= 0) throw new RangeError('Ink region error overflows');
        this.distance = new ConvexDistance(this.matrix, 0, 0, this.tolerance);
        this.edges = query.kind === 'polygon' ? query.points.length : Math.max(1, query.points.length - 1);
    }
    cancel(): void { this.cancelled = true; this.primitive = null; }
    step(budget: Readonly<{ deadline: number; maxVisits: number }>): { status: 'pending' | 'complete'; result?: InkPickResult } {
        if (this.failure) throw this.failure;
        if (this.cancelled) throw new DOMException('Ink region query cancelled', 'AbortError');
        if (this.output) return { status: 'complete', result: this.output };
        if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxVisits) || budget.maxVisits <= 0) throw new RangeError('Invalid ink region work budget');
        try {
            for (let work = 0; work < budget.maxVisits && performance.now() < budget.deadline; work++) {
                if (this.validationIndex < this.query.points.length) {
                    const point = this.query.points[this.validationIndex++];
                    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid ink region point');
                    this.points.push({ x: point.x, y: point.y });
                    this.visits++; continue;
                }
                if (!this.primitive && !this.nextPrimitive()) {
                    const containment = this.query.kind === 'polygon' && this.query.containment;
                    return this.finish(this.uncertain ? 'uncertain' : containment && this.any ? 'hit' : 'miss');
                }
                this.visit();
                if (this.output) return { status: 'complete', result: this.output };
            }
            return { status: 'pending' };
        } catch (error) { this.failure = error; throw error; }
    }
    private nextPrimitive(): boolean {
        let data = this.phase === 0 ? this.coverage.segments : this.coverage.discs;
        if (this.index >= data.length && this.phase === 0) { this.phase = 1; this.index = 0; data = this.coverage.discs; }
        if (this.index >= data.length) return false;
        const i = this.index, segment = this.phase === 0;
        this.index += segment ? 6 : 3;
        const ax = data[i], ay = data[i + 1], r0 = data[i + 2];
        const bx = segment ? data[i + 3] : ax, by = segment ? data[i + 4] : ay, r1 = segment ? data[i + 5] : r0;
        if (![ax, ay, bx, by, r0, r1].every(Number.isFinite) || r0 < 0 || r1 < 0) throw new RangeError('Invalid ink coverage primitive');
        const m = this.matrix, centre = { x: m[0] * ax + m[2] * ay + m[4], y: m[1] * ax + m[3] * ay + m[5] };
        if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) throw new RangeError('Ink region transform overflows');
        this.primitive = { ax, ay, r0, bx, by, r1, centre };
        this.edge = 0; this.winding = 0; this.boundary = false; this.possibleBoundary = false; this.any = true;
        return true;
    }
    private visit(): void {
        const p = this.primitive!, q = this.query, a = this.points[this.edge], b = this.points[q.kind === 'polygon'
            ? (this.edge + 1) % this.points.length : Math.min(this.edge + 1, this.points.length - 1)];
        if (!a || !b || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) throw new RangeError('Invalid ink region point');
        this.visits++;
        if (q.kind === 'polygon') {
            const sign = orient2d(a, b, p.centre);
            if (sign === 0 && p.centre.x >= Math.min(a.x, b.x) && p.centre.x <= Math.max(a.x, b.x)
                && p.centre.y >= Math.min(a.y, b.y) && p.centre.y <= Math.max(a.y, b.y)) this.boundary = true;
            if (a.y <= p.centre.y && p.centre.y < b.y && sign > 0) this.winding++;
            if (b.y <= p.centre.y && p.centre.y < a.y && sign < 0) this.winding--;
        }
        const radius = q.kind === 'swept' ? q.radiusCss : 0;
        this.distance.setQueryCapsule(a, b, radius);
        this.distance.run(p.ax, p.ay, p.r0, p.bx, p.by, p.r1, 0, 0);
        if (this.distance.lower <= this.error) {
            this.possibleBoundary = true;
            if (q.kind === 'swept' || !q.containment) {
                // A contracted coverage primitive gives a witness despite the source enclosure;
                // an inconclusive/tangent GJK result is never converted to a miss or a hit.
                if (Math.max(p.r0, p.r1) > this.worldError) {
                    const from = p.r0 < this.worldError ? (this.worldError - p.r0) / (p.r1 - p.r0) : 0;
                    const to = p.r1 < this.worldError ? (this.worldError - p.r0) / (p.r1 - p.r0) : 1;
                    const x0 = p.ax + (p.bx - p.ax) * from, y0 = p.ay + (p.by - p.ay) * from;
                    const x1 = p.ax + (p.bx - p.ax) * to, y1 = p.ay + (p.by - p.ay) * to;
                    this.distance.run(x0, y0, Math.max(0, p.r0 + (p.r1 - p.r0) * from - this.worldError),
                        x1, y1, Math.max(0, p.r0 + (p.r1 - p.r0) * to - this.worldError), 0, 0);
                    if (this.distance.inside) { this.finish('hit'); return; }
                }
                if (q.kind === 'swept' && radius > this.error + 2 * this.tolerance) {
                    this.distance.setQueryCapsule(a, b, radius - this.error - 2 * this.tolerance);
                    this.distance.run(p.ax, p.ay, p.r0, p.bx, p.by, p.r1, 0, 0);
                    if (this.distance.inside) { this.finish('hit'); return; }
                }
            }
        }
        if (++this.edge < this.edges) return;
        if (q.kind === 'swept') this.uncertain ||= this.possibleBoundary;
        else {
            const inside = this.boundary || this.winding !== 0;
            if (q.containment) {
                if (!inside && !this.possibleBoundary) { this.finish('miss'); return; }
                if (!inside || this.boundary || this.possibleBoundary) this.uncertain = true;
            } else {
                if (inside && !this.boundary && !this.possibleBoundary) { this.finish('hit'); return; }
                if (inside || this.possibleBoundary) this.uncertain = true;
            }
        }
        this.primitive = null;
    }
    private finish(decision: InkPickDecision): { status: 'complete'; result: InkPickResult } {
        this.output = Object.freeze({ decision, toleranceDevicePx: INK_PICK_TOLERANCE_DEVICE_PX,
            geometryErrorDevicePx: this.error * this.dpr, visits: this.visits });
        return { status: 'complete', result: this.output };
    }
}
