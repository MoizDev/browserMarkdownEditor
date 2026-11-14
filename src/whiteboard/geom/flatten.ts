import { CubicFlattenJob as InkCubicFlattenJob } from '../ink/flatten';
import type { Arc, Cubic, Vec2 } from './path';

function midpoint(a: Vec2, b: Vec2): Vec2 { return { x: a.x / 2 + b.x / 2, y: a.y / 2 + b.y / 2 }; }
export function splitCubic(c: Cubic): readonly [Cubic, Cubic] {
    const a = midpoint(c.p0, c.p1), b = midpoint(c.p1, c.p2), d = midpoint(c.p2, c.p3);
    const e = midpoint(a, b), f = midpoint(b, d), m = midpoint(e, f);
    return [{ p0: c.p0, p1: a, p2: e, p3: m }, { p0: m, p1: f, p2: d, p3: c.p3 }];
}
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (![p.x, p.y, a.x, a.y, b.x, b.y, dx, dy, length].every(Number.isFinite)) throw new RangeError('Non-finite segment geometry');
    if (!length) return Math.hypot(p.x - a.x, p.y - a.y);
    const px = p.x - a.x, py = p.y - a.y;
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new RangeError('Segment displacement overflows');
    const t = Math.max(0, Math.min(length, px * (dx / length) + py * (dy / length)));
    const result = Math.hypot(px - t * (dx / length), py - t * (dy / length));
    if (!Number.isFinite(result)) throw new RangeError('Segment distance overflows');
    return result;
}
export class CubicFlattenJob {
    private readonly job: InkCubicFlattenJob;
    private output: Vec2[] | undefined;
    constructor(curve: Cubic, error: number) {
        const values = new Float64Array([curve.p0.x, curve.p0.y, curve.p1.x, curve.p1.y, curve.p2.x, curve.p2.y, curve.p3.x, curve.p3.y]);
        this.job = new InkCubicFlattenJob(values, { centreToleranceWorld: error, radiusToleranceWorld: error, radiusChange: 0, arcToleranceWorld: Infinity });
    }
    cancel(): void { this.job.cancel(); }
    get points(): readonly Vec2[] {
        if (!this.output) throw new Error('Flattening has not completed');
        return this.output;
    }
    step(maxVisits: number): 'pending' | 'complete' | 'cancelled' {
        const status = this.job.step(maxVisits);
        if (status === 'complete' && !this.output) {
            const pieces = this.job.result.pieces;
            const result: Vec2[] = [{ x: pieces[2], y: pieces[3] }];
            for (let i = 0; i < pieces.length; i += 9) result.push({ x: pieces[i + 4], y: pieces[i + 5] });
            this.output = result;
        }
        return status;
    }
}
export function flattenCubic(curve: Cubic, error: number): Vec2[] {
    const job = new CubicFlattenJob(curve, error);
    while (job.step(4096) === 'pending') { /* synchronous callers explicitly request a complete result */ }
    return [...job.points];
}
export function flattenArc(arc: Arc, error: number): Vec2[] {
    if (!(error > 0) || !Number.isFinite(error) || !(arc.radius >= 0) || !Number.isFinite(arc.radius) || !Number.isFinite(arc.centre.x) || !Number.isFinite(arc.centre.y) || !Number.isFinite(arc.start) || !Number.isFinite(arc.sweep)) throw new RangeError('Invalid arc or error budget');
    const angle = arc.radius === 0 ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - error / arc.radius));
    if (!(angle > 0)) throw new RangeError('Arc cannot be refined at this precision');
    const count = Math.max(1, Math.ceil(Math.abs(arc.sweep) / Math.min(Math.PI, angle)));
    if (!Number.isSafeInteger(count)) throw new RangeError('Arc refinement exceeds addressable size');
    return Array.from({ length: count + 1 }, (_, i) => {
        const a = arc.start + arc.sweep * i / count;
        return { x: arc.centre.x + arc.radius * Math.cos(a), y: arc.centre.y + arc.radius * Math.sin(a) };
    });
}
