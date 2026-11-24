import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { createFillPointJob } from './fillPoint';
import { exactLineBetween, exactPointIntervals, exactSide, sameExactPoint, type ExactPoint } from './homogeneous';
import { add, dyadic, dyadicMultiply, dyadicSubtract, interval, multiply, nextUp, sqrtInterval } from './numeric';
import type { Dyadic } from './numeric';
import type { PathOp, Vec2 } from './path';
import { orient2d } from './predicates';

export type ConvexPathEnvelopeResult =
    | { readonly status: 'bounded'; readonly inner: readonly Vec2[]; readonly outer: readonly Vec2[]; readonly errorWorld: number }
    | { readonly status: 'uncertain'; readonly reason: string };
export interface ConvexPathEnvelopeLimits { readonly maxDepth?: number; readonly maxLeaves?: number; readonly maxPoints?: number; readonly maxWork?: number; readonly maxCommands?: number }
type Cubic = readonly [ExactPoint, ExactPoint, ExactPoint, ExactPoint];
type Segment = { readonly curve: Cubic; readonly depth: number };
const ONE: Dyadic = { n: 1n, e: 0 };
function plus(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function mid(a: Dyadic, b: Dyadic): Dyadic { const s = plus(a, b); return { n: s.n, e: s.e - 1 }; }
function midPoint(a: ExactPoint, b: ExactPoint): ExactPoint { return { x: mid(a.x, b.x), y: mid(a.y, b.y), w: ONE }; }
function split(p: Cubic): readonly [Cubic, Cubic] {
    const a = midPoint(p[0], p[1]), b = midPoint(p[1], p[2]), c = midPoint(p[2], p[3]);
    const d = midPoint(a, b), e = midPoint(b, c), m = midPoint(d, e);
    return [[p[0], a, d, m], [m, e, c, p[3]]];
}
function nominal(p: ExactPoint): Vec2 {
    const b = exactPointIntervals(p), x = b.x.lo / 2 + b.x.hi / 2, y = b.y.lo / 2 + b.y.hi / 2;
    if (![b.x.lo, b.x.hi, b.y.lo, b.y.hi, x, y].every(Number.isFinite)) throw new RangeError('Convex path coordinate overflow');
    return { x, y };
}
function distanceUpper(x: number, y: number): number {
    return sqrtInterval(add(multiply(interval(x), interval(x)), multiply(interval(y), interval(y)))).hi;
}
function chordDistance(p: ExactPoint, a: ExactPoint, b: ExactPoint): number {
    const x = nominal(p), u = nominal(a), v = nominal(b), dx = v.x - u.x, dy = v.y - u.y;
    const denom = dx * dx + dy * dy, raw = denom > 0 && Number.isFinite(denom) ? ((x.x - u.x) * dx + (x.y - u.y) * dy) / denom : 0;
    const q = dyadic(Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0);
    const chord: ExactPoint = { x: plus(a.x, dyadicMultiply(dyadicSubtract(b.x, a.x), q)),
        y: plus(a.y, dyadicMultiply(dyadicSubtract(b.y, a.y), q)), w: ONE };
    const delta = exactPointIntervals({ x: dyadicSubtract(p.x, chord.x), y: dyadicSubtract(p.y, chord.y), w: ONE });
    return distanceUpper(Math.max(Math.abs(delta.x.lo), Math.abs(delta.x.hi)), Math.max(Math.abs(delta.y.lo), Math.abs(delta.y.hi)));
}
function curveTurn(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint): number {
    const x1 = dyadicSubtract(b.x, a.x), y1 = dyadicSubtract(b.y, a.y), x2 = dyadicSubtract(d.x, c.x), y2 = dyadicSubtract(d.y, c.y);
    const cross = dyadicSubtract(dyadicMultiply(x1, y2), dyadicMultiply(y1, x2)).n;
    return cross < 0n ? -1 : cross > 0n ? 1 : 0;
}
function uncertain(reason: string): ConvexPathEnvelopeResult { return { status: 'uncertain', reason }; }
function* hull(points: readonly Vec2[]): Generator<void, Vec2[]> {
    let sorted: Vec2[] = [], buffer = new Array<Vec2>(points.length);
    for (const p of points) { sorted.push(p); yield; }
    const compare = (a: Vec2, b: Vec2) => a.x < b.x ? -1 : a.x > b.x ? 1 : a.y < b.y ? -1 : a.y > b.y ? 1 : 0;
    for (let width = 1; width < sorted.length; width *= 2) {
        for (let start = 0; start < sorted.length; start += 2 * width) {
            const end = Math.min(start + 2 * width, sorted.length), middle = Math.min(start + width, end); let a = start, b = middle;
            for (let i = start; i < end; i++) { buffer[i] = a < middle && (b >= end || compare(sorted[a], sorted[b]) <= 0) ? sorted[a++] : sorted[b++]; yield; }
        }
        [sorted, buffer] = [buffer, sorted];
    }
    const unique: Vec2[] = [];
    for (const p of sorted) { const last = unique.at(-1); if (!last || p.x !== last.x || p.y !== last.y) unique.push(p); yield; }
    const half = function* (reverse: boolean): Generator<void, Vec2[]> {
        const out: Vec2[] = [];
        for (let i = 0; i < unique.length; i++) {
            const p = unique[reverse ? unique.length - 1 - i : i];
            while (out.length >= 2 && orient2d(out.at(-2)!, out.at(-1)!, p) <= 0) { out.pop(); yield; }
            out.push(p); yield;
        }
        out.pop(); return out;
    };
    return [...(yield* half(false)), ...(yield* half(true))];
}

/** Outer controls enclose the curve; the inner hull contains only certified fill points. */
export function createConvexPathEnvelopeJob(path: readonly PathOp[], localToWorld: Affine, toleranceWorld: number,
    limits: ConvexPathEnvelopeLimits = {}) {
    const maxDepth = limits.maxDepth ?? 32, maxLeaves = limits.maxLeaves ?? 1024, maxPoints = limits.maxPoints ?? 16384,
        maxWork = limits.maxWork ?? 10000000, maxCommands = limits.maxCommands ?? 4096;
    if (!Number.isFinite(toleranceWorld) || toleranceWorld <= 0 || localToWorld.length !== 6 || !localToWorld.every(Number.isFinite)
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64 || !Number.isSafeInteger(maxLeaves) || maxLeaves < 1
        || !Number.isSafeInteger(maxPoints) || maxPoints < 16 || maxPoints > 16384 || !Number.isSafeInteger(maxWork) || maxWork < 1
        || !Number.isSafeInteger(maxCommands) || maxCommands < 1 || path.length > maxCommands) throw new RangeError('Invalid convex path budget');
    const transform: Affine = [...localToWorld];
    function* calculate(): Generator<void, ConvexPathEnvelopeResult> {
        const copied: PathOp[] = [], segments: Cubic[] = [], polygon: ExactPoint[] = [];
        let start: ExactPoint | undefined, current: ExactPoint | undefined, closed = false;
        for (const op of path) {
            if (op.op === 'M') {
                if (start) return uncertain('Convex clip needs one closed contour');
                const p = { ...op.p }; copied.push({ op: 'M', p }); start = current = exactAffinePoint(transform, p); polygon.push(current);
            } else if (op.op === 'Z') {
                if (!start || !current || closed) return uncertain('Invalid convex clip closure');
                if (!sameExactPoint(current, start)) segments.push([current, current, start, start]);
                copied.push({ op: 'Z' }); current = start; closed = true;
            } else {
                if (!start || !current || closed) return uncertain('Invalid convex clip contour');
                const end = exactAffinePoint(transform, op.p);
                if (op.op === 'C') {
                    const c1 = exactAffinePoint(transform, op.c1), c2 = exactAffinePoint(transform, op.c2);
                    copied.push({ op: 'C', c1: { ...op.c1 }, c2: { ...op.c2 }, p: { ...op.p } });
                    segments.push([current, c1, c2, end]); polygon.push(c1, c2, end);
                } else {
                    copied.push({ op: 'L', p: { ...op.p } }); segments.push([current, current, end, end]); polygon.push(end);
                }
                current = end;
            }
            yield;
        }
        if (!closed || !segments.length) return uncertain('Convex clip contour is not closed');
        const boundary: ExactPoint[] = [];
        for (const p of polygon) { if (!boundary.length || !sameExactPoint(boundary.at(-1)!, p)) boundary.push(p); yield; }
        if (boundary.length > 1 && sameExactPoint(boundary[0], boundary.at(-1)!)) boundary.pop();
        if (boundary.length < 3) return uncertain('Convex clip has no area');
        let winding = 0;
        for (let i = 0; i < boundary.length; i++) {
            const edge = exactLineBetween(boundary[i], boundary[(i + 1) % boundary.length]);
            for (const p of boundary) {
                const side = exactSide(edge, p);
                if (side && winding && side !== winding) return uncertain('Clip control polygon is not convex');
                if (side) winding = side;
                yield;
            }
        }
        if (!winding) return uncertain('Convex clip has no area');
        for (const p of segments) {
            for (const [a, b, c, d] of [[p[0], p[1], p[1], p[2]], [p[1], p[2], p[2], p[3]], [p[0], p[1], p[2], p[3]]] as const) {
                if (curveTurn(a, b, c, d) * winding < 0) return uncertain('Cubic control tangents are not convex');
                yield;
            }
        }
        const stack: Segment[] = [];
        for (let i = segments.length - 1; i >= 0; i--) { stack.push({ curve: segments[i], depth: 0 }); yield; }
        const leaves: Cubic[] = []; let flatness = 0;
        while (stack.length) {
            const part = stack.pop()!, p = part.curve;
            const error = Math.max(chordDistance(p[1], p[0], p[3]), chordDistance(p[2], p[0], p[3]));
            if (!Number.isFinite(error)) return uncertain('Convex path flatness overflow');
            if (error <= toleranceWorld / 8) {
                if (leaves.length >= maxLeaves || (leaves.length + 1) * 16 > maxPoints) return uncertain('Convex path envelope point limit');
                flatness = Math.max(flatness, error); leaves.push(p);
            } else {
                if (part.depth >= maxDepth || leaves.length + stack.length + 2 > maxLeaves) return uncertain('Convex path subdivision limit');
                const [left, right] = split(p); stack.push({ curve: right, depth: part.depth + 1 }, { curve: left, depth: part.depth + 1 });
            }
            yield;
        }
        const samples: { nominal: Vec2; point: ExactPoint }[] = [], outerPoints: Vec2[] = [];
        let conversion = 0;
        for (const p of leaves) {
            samples.push({ nominal: nominal(p[0]), point: p[0] });
            for (const control of p) {
                const box = exactPointIntervals(control);
                if (![box.x.lo, box.x.hi, box.y.lo, box.y.hi].every(Number.isFinite)) return uncertain('Convex path conversion overflow');
                conversion = Math.max(conversion, distanceUpper(nextUp(box.x.hi - box.x.lo), nextUp(box.y.hi - box.y.lo)));
                for (const x of [box.x.lo, box.x.hi]) for (const y of [box.y.lo, box.y.hi]) outerPoints.push({ x, y });
                yield;
            }
        }
        const base = samples[0].nominal, seed = { ...base };
        for (const sample of samples) { seed.x += (sample.nominal.x - base.x) / samples.length; seed.y += (sample.nominal.y - base.y) / samples.length; yield; }
        if (!Number.isFinite(seed.x) || !Number.isFinite(seed.y)) return uncertain('Convex path interior seed overflow');
        const contains = function* (point: Vec2): Generator<void, boolean | null> {
            const job = createFillPointJob([copied], point, 'nonzero', { localToWorld: transform });
            for (;;) {
                const result = job.step({ deadline: Number.MAX_VALUE, maxWork: 1 });
                if (result.status === 'inside') return true;
                if (result.status === 'outside') return false;
                if (result.status === 'uncertain') return null;
                yield;
            }
        };
        if ((yield* contains(seed)) !== true) return uncertain('No certified representable interior seed');
        const innerPoints: Vec2[] = []; let inward = 0;
        for (const sample of samples) {
            const p = sample.nominal, distance = Math.max(Math.abs(seed.x - p.x), Math.abs(seed.y - p.y), Number.MIN_VALUE);
            let fraction = Math.min(1, toleranceWorld / (64 * distance)), candidate = p, found = false;
            for (let i = 0; i < 64; i++) {
                candidate = { x: p.x + (seed.x - p.x) * fraction, y: p.y + (seed.y - p.y) * fraction };
                if ((yield* contains(candidate)) === true) { found = true; break; }
                if (fraction === 1) break;
                fraction = Math.min(1, fraction * 2); yield;
            }
            if (!found) return uncertain('Cannot certify an inner curve witness');
            const box = exactPointIntervals(sample.point);
            const dx = nextUp(Math.max(Math.abs(candidate.x - box.x.lo), Math.abs(candidate.x - box.x.hi)));
            const dy = nextUp(Math.max(Math.abs(candidate.y - box.y.lo), Math.abs(candidate.y - box.y.hi)));
            inward = Math.max(inward, distanceUpper(dx, dy));
            if (!Number.isFinite(inward) || inward > toleranceWorld / 2) return uncertain('Convex path inner enclosure exceeds tolerance');
            innerPoints.push(candidate); yield;
        }
        const inner = yield* hull(innerPoints), outer = yield* hull(outerPoints);
        if (inner.length < 3 || outer.length < 3) return uncertain('Convex path envelope collapsed at binary64 precision');
        const errorWorld = add(add(multiply(interval(2), interval(flatness)), interval(inward)), interval(conversion)).hi;
        if (!Number.isFinite(errorWorld) || errorWorld > toleranceWorld) return uncertain('Convex path envelope exceeds tolerance');
        return { status: 'bounded', inner, outer, errorWorld };
    }
    const iterator = calculate(); let result: ConvexPathEnvelopeResult | undefined, total = 0;
    return { step(budget: { readonly deadline: number; readonly maxWork: number }): { readonly done: false } | { readonly done: true; readonly result: ConvexPathEnvelopeResult } {
        if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid convex path step budget');
        if (result) return { done: true, result };
        for (let i = 0; i < budget.maxWork && performance.now() < budget.deadline; i++) {
            if (++total > maxWork) { result = uncertain('Convex path work limit'); return { done: true, result }; }
            try { const next = iterator.next(); if (next.done) { result = next.value; return { done: true, result }; } }
            catch (error) { if (error instanceof RangeError) { result = uncertain(error.message); return { done: true, result }; } throw error; }
        }
        return { done: false };
    }, cancel() { if (!result) { result = uncertain('Convex path cancelled'); iterator.return(result); } } };
}
