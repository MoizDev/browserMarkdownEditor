import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactLineBetween, exactPoint, exactPointIntervals, exactSide, type ExactLine, type ExactPoint } from './homogeneous';
import { add, interval, multiply, sqrtInterval, subtract } from './numeric';
import { isUniformDistanceMatrix, lowerPointHullDistance, splitCertifiedCurve, upperPointIntervalDistance,
    type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import type { PathOp, Vec2 } from './path';
import type { PointQuery } from './types';

export interface PointClipContour { readonly outline: readonly PathOp[]; readonly localToSurface: Affine }
export type ClippedPointResult = Readonly<{ status: 'pending' | 'miss' }> | Readonly<{ status: 'hit'; distanceCss: number }> | Readonly<{ status: 'uncertain'; reason: string }>;
type Plane = Readonly<{ line: ExactLine; sign: -1 | 1 }>;
export type CertifiedClipRegion = readonly Plane[];
const PENDING: ClippedPointResult = Object.freeze({ status: 'pending' });
export function preparePointClip(clip: PointClipContour): CertifiedClipRegion {
    const vertices: ExactPoint[] = []; let closed = false;
    for (const op of clip.outline) {
        if (op.op === 'Z') { closed = true; continue; }
        if ((op.op !== 'M' && op.op !== 'L') || closed || (op.op === 'M' && vertices.length)) throw new Error('Point clipping requires a closed convex polygon');
        vertices.push(exactAffinePoint(clip.localToSurface, op.p));
    }
    if (!closed || vertices.length < 3 || vertices.length > 64) throw new Error('Point clipping contour is not a bounded convex polygon');
    const edges = vertices.map((value, i) => exactLineBetween(value, vertices[(i + 1) % vertices.length]));
    const winding = exactSide(edges[0], vertices[2]); if (!winding) throw new Error('Point clipping contour is degenerate');
    for (const edge of edges) for (const vertex of vertices) {
        const side = exactSide(edge, vertex); if (side && side !== winding) throw new Error('Point clipping contour is not convex');
    }
    return edges.map(line => ({ line, sign: winding }));
}
export type CertifiedClipBox = readonly [number, number, number, number];
export function certifiedCurveBox(points: CertifiedCurve['points']): CertifiedClipBox {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const point of points) { x0 = Math.min(x0, point.x.lo); y0 = Math.min(y0, point.y.lo); x1 = Math.max(x1, point.x.hi); y1 = Math.max(y1, point.y.hi); }
    return [x0, y0, x1, y1];
}
export function expandCertifiedClipBox(box: CertifiedClipBox, radius: number): CertifiedClipBox {
    return [subtract(interval(box[0]), interval(radius)).lo, subtract(interval(box[1]), interval(radius)).lo,
        add(interval(box[2]), interval(radius)).hi, add(interval(box[3]), interval(radius)).hi];
}
/** inside means the complete interval box is inside; outside means one exact separating plane. */
export function classifyCertifiedClipBox(box: CertifiedClipBox, region: CertifiedClipRegion): 'inside' | 'outside' | 'overlap' {
    if (!box.every(Number.isFinite)) throw new RangeError('Point clipping box overflows');
    const corners = [{ x: box[0], y: box[1] }, { x: box[2], y: box[1] }, { x: box[2], y: box[3] }, { x: box[0], y: box[3] }].map(exactPoint);
    let inside = true;
    for (const plane of region) {
        let anyInside = false, anyOutside = false;
        for (const corner of corners) {
            const side = exactSide(plane.line, corner) * plane.sign;
            if (side >= 0) anyInside = true; else anyOutside = true;
        }
        if (!anyInside) return 'outside';
        if (anyOutside) inside = false;
    }
    return inside ? 'inside' : 'overlap';
}
export function certifiedIntervalPointBox(point: BoundsPoint): CertifiedClipBox { return [point.x.lo, point.y.lo, point.x.hi, point.y.hi]; }

/** Certifies a point hit against actual stroked curves after convex frame clips
 * and convex label exclusions. Unresolved boundary cases remain uncertain. */
export function createClippedPointPathJob(paths: readonly (readonly PathOp[])[], query: PointQuery, options: {
    readonly strokeRadiusLocal: number;
    readonly marginCss: number;
    readonly frames: readonly PointClipContour[];
    readonly exclusions: readonly PointClipContour[];
    readonly maxCommands?: number;
    readonly maxDepth?: number;
    readonly maxNodes?: number;
    readonly maxWork?: number;
}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ClippedPointResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 8192, maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 131072, maxWork = options.maxWork ?? 1000000;
    const margin = query.input === 'touch' ? Math.max(8, options.marginCss) : options.marginCss;
    if (![query.point.x, query.point.y, ...query.localToSurface, options.strokeRadiusLocal, margin].every(Number.isFinite)
        || options.strokeRadiusLocal < 0 || margin < 0 || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || options.frames.length > 64 || options.exclusions.length > 64) throw new RangeError('Invalid clipped point job');
    let finished: ClippedPointResult | undefined, cancelled = false, spent = 0, nodes = 0, commands = 0, pathIndex = 0, commandIndex = 0, uncertain = false;
    if (options.strokeRadiusLocal && !isUniformDistanceMatrix(query.localToSurface)) finished = { status: 'uncertain', reason: 'Nonuniform clipped stroke transform' };
    if (options.exclusions.length > 1) finished = { status: 'uncertain', reason: 'Multiple even-odd exclusions require a partition' };
    const squared = options.strokeRadiusLocal ? add(multiply(interval(query.localToSurface[0]), interval(query.localToSurface[0])),
        multiply(interval(query.localToSurface[1]), interval(query.localToSurface[1]))) : interval(0);
    if (!Number.isFinite(squared.hi)) finished = { status: 'uncertain', reason: 'Clipped stroke scale overflows' };
    const scale = Number.isFinite(squared.hi) ? sqrtInterval({ lo: Math.max(0, squared.lo), hi: squared.hi }) : interval(0);
    const radius = multiply(interval(options.strokeRadiusLocal), scale), threshold = add(radius, interval(margin));
    if (![radius.lo, radius.hi, threshold.lo, threshold.hi].every(Number.isFinite)) finished = { status: 'uncertain', reason: 'Clipped stroke radius overflows' };
    const frames = options.frames.map(preparePointClip), exclusions = options.exclusions.map(preparePointClip);
    const allowed = (box: CertifiedClipBox) => frames.every(region => classifyCertifiedClipBox(box, region) === 'inside') && exclusions.every(region => classifyCertifiedClipBox(box, region) === 'outside');
    const invisible = (box: CertifiedClipBox) => frames.some(region => classifyCertifiedClipBox(box, region) === 'outside') || exclusions.some(region => classifyCertifiedClipBox(box, region) === 'inside');
    const queryBox: CertifiedClipBox = [query.point.x, query.point.y, query.point.x, query.point.y];
    const queryAllowed = allowed(queryBox);
    const mapped = (point: Vec2): BoundsPoint => exactPointIntervals(exactAffinePoint(query.localToSurface, point));
    let start: BoundsPoint | undefined, previous: BoundsPoint | undefined;
    const stack: CertifiedCurve[] = [];
    const finish = (result: ClippedPointResult): ClippedPointResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped point job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped point work limit exhausted' });
                const curve = stack.pop();
                if (curve) {
                    const lower = lowerPointHullDistance(query.point, curve.points);
                    if (!Number.isFinite(lower)) return finish({ status: 'uncertain', reason: 'Clipped point distance overflows' });
                    if (lower > threshold.hi) continue;
                    const bounds = expandCertifiedClipBox(certifiedCurveBox(curve.points), Math.max(0, radius.hi));
                    if (invisible(bounds)) continue;
                    for (const endpoint of [curve.points[0], curve.points[curve.points.length - 1]]) {
                        const distance = upperPointIntervalDistance(query.point, endpoint);
                        if (queryAllowed && distance <= radius.lo) return finish({ status: 'hit', distanceCss: 0 });
                        if (distance <= margin && allowed(certifiedIntervalPointBox(endpoint))) return finish({ status: 'hit', distanceCss: distance });
                    }
                    if (curve.depth >= maxDepth) { uncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped point node limit exhausted' });
                    const [left, right] = splitCertifiedCurve(curve); nodes += 2; stack.push(right, left); continue;
                }
                if (pathIndex >= paths.length) return finish(uncertain
                    ? { status: 'uncertain', reason: 'Clipped point boundary cannot be certified' } : { status: 'miss' });
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; start = previous = undefined; continue; }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Clipped point command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { start = previous = mapped(op.p); continue; }
                if (!start || !previous) throw new RangeError('Clipped point path must begin with M');
                const end = op.op === 'Z' ? start : mapped(op.p);
                if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped point node limit exhausted' });
                stack.push({ points: op.op === 'C' ? [previous, mapped(op.c1), mapped(op.c2), end] : [previous, end], depth: 0 });
                previous = end;
            }
            return PENDING;
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
