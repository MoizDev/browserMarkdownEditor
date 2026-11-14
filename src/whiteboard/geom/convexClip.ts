import type { Vec2 } from './path';
import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { orient2d } from './predicates';
import { nextUp, add, multiply, interval, sqrtInterval } from './numeric';
import { exactPoint, exactLineBetween, exactIntersection, exactSide, sameExactPoint, exactPointIntervals,
    type ExactPoint, type ExactLine } from './homogeneous';

export type ConvexClipResult =
    | { readonly status: 'bounded'; readonly inner: readonly Vec2[]; readonly outer: readonly Vec2[]; readonly errorWorld: number }
    | { readonly status: 'empty' }
    | { readonly status: 'uncertain'; readonly reason: string };
export type ConvexClipPolygon = readonly Vec2[] | { readonly points: readonly Vec2[]; readonly localToWorld: Affine };
interface Vertex { readonly point: ExactPoint; readonly incoming: ExactLine }
const MAX_INPUT_VERTICES = 256;
const MAX_ENVELOPE_VERTICES = 1024;
function* normalized(input: ConvexClipPolygon): Generator<void, ExactPoint[]> {
    const source = 'points' in input ? input.points : input;
    if (source.length < 3 || source.length > MAX_INPUT_VERTICES) throw new RangeError('Invalid convex clip vertex count');
    const points: ExactPoint[] = [];
    for (const point of source) {
        const mapped = 'points' in input ? exactAffinePoint(input.localToWorld, point) : exactPoint(point);
        if (!points.length || !sameExactPoint(points.at(-1)!, mapped)) points.push(mapped);
        yield;
    }
    if (points.length > 1 && sameExactPoint(points[0], points.at(-1)!)) points.pop();
    if (points.length < 3) return [];
    let winding = 0;
    for (let i = 0; i < points.length; i++) {
        const line = exactLineBetween(points[i], points[(i + 1) % points.length]);
        for (const point of points) {
            const turn = exactSide(line, point);
            if (turn && winding && turn !== winding) throw new RangeError('Clip polygon must be convex and simple');
            if (turn) winding = turn;
            yield;
        }
    }
    if (!winding) return [];
    if (winding < 0) points.reverse();
    return points;
}
function* hull(input: readonly Vec2[]): Generator<void, Vec2[]> {
    if (input.length > MAX_ENVELOPE_VERTICES) throw new RangeError('Convex envelope exceeds its frame ancestry budget');
    // The bound is four outward corners for at most 256 exact intersection
    // vertices. Sorting this fixed-size set is not a document-sized operation.
    const points = input.slice().sort((a, b) => a.x - b.x || a.y - b.y), unique: Vec2[] = [];
    for (const p of points) { if (!unique.length || p.x !== unique.at(-1)!.x || p.y !== unique.at(-1)!.y) unique.push(p); yield; }
    const half = function* (reverse: boolean): Generator<void, Vec2[]> {
        const result: Vec2[] = [];
        for (let j = 0; j < unique.length; j++) {
            const point = unique[reverse ? unique.length - 1 - j : j];
            while (result.length >= 2 && orient2d(result.at(-2)!, result.at(-1)!, point) <= 0) { result.pop(); yield; }
            result.push(point); yield;
        }
        result.pop(); return result;
    };
    return [...(yield* half(false)), ...(yield* half(true))];
}
function* clipSteps(polygons: readonly ConvexClipPolygon[], tolerance: number): Generator<void, ConvexClipResult> {
    if (!Number.isFinite(tolerance) || tolerance <= 0 || !polygons.length || polygons.length > 64) throw new RangeError('Invalid convex clip budget');
    let vertices: Vertex[] = [], initialized = false;
    const lines: ExactLine[] = [];
    for (const input of polygons) {
        const polygon = yield* normalized(input);
        if (!polygon.length) return { status: 'empty' };
        const edges: ExactLine[] = [];
        for (let i = 0; i < polygon.length; i++) { edges.push(exactLineBetween(polygon[(i + polygon.length - 1) % polygon.length], polygon[i])); yield; }
        lines.push(...edges);
        if (!initialized) {
            initialized = true;
            vertices = polygon.map((point, i) => ({ point, incoming: edges[i] }));
            continue;
        }
        for (const line of edges) {
            if (!vertices.length) return { status: 'empty' };
            const output: Vertex[] = [];
            const push = (value: Vertex) => { if (!output.length || !sameExactPoint(output.at(-1)!.point, value.point)) output.push(value); };
            let previous = vertices.at(-1)!;
            let previousSide = exactSide(line, previous.point);
            for (const current of vertices) {
                const currentSide = exactSide(line, current.point);
                if ((previousSide < 0 && currentSide >= 0) || (previousSide >= 0 && currentSide < 0)) {
                    // incoming names an ORIGINAL supporting line. Intersections
                    // never accumulate rounded points or growing rational chains.
                    const intersection = exactIntersection(current.incoming, line);
                    if (!intersection) return { status: 'uncertain', reason: 'Parallel crossing could not be represented' };
                    push({ point: intersection, incoming: previousSide < 0 ? line : current.incoming });
                }
                if (currentSide >= 0) push(current);
                previous = current; previousSide = currentSide; yield;
            }
            if (output.length > 1 && sameExactPoint(output[0].point, output.at(-1)!.point)) {
                output[0] = { point: output[0].point, incoming: output.at(-1)!.incoming }; output.pop();
            }
            if (output.length > MAX_INPUT_VERTICES) return { status: 'uncertain', reason: 'Frame intersection vertex budget exceeded' };
            vertices = output;
        }
    }
    if (vertices.length < 3) return { status: 'empty' };
    const baseline = exactLineBetween(vertices[0].point, vertices[1].point);
    let hasArea = false;
    for (let i = 2; i < vertices.length; i++) { if (exactSide(baseline, vertices[i].point)) hasArea = true; yield; }
    if (!hasArea) return { status: 'empty' };
    const boxes = [], candidates: Vec2[] = [], outerPoints: Vec2[] = [];
    for (const vertex of vertices) {
        const box = exactPointIntervals(vertex.point);
        if (![box.x.lo, box.x.hi, box.y.lo, box.y.hi].every(Number.isFinite)) return { status: 'uncertain', reason: 'Frame intersection conversion overflow' };
        boxes.push(box);
        candidates.push({ x: box.x.lo + (box.x.hi - box.x.lo) / 2, y: box.y.lo + (box.y.hi - box.y.lo) / 2 });
        for (const x of [box.x.lo, box.x.hi]) for (const y of [box.y.lo, box.y.hi]) outerPoints.push({ x, y });
        yield;
    }
    const origin = candidates[0], seed = { x: origin.x, y: origin.y };
    for (const candidate of candidates) { seed.x += (candidate.x - origin.x) / candidates.length; seed.y += (candidate.y - origin.y) / candidates.length; yield; }
    const inside = function* (p: Vec2): Generator<void, boolean> {
        const exact = exactPoint(p);
        for (const line of lines) { if (exactSide(line, exact) < 0) return false; yield; }
        return true;
    };
    if (!(yield* inside(seed))) return { status: 'uncertain', reason: 'No representable interior seed within the numeric budget' };
    const innerPoints: Vec2[] = [];
    let error = 0;
    for (let i = 0; i < candidates.length; i++) {
        const v = candidates[i], box = boxes[i];
        let candidate = v;
        if (!(yield* inside(candidate))) {
            const distance = Math.max(Math.abs(seed.x - v.x), Math.abs(seed.y - v.y), Number.MIN_VALUE);
            let fraction = Math.min(1, tolerance / (32 * distance)), found = false;
            for (let step = 0; step < 64; step++) {
                candidate = { x: v.x + (seed.x - v.x) * fraction, y: v.y + (seed.y - v.y) * fraction };
                if (yield* inside(candidate)) { found = true; break; }
                if (fraction === 1) break;
                fraction = Math.min(1, fraction * 2); yield;
            }
            if (!found) return { status: 'uncertain', reason: 'Cannot represent an interior envelope vertex' };
        }
        const dx = nextUp(Math.max(Math.abs(candidate.x - box.x.lo), Math.abs(candidate.x - box.x.hi)));
        const dy = nextUp(Math.max(Math.abs(candidate.y - box.y.lo), Math.abs(candidate.y - box.y.hi)));
        const radius = (x: number, y: number) => sqrtInterval(add(multiply(interval(x), interval(x)), multiply(interval(y), interval(y)))).hi;
        error = Math.max(error, radius(dx, dy), radius(nextUp(box.x.hi - box.x.lo), nextUp(box.y.hi - box.y.lo)));
        if (!Number.isFinite(error) || error > tolerance) return { status: 'uncertain', reason: 'Frame polygon enclosure exceeds tolerance' };
        innerPoints.push(candidate); yield;
    }
    const inner = yield* hull(innerPoints), outer = yield* hull(outerPoints);
    if (inner.length < 3 || outer.length < 3) return { status: 'uncertain', reason: 'Frame envelope collapsed at binary64 precision' };
    return { status: 'bounded', inner, outer, errorWorld: error };
}
export function createConvexClipJob(polygons: readonly ConvexClipPolygon[], toleranceWorld: number) {
    const sourcePoints = (p: ConvexClipPolygon) => 'points' in p ? p.points : p;
    if (!polygons.length || polygons.length > 64 || polygons.some(p => sourcePoints(p).length < 3)
        || polygons.reduce((sum, p) => sum + sourcePoints(p).length, 0) > MAX_INPUT_VERTICES) throw new RangeError('Invalid convex clip input budget');
    const copy = (m: Affine): Affine => [m[0], m[1], m[2], m[3], m[4], m[5]];
    const inputs = polygons.map(p => 'points' in p
        ? { points: p.points.map(point => ({ ...point })), localToWorld: copy(p.localToWorld) }
        : p.map(point => ({ ...point })));
    const steps = clipSteps(inputs, toleranceWorld);
    let result: ConvexClipResult | undefined;
    return { step(budget: { deadline: number; maxWork: number }): { done: false } | { done: true; result: ConvexClipResult } {
        if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid convex clip work budget');
        if (result) return { done: true, result };
        for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
            const next = steps.next(); if (next.done) { result = next.value; return { done: true, result }; }
        }
        return { done: false };
    }, cancel() { steps.return({ status: 'uncertain', reason: 'Convex clip cancelled' }); result ??= { status: 'uncertain', reason: 'Convex clip cancelled' }; } };
}
