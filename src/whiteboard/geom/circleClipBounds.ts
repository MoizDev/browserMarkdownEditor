import type { Box } from './bounds';
import { add, divide, dyadic, dyadicMultiply, dyadicSubtract, interval, multiply, nextUp, sqrtInterval, subtract } from './numeric';
import type { Interval } from './numeric';
import type { Vec2 } from './path';

export interface ClipCircle { readonly centre: Vec2; readonly radius: number }
export type CircleClipResult =
    | { readonly status: 'bounded'; readonly bounds: Box; readonly errorWorld: number }
    | { readonly status: 'empty' }
    | { readonly status: 'uncertain'; readonly reason: string };
export type CircleClipStep = { readonly done: false } | { readonly done: true; readonly result: CircleClipResult };

const MAX_VERTICES = 131072;
const validated = new WeakMap<readonly Vec2[], { readonly polygon: readonly Vec2[]; readonly winding: number }>();
type PointInterval = { x: Interval; y: Interval };
const point = (p: Vec2): PointInterval => ({ x: interval(p.x), y: interval(p.y) });
const square = (a: Interval): Interval => {
    if (a.lo >= 0) return multiply(a, a);
    if (a.hi <= 0) return multiply({ lo: -a.hi, hi: -a.lo }, { lo: -a.hi, hi: -a.lo });
    return { lo: 0, hi: nextUp(Math.max(a.lo * a.lo, a.hi * a.hi)) };
};
const cross = (a: PointInterval, b: PointInterval, c: PointInterval): Interval =>
    subtract(multiply(subtract(b.x, a.x), subtract(c.y, a.y)), multiply(subtract(b.y, a.y), subtract(c.x, a.x)));
function edge(a: Vec2, b: Vec2) {
    return { x: dyadicSubtract(dyadic(b.x), dyadic(a.x)), y: dyadicSubtract(dyadic(b.y), dyadic(a.y)) };
}
function half(v: ReturnType<typeof edge>): boolean { return v.y.n > 0n || (v.y.n === 0n && v.x.n >= 0n); }
function turn(a: ReturnType<typeof edge>, b: ReturnType<typeof edge>): -1 | 0 | 1 {
    const n = dyadicSubtract(dyadicMultiply(a.x, b.y), dyadicMultiply(a.y, b.x)).n;
    return n > 0n ? 1 : n < 0n ? -1 : 0;
}
function orientation(a: Vec2, b: Vec2, c: Vec2): number { return turn(edge(a, b), edge(a, c)); }
function forward(a: ReturnType<typeof edge>, b: ReturnType<typeof edge>): boolean {
    const x = dyadicMultiply(a.x, b.x), y = dyadicMultiply(a.y, b.y);
    return dyadicSubtract(x, { n: -y.n, e: y.e }).n > 0n;
}
function uncertain(reason: string): CircleClipResult { return { status: 'uncertain', reason }; }

function* calculate(circle: ClipCircle, polygon: readonly Vec2[], errorWorld: number,
    prior: { readonly polygon: readonly Vec2[]; readonly winding: number } | undefined,
    remember: (winding: number) => void): Generator<void, CircleClipResult> {
    const { centre: c, radius: r } = circle, n = polygon.length;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(r) || r < 0
        || !Number.isFinite(errorWorld) || errorWorld <= 0 || n < 3 || n > MAX_VERTICES) throw new RangeError('Invalid circle, polygon or error budget');
    let same = prior?.polygon.length === n;
    for (let i = 0; i < n; i++) {
        const a = polygon[i], b = polygon[(i + 1) % n];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || (a.x === b.x && a.y === b.y)) throw new RangeError('Invalid clip polygon vertex or edge');
        if (same && (a.x !== prior!.polygon[i].x || a.y !== prior!.polygon[i].y)) same = false;
        yield;
    }
    let winding = same ? prior!.winding : 0;
    if (!same) {
        let fromUpper = 0, toUpper = 0;
        let previous = edge(polygon[n - 1], polygon[0]);
        for (let i = 0; i < n; i++) {
            const next = edge(polygon[i], polygon[(i + 1) % n]), direction = turn(previous, next);
            if (direction && winding && direction !== winding) throw new RangeError('Clip polygon must be convex and consistently wound');
            if (direction) winding = direction;
            else if (!forward(previous, next)) throw new RangeError('Clip polygon has a reversing collinear edge');
            const a = half(previous), b = half(next);
            if (a && !b) fromUpper++; else if (!a && b) toUpper++;
            previous = next; yield;
        }
        if (!winding || (winding > 0 ? fromUpper : toUpper) !== 1) throw new RangeError('Clip polygon must make one convex revolution');
        remember(winding);
    }
    if (r === 0) {
        for (let i = 0; i < n; i++) { if (orientation(polygon[i], polygon[(i + 1) % n], c) * winding < 0) return { status: 'empty' }; yield; }
        return { status: 'bounded', bounds: [c.x, c.y, c.x, c.y], errorWorld: 0 };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, error = 0;
    const candidate = (p: PointInterval): boolean => {
        if (![p.x.lo, p.x.hi, p.y.lo, p.y.hi].every(Number.isFinite)) return false;
        const width = Math.max(p.x.hi - p.x.lo, p.y.hi - p.y.lo);
        if (!Number.isFinite(width) || width > errorWorld) return false;
        error = Math.max(error, width); minX = Math.min(minX, p.x.lo); minY = Math.min(minY, p.y.lo);
        maxX = Math.max(maxX, p.x.hi); maxY = Math.max(maxY, p.y.hi); return true;
    };
    const ci = point(c), ri = interval(r), r2 = square(ri);
    const cardinal: PointInterval[] = [
        { x: subtract(ci.x, ri), y: ci.y }, { x: add(ci.x, ri), y: ci.y },
        { x: ci.x, y: subtract(ci.y, ri) }, { x: ci.x, y: add(ci.y, ri) },
    ];
    for (const p of cardinal) {
        let outside = false, ambiguous = false;
        for (let i = 0; i < n; i++) {
            const side = cross(point(polygon[i]), point(polygon[(i + 1) % n]), p);
            const lo = winding > 0 ? side.lo : -side.hi, hi = winding > 0 ? side.hi : -side.lo;
            if (hi < 0) outside = true; else if (lo <= 0) ambiguous = true;
            yield;
        }
        if (!outside && ambiguous) return uncertain('Circle extremum lies on or numerically near the clip boundary');
        if (!outside && !candidate(p)) return uncertain('Circle extremum exceeds the numeric error budget');
    }
    for (let i = 0; i < n; i++) {
        const a = point(polygon[i]), b = point(polygon[(i + 1) % n]);
        const ax = subtract(a.x, ci.x), ay = subtract(a.y, ci.y), dx = subtract(b.x, a.x), dy = subtract(b.y, a.y);
        const distance = add(square(ax), square(ay));
        if (distance.hi < r2.lo) { if (!candidate(a)) return uncertain('Clip vertex exceeds the numeric error budget'); }
        else if (distance.lo <= r2.hi) return uncertain('Clip vertex lies on or numerically near the circle');
        // Segment P(t)=a+t(b-a). A discriminant interval touching zero is
        // deliberately uncertain: rounding must not turn a tangent into a miss.
        const qa = add(square(dx), square(dy));
        const qb = multiply(interval(2), add(multiply(ax, dx), multiply(ay, dy)));
        const qc = subtract(distance, r2);
        const disc = subtract(square(qb), multiply(interval(4), multiply(qa, qc)));
        if (qa.lo <= 0 || !Number.isFinite(disc.lo) || !Number.isFinite(disc.hi)) return uncertain('Unstable circle-edge equation');
        if (disc.hi >= 0) {
            if (disc.lo <= 0) return uncertain('Circle-edge tangency cannot be certified');
            const root = sqrtInterval(disc), denominator = multiply(interval(2), qa), negB = subtract(interval(0), qb);
            for (const t of [divide(subtract(negB, root), denominator), divide(add(negB, root), denominator)]) {
                if (t.hi < 0 || t.lo > 1) continue;
                if (t.lo < 0 || t.hi > 1) return uncertain('Circle-edge intersection is near a segment endpoint');
                const intersection = { x: add(a.x, multiply(t, dx)), y: add(a.y, multiply(t, dy)) };
                if (!candidate(intersection)) return uncertain('Circle-edge intersection exceeds the numeric error budget');
            }
        }
        yield;
    }
    if (minX === Infinity) return { status: 'empty' };
    return { status: 'bounded', bounds: [minX, minY, maxX, maxY], errorWorld: error };
}

export function createCircleClipBoundsJob(circle: ClipCircle, clipPolygon: readonly Vec2[], errorWorld: number): { step(maxWork: number): CircleClipStep } {
    if (clipPolygon.length > MAX_VERTICES) throw new RangeError('Clip polygon exceeds ancestry limit');
    const c = { centre: { ...circle.centre }, radius: circle.radius }, polygon = clipPolygon.map(p => ({ ...p }));
    const prior = validated.get(clipPolygon);
    const work = calculate(c, polygon, errorWorld, prior, winding => { validated.set(clipPolygon, { polygon, winding }); });
    let result: CircleClipResult | undefined;
    return { step(maxWork) {
        if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid geometry work budget');
        if (result) return { done: true, result };
        for (let i = 0; i < maxWork; i++) {
            const next = work.next();
            if (next.done) { result = next.value; return { done: true, result }; }
        }
        return { done: false };
    } };
}

export function circleClipBounds(circle: ClipCircle, clipPolygon: readonly Vec2[], errorWorld: number): CircleClipResult {
    const job = createCircleClipBoundsJob(circle, clipPolygon, errorWorld);
    for (;;) { const step = job.step(1024); if (step.done) return step.result; }
}
