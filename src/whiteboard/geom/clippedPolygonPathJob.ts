import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactPoint, exactPointIntervals, type ExactPoint } from './homogeneous';
import { createCurveCapsuleCertificate } from './curveCapsuleCertificate';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import { interval } from './numeric';
import { isUniformDistanceMatrix, strokeRadiusBounds } from './strokeRadiusBounds';
import { classifyClippedVisibility } from './clippedPointPathJob';
import { createExactInverseDistance } from './exactInverseDistance';
import { splitCertifiedCurve, upperPointIntervalDistance, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import { classifyCertifiedClipBox, clipBoxStrictlyInside, certifiedCurveBox, certifiedIntervalPointBox, expandCertifiedClipBox, preparePointClip,
    type CertifiedClipBox, type PointClipContour } from './clippedPointPathJob';
import type { PathOp } from './path';
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
    const stroke = strokeRadiusBounds(query.localToSurface, options.strokeRadiusLocal);
    if (!stroke) finished = { status: 'uncertain', reason: 'Clipped polygon stroke scale overflows' };
    const radius = stroke ?? interval(0);
    const inverseDistance = !isUniformDistanceMatrix(query.localToSurface) ? createExactInverseDistance(query.localToSurface) : null;
    if (![radius.lo, radius.hi].every(Number.isFinite)) finished = { status: 'uncertain', reason: 'Clipped polygon stroke radius overflows' };
    const polygonPath: PathOp[] = query.points.map((p, i) => ({ op: i ? 'L' : 'M', p: { x: p.x, y: p.y } }));
    polygonPath.push({ op: 'Z' });
    let polygon: ReturnType<typeof preparePointClip> | undefined;
    try { polygon = preparePointClip({ outline: polygonPath, localToSurface: IDENTITY }); }
    catch { finished = { status: 'uncertain', reason: 'Polygon is not a certified convex region' }; }
    const frames = options.frames.map(preparePointClip), exclusions = options.exclusions.map(preparePointClip);
    const allowed = (box: CertifiedClipBox) => classifyClippedVisibility(box, frames, exclusions) === 'inside';
    const invisible = (box: CertifiedClipBox) => classifyClippedVisibility(box, frames, exclusions) === 'outside';
    const vertices = query.points.map(point => {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid polygon point');
        return { point, allowed: allowed([point.x, point.y, point.x, point.y]) };
    });
    type Work = { readonly curve: CertifiedCurve; readonly exact: ExactCurve };
    const polygonVertices = query.points.map(exactPoint), low = Math.max(0, radius.lo), high = Math.max(0, radius.hi);
    let start: BoundsPoint | undefined, previous: BoundsPoint | undefined, startExact: ExactPoint | undefined, previousExact: ExactPoint | undefined;
    let certificate: ReturnType<typeof createCurveCapsuleCertificate> | undefined, deferred: Work | undefined, edge = 0, phase: 'inner' | 'outer' | 'exact' = 'inner', edgeUncertain = false;
    let inverseCurve: ExactCurve | undefined;
    const startEdge = () => {
        const a = polygonVertices[edge], b = polygonVertices[(edge + 1) % polygonVertices.length];
        if (inverseDistance && inverseCurve) {
            phase = 'exact'; return createCurveCapsuleCertificate(inverseCurve, inverseDistance.map(a), inverseDistance.map(b), inverseDistance.radius(options.strokeRadiusLocal));
        }
        phase = 'inner'; return createCurveCapsuleCertificate(deferred!.exact, a, b, low);
    };
    const stack: Work[] = [];
    const subdivide = (item: Work): boolean => {
        if (item.curve.depth >= maxDepth) { uncertain = true; return true; }
        if (nodes + 2 > maxNodes) return false;
        const [left, right] = splitCertifiedCurve(item.curve), [exactLeft, exactRight] = splitExactCurve(item.exact);
        nodes += 2; stack.push({ curve: right, exact: exactRight }, { curve: left, exact: exactLeft }); return true;
    };
    const finish = (value: ClippedPolygonResult): ClippedPolygonResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped polygon slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped polygon job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped polygon work limit exhausted' });
                if (certificate) {
                    const result = certificate.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    certificate.cancel(); certificate = undefined;
                    if ((phase === 'inner' || phase === 'exact') && result.status === 'hit') return finish({ status: query.containment ? 'miss' : 'hit' });
                    if (phase === 'inner' && result.status === 'miss' && low !== high) {
                        phase = 'outer'; certificate = createCurveCapsuleCertificate(deferred!.exact, polygonVertices[edge], polygonVertices[(edge + 1) % polygonVertices.length], high); continue;
                    }
                    if (result.status === 'uncertain' || (phase === 'outer' && result.status === 'hit')) edgeUncertain = true;
                    edge++;
                    if (edge < polygonVertices.length) { certificate = startEdge(); continue; }
                    const item = deferred!; deferred = undefined; inverseCurve = undefined;
                    if (edgeUncertain) {
                        if (!subdivide(item)) return finish({ status: 'uncertain', reason: 'Clipped polygon node limit exhausted' });
                    } else {
                        const location = classifyCertifiedClipBox(certifiedIntervalPointBox(item.curve.points[0]), polygon!);
                        visible = true;
                        if (location === 'overlap') {
                            if (!subdivide(item)) return finish({ status: 'uncertain', reason: 'Clipped polygon node limit exhausted' });
                        } else if (query.containment && location === 'outside') return finish({ status: 'miss' });
                        else if (!query.containment && location === 'inside') return finish({ status: 'hit' });
                    }
                    continue;
                }
                const item = stack.pop();
                if (item) {
                    const curve = item.curve, bounds = expandCertifiedClipBox(certifiedCurveBox(curve.points), Math.max(0, radius.hi));
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
                    if (allowed(bounds)) {
                        deferred = item; edge = 0; edgeUncertain = false;
                        inverseCurve = inverseDistance ? item.exact.map(inverseDistance.map) as unknown as ExactCurve : undefined;
                        certificate = startEdge(); continue;
                    }
                    if (!subdivide(item)) return finish({ status: 'uncertain', reason: 'Clipped polygon node limit exhausted' });
                    continue;
                }
                if (pathIndex >= paths.length) {
                    if (uncertain) return finish({ status: 'uncertain', reason: 'Clipped polygon boundary cannot be certified' });
                    return finish({ status: query.containment ? (visible ? 'hit' : 'empty') : 'miss' });
                }
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; start = previous = undefined; startExact = previousExact = undefined; continue; }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Clipped polygon command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { startExact = previousExact = exactAffinePoint(query.localToSurface, op.p); start = previous = exactPointIntervals(startExact); continue; }
                if (!start || !previous || !startExact || !previousExact) throw new RangeError('Clipped polygon path must begin with M');
                const endExact = op.op === 'Z' ? startExact : exactAffinePoint(query.localToSurface, op.p), end = exactPointIntervals(endExact);
                if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped polygon node limit exhausted' });
                if (op.op === 'C') {
                    const c1 = exactAffinePoint(query.localToSurface, op.c1), c2 = exactAffinePoint(query.localToSurface, op.c2);
                    stack.push({ curve: { points: [previous, exactPointIntervals(c1), exactPointIntervals(c2), end], depth: 0 }, exact: [previousExact, c1, c2, endExact] });
                } else stack.push({ curve: { points: [previous, end], depth: 0 }, exact: [previousExact, endExact] });
                previous = end; previousExact = endExact;
            }
            return PENDING;
        },
        cancel() { cancelled = true; certificate?.cancel(); certificate = undefined; deferred = undefined; inverseCurve = undefined; stack.length = 0; },
    };
}
