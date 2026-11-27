import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactLineBetween, exactPoint, exactPointIntervals, exactSide, type ExactLine, type ExactPoint } from './homogeneous';
import { createCurveDiskCertificate } from './curveDiskCertificate';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import { add, interval, subtract } from './numeric';
import { isUniformDistanceMatrix, strokeRadiusBounds } from './strokeRadiusBounds';
import { createAnisotropicPointJob } from './anisotropicPointJob';
import { createClippedStrokeWitnessJob } from './clippedStrokeWitness';
import { strokeSeparatedFromPoint } from './strokeSupport';
import { lowerPointHullDistance, splitCertifiedCurve, upperPointIntervalDistance,
    type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import type { PathOp } from './path';
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
export function classifyClippedVisibility(box: CertifiedClipBox, frames: readonly CertifiedClipRegion[],
    exclusions: readonly CertifiedClipRegion[]): 'inside' | 'outside' | 'overlap' {
    let frameOverlap = false, exclusionOverlap = false, parity = 0;
    for (const frame of frames) {
        const relation = classifyCertifiedClipBox(box, frame);
        if (relation === 'outside') return 'outside';
        if (relation === 'overlap') frameOverlap = true;
    }
    for (const exclusion of exclusions) {
        const relation = classifyCertifiedClipBox(box, exclusion);
        if (relation === 'inside' && clipBoxStrictlyInside(box, exclusion)) parity ^= 1;
        else if (relation !== 'outside') exclusionOverlap = true;
    }
    if (exclusionOverlap) return 'overlap';
    if (parity) return 'outside';
    return frameOverlap ? 'overlap' : 'inside';
}
export function clipBoxStrictlyInside(box: CertifiedClipBox, region: CertifiedClipRegion): boolean {
    if (!box.every(Number.isFinite)) throw new RangeError('Point clipping box overflows');
    const corners = [{ x: box[0], y: box[1] }, { x: box[2], y: box[1] }, { x: box[2], y: box[3] }, { x: box[0], y: box[3] }].map(exactPoint);
    return region.every(plane => corners.every(corner => exactSide(plane.line, corner) * plane.sign > 0));
}

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
    const stroke = strokeRadiusBounds(query.localToSurface, options.strokeRadiusLocal);
    if (!stroke) finished = { status: 'uncertain', reason: 'Clipped stroke scale overflows' };
    const radius = stroke ?? interval(0), threshold = add(radius, interval(margin));
    const anisotropic = margin > 0 && !isUniformDistanceMatrix(query.localToSurface);
    let anisotropicJob: ReturnType<typeof createAnisotropicPointJob> | undefined;
    let witness: ReturnType<typeof createClippedStrokeWitnessJob> | undefined;
    if (![radius.lo, radius.hi, threshold.lo, threshold.hi].every(Number.isFinite)) finished = { status: 'uncertain', reason: 'Clipped stroke radius overflows' };
    const frames = options.frames.map(preparePointClip), exclusions = options.exclusions.map(preparePointClip);
    const allowed = (box: CertifiedClipBox) => classifyClippedVisibility(box, frames, exclusions) === 'inside';
    const invisible = (box: CertifiedClipBox) => classifyClippedVisibility(box, frames, exclusions) === 'outside';
    const queryBox: CertifiedClipBox = [query.point.x, query.point.y, query.point.x, query.point.y];
    const queryAllowed = allowed(queryBox);
    type Work = { readonly curve: CertifiedCurve; readonly exact: ExactCurve };
    let start: BoundsPoint | undefined, previous: BoundsPoint | undefined, startExact: ExactPoint | undefined, previousExact: ExactPoint | undefined;
    let certificate: ReturnType<typeof createCurveDiskCertificate> | undefined, certificatePhase: 'inner' | 'outer' = 'inner', deferred: Work | undefined;
    const centre = exactPoint(query.point), low = Math.max(0, threshold.lo), high = Math.max(0, threshold.hi), stack: Work[] = [];
    const subdivide = (work: Work): boolean => {
        if (work.curve.depth >= maxDepth) { uncertain = true; return true; }
        if (nodes + 2 > maxNodes) return false;
        const [left, right] = splitCertifiedCurve(work.curve), [exactLeft, exactRight] = splitExactCurve(work.exact);
        nodes += 2; stack.push({ curve: right, exact: exactRight }, { curve: left, exact: exactLeft }); return true;
    };
    const finish = (result: ClippedPointResult): ClippedPointResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped point job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped point work limit exhausted' });
                if (witness) {
                    const result = witness.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    witness.cancel(); witness = undefined;
                    if (result.status === 'hit') return finish({ status: 'hit', distanceCss: margin });
                    if (!subdivide(deferred!)) return finish({ status: 'uncertain', reason: 'Clipped point node limit exhausted' });
                    deferred = undefined; continue;
                }
                if (anisotropicJob) {
                    const result = anisotropicJob.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    anisotropicJob.cancel(); anisotropicJob = undefined;
                    if (result.status === 'hit') return finish({ status: 'hit', distanceCss: margin });
                    if (result.status === 'uncertain') uncertain = true;
                    deferred = undefined; continue;
                }
                if (certificate) {
                    const result = certificate.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    certificate.cancel(); certificate = undefined;
                    if (certificatePhase === 'inner' && result.status === 'hit') return finish({ status: 'hit', distanceCss: margin });
                    if (certificatePhase === 'inner' && result.status === 'miss' && low === high) { deferred = undefined; continue; }
                    if (certificatePhase === 'inner' && result.status === 'miss') {
                        certificatePhase = 'outer'; certificate = createCurveDiskCertificate(deferred!.exact, centre, high); continue;
                    }
                    if (certificatePhase === 'outer' && result.status === 'miss') { deferred = undefined; continue; }
                    if (!subdivide(deferred!)) return finish({ status: 'uncertain', reason: 'Clipped point node limit exhausted' });
                    deferred = undefined; continue;
                }
                const item = stack.pop();
                if (item) {
                    const curve = item.curve;
                    if (strokeSeparatedFromPoint(curve.points, query.point, query.localToSurface, options.strokeRadiusLocal, margin)) continue;
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
                    if (anisotropic && allowed(bounds)) {
                        deferred = item; anisotropicJob = createAnisotropicPointJob(item.exact, query.localToSurface, options.strokeRadiusLocal, query.point, margin); continue;
                    }
                    if (allowed(bounds)) {
                        deferred = item; certificatePhase = 'inner'; certificate = createCurveDiskCertificate(item.exact, centre, low); continue;
                    }
                    if (curve.depth % 4 === 0) {
                        deferred = item; witness = createClippedStrokeWitnessJob(item.exact, query.localToSurface, options.strokeRadiusLocal,
                            query.point, margin, frames, exclusions); continue;
                    }
                    if (!subdivide(item)) return finish({ status: 'uncertain', reason: 'Clipped point node limit exhausted' });
                    continue;
                }
                if (pathIndex >= paths.length) return finish(uncertain
                    ? { status: 'uncertain', reason: 'Clipped point boundary cannot be certified' } : { status: 'miss' });
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; start = previous = undefined; startExact = previousExact = undefined; continue; }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Clipped point command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { startExact = previousExact = exactAffinePoint(query.localToSurface, op.p); start = previous = exactPointIntervals(startExact); continue; }
                if (!start || !previous || !startExact || !previousExact) throw new RangeError('Clipped point path must begin with M');
                const endExact = op.op === 'Z' ? startExact : exactAffinePoint(query.localToSurface, op.p), end = exactPointIntervals(endExact);
                if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped point node limit exhausted' });
                if (op.op === 'C') {
                    const c1 = exactAffinePoint(query.localToSurface, op.c1), c2 = exactAffinePoint(query.localToSurface, op.c2);
                    stack.push({ curve: { points: [previous, exactPointIntervals(c1), exactPointIntervals(c2), end], depth: 0 }, exact: [previousExact, c1, c2, endExact] });
                } else stack.push({ curve: { points: [previous, end], depth: 0 }, exact: [previousExact, endExact] });
                previous = end; previousExact = endExact;
            }
            return PENDING;
        },
        cancel() { cancelled = true; certificate?.cancel(); anisotropicJob?.cancel(); witness?.cancel(); certificate = undefined; witness = undefined; deferred = undefined; stack.length = 0; },
    };
}
