import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactPointIntervals } from './homogeneous';
import { add, interval, multiply, sqrtInterval } from './numeric';
import { isUniformDistanceMatrix, splitCertifiedCurve, upperPointIntervalDistance, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import { classifyCertifiedClipBox, clipBoxStrictlyInside, certifiedCurveBox, certifiedIntervalPointBox, expandCertifiedClipBox, preparePointClip,
    type CertifiedClipBox, type PointClipContour } from './clippedPointPathJob';
import type { PathOp, Vec2 } from './path';
import type { RegionQuery } from './types';

export type ClippedPolygonResult = Readonly<{ status: 'pending' | 'hit' | 'miss' | 'empty' }> | Readonly<{ status: 'uncertain'; reason: string }>;
type Polygon = Extract<RegionQuery, { kind: 'polygon' }>;
const PENDING: ClippedPolygonResult = Object.freeze({ status: 'pending' });
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** Certified convex-polygon versus clipped stroke. A witness is required for
 * both intersection and nonempty containment; unresolved boundaries stay uncertain. */
export function createClippedPolygonPathJob(paths: readonly (readonly PathOp[])[], query: Polygon, options: {
    readonly strokeRadiusLocal: number;
    readonly frames: readonly PointClipContour[];
    readonly exclusions: readonly PointClipContour[];
    readonly maxCommands?: number;
    readonly maxDepth?: number;
    readonly maxNodes?: number;
    readonly maxWork?: number;
}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ClippedPolygonResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 8192, maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 131072, maxWork = options.maxWork ?? 1000000;
    if (query.points.length < 3 || query.points.length > 64 || !query.localToSurface.every(Number.isFinite)
        || !Number.isFinite(options.strokeRadiusLocal) || options.strokeRadiusLocal < 0 || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || options.frames.length > 64 || options.exclusions.length > 64)
        throw new RangeError('Invalid clipped polygon path');
    let finished: ClippedPolygonResult | undefined, cancelled = false, spent = 0, nodes = 0, commands = 0, pathIndex = 0, commandIndex = 0;
    let uncertain = false, visible = false;
    if (options.strokeRadiusLocal && !isUniformDistanceMatrix(query.localToSurface)) finished = { status: 'uncertain', reason: 'Nonuniform clipped stroke transform' };
    if (options.exclusions.length > 1) finished = { status: 'uncertain', reason: 'Multiple even-odd exclusions require a partition' };
    const squared = options.strokeRadiusLocal ? add(multiply(interval(query.localToSurface[0]), interval(query.localToSurface[0])),
        multiply(interval(query.localToSurface[1]), interval(query.localToSurface[1]))) : interval(0);
    if (!Number.isFinite(squared.hi)) finished = { status: 'uncertain', reason: 'Clipped polygon stroke scale overflows' };
    const scale = Number.isFinite(squared.hi) ? sqrtInterval({ lo: Math.max(0, squared.lo), hi: squared.hi }) : interval(0);
    const radius = multiply(interval(options.strokeRadiusLocal), scale);
    if (![radius.lo, radius.hi].every(Number.isFinite)) finished = { status: 'uncertain', reason: 'Clipped polygon stroke radius overflows' };
    const polygonPath: PathOp[] = query.points.map((p, i) => ({ op: i ? 'L' : 'M', p: { x: p.x, y: p.y } }));
    polygonPath.push({ op: 'Z' });
    let polygon: ReturnType<typeof preparePointClip> | undefined;
    try { polygon = preparePointClip({ outline: polygonPath, localToSurface: IDENTITY }); }
    catch { finished = { status: 'uncertain', reason: 'Polygon is not a certified convex region' }; }
    const frames = options.frames.map(preparePointClip), exclusions = options.exclusions.map(preparePointClip);
    const allowed = (box: CertifiedClipBox) => frames.every(region => classifyCertifiedClipBox(box, region) === 'inside')
        && exclusions.every(region => classifyCertifiedClipBox(box, region) === 'outside');
    const invisible = (box: CertifiedClipBox) => frames.some(region => classifyCertifiedClipBox(box, region) === 'outside')
        || exclusions.some(region => classifyCertifiedClipBox(box, region) === 'inside');
    const vertices = query.points.map(point => {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid polygon point');
        return { point, allowed: allowed([point.x, point.y, point.x, point.y]) };
    });
    const mapped = (point: Vec2): BoundsPoint => exactPointIntervals(exactAffinePoint(query.localToSurface, point));
    let start: BoundsPoint | undefined, previous: BoundsPoint | undefined;
    const stack: CertifiedCurve[] = [];
    const finish = (value: ClippedPolygonResult): ClippedPolygonResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped polygon slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped polygon job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped polygon work limit exhausted' });
                const curve = stack.pop();
                if (curve) {
                    const bounds = expandCertifiedClipBox(certifiedCurveBox(curve.points), Math.max(0, radius.hi));
                    if (invisible(bounds)) continue;
                    const region = classifyCertifiedClipBox(bounds, polygon!);
                    if (!query.containment && region === 'outside') continue;
                    for (const endpoint of [curve.points[0], curve.points[curve.points.length - 1]]) {
                        const endpointBox = certifiedIntervalPointBox(endpoint), location = classifyCertifiedClipBox(endpointBox, polygon!);
                        if (allowed(endpointBox)) {
                            visible = true;
                            if (!query.containment && location === 'inside') return finish({ status: 'hit' });
                            if (query.containment && location === 'outside') return finish({ status: 'miss' });
                        }
                        for (const vertex of vertices) if (vertex.allowed && upperPointIntervalDistance(vertex.point, endpoint) <= radius.lo) {
                            visible = true; return finish({ status: query.containment ? 'miss' : 'hit' });
                        }
                    }
                    if (query.containment && region === 'inside' && visible && clipBoxStrictlyInside(bounds, polygon!)) continue;
                    if (curve.depth >= maxDepth) { uncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped polygon node limit exhausted' });
                    const [left, right] = splitCertifiedCurve(curve); nodes += 2; stack.push(right, left); continue;
                }
                if (pathIndex >= paths.length) {
                    if (uncertain) return finish({ status: 'uncertain', reason: 'Clipped polygon boundary cannot be certified' });
                    return finish({ status: query.containment ? (visible ? 'hit' : 'empty') : 'miss' });
                }
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; start = previous = undefined; continue; }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Clipped polygon command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { start = previous = mapped(op.p); continue; }
                if (!start || !previous) throw new RangeError('Clipped polygon path must begin with M');
                const end = op.op === 'Z' ? start : mapped(op.p);
                if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped polygon node limit exhausted' });
                stack.push({ points: op.op === 'C' ? [previous, mapped(op.c1), mapped(op.c2), end] : [previous, end], depth: 0 });
                previous = end;
            }
            return PENDING;
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
