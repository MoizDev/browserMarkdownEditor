import { exactAffinePoint } from './exactAffine';
import { exactPoint, exactPointIntervals, type ExactPoint } from './homogeneous';
import { createCurveCapsuleCertificate } from './curveCapsuleCertificate';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import { add, interval } from './numeric';
import { strokeRadiusBounds } from './strokeRadiusBounds';
import { splitCertifiedCurve, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import { classifyCertifiedClipBox, certifiedCurveBox, certifiedIntervalPointBox, expandCertifiedClipBox, preparePointClip,
    type CertifiedClipBox, type PointClipContour } from './clippedPointPathJob';
import { lowerCurvePairDistance, upperIntervalPairDistance } from './sweptPathJob';
import type { PathOp } from './path';
import type { RegionQuery } from './types';

export type ClippedSweepResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
type Sweep = Extract<RegionQuery, { kind: 'swept' }>;
type Pair = Readonly<{ path: CertifiedCurve; sweep: CertifiedCurve; exactPath: ExactCurve; exactSweep: ExactCurve }>;
const PENDING: ClippedSweepResult = Object.freeze({ status: 'pending' });

/** Certified swept capsule versus a stroked path after frame and label clips. */
export function createClippedSweptPathJob(paths: readonly (readonly PathOp[])[], query: Sweep, options: {
    readonly strokeRadiusLocal: number;
    readonly frames: readonly PointClipContour[];
    readonly exclusions: readonly PointClipContour[];
    readonly maxCommands?: number;
    readonly maxDepth?: number;
    readonly maxNodes?: number;
    readonly maxWork?: number;
}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ClippedSweepResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 8192, maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 262144, maxWork = options.maxWork ?? 2000000;
    if (!query.points.length || !Number.isFinite(query.radiusCss) || query.radiusCss < 0 || !Number.isFinite(options.strokeRadiusLocal)
        || options.strokeRadiusLocal < 0 || !query.localToSurface.every(Number.isFinite) || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || options.frames.length > 64 || options.exclusions.length > 64) throw new RangeError('Invalid clipped sweep');
    let finished: ClippedSweepResult | undefined, cancelled = false, spent = 0, nodes = 0, commands = 0, uncertain = false;
    if (options.exclusions.length > 1) finished = { status: 'uncertain', reason: 'Multiple even-odd exclusions require a partition' };
    const stroke = strokeRadiusBounds(query.localToSurface, options.strokeRadiusLocal);
    if (!stroke) finished = { status: 'uncertain', reason: 'Clipped stroke scale overflows' };
    const radius = stroke ?? interval(0), threshold = add(radius, interval(query.radiusCss));
    if (![radius.lo, radius.hi, threshold.lo, threshold.hi].every(Number.isFinite)) finished = { status: 'uncertain', reason: 'Clipped sweep radius overflows' };
    const frames = options.frames.map(preparePointClip), exclusions = options.exclusions.map(preparePointClip);
    const allowed = (box: CertifiedClipBox) => frames.every(region => classifyCertifiedClipBox(box, region) === 'inside')
        && exclusions.every(region => classifyCertifiedClipBox(box, region) === 'outside');
    const invisible = (box: CertifiedClipBox) => frames.some(region => classifyCertifiedClipBox(box, region) === 'outside')
        || exclusions.some(region => classifyCertifiedClipBox(box, region) === 'inside');
    const point = (p: { readonly x: number; readonly y: number }): BoundsPoint => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError('Invalid clipped sweep point');
        return { x: interval(p.x), y: interval(p.y) };
    };
    let pathIndex = 0, commandIndex = 0, sweepIndex = 0, start: BoundsPoint | undefined, previous: BoundsPoint | undefined, segment: CertifiedCurve | undefined;
    let startExact: ExactPoint | undefined, previousExact: ExactPoint | undefined, segmentExact: ExactCurve | undefined;
    let certificate: ReturnType<typeof createCurveCapsuleCertificate> | undefined, certificatePhase: 'inner' | 'outer' = 'inner', deferred: Pair | undefined;
    const low = Math.max(0, threshold.lo), high = Math.max(0, threshold.hi), stack: Pair[] = [];
    const subdivide = (pair: Pair): boolean => {
        if (pair.path.depth >= maxDepth && pair.sweep.depth >= maxDepth) { uncertain = true; return true; }
        if (nodes + 2 > maxNodes) return false;
        if (pair.path.depth <= pair.sweep.depth && pair.path.depth < maxDepth) {
            const [left, right] = splitCertifiedCurve(pair.path), [exactLeft, exactRight] = splitExactCurve(pair.exactPath);
            stack.push({ ...pair, path: right, exactPath: exactRight }, { ...pair, path: left, exactPath: exactLeft });
        } else {
            const [left, right] = splitCertifiedCurve(pair.sweep), [exactLeft, exactRight] = splitExactCurve(pair.exactSweep);
            stack.push({ ...pair, sweep: right, exactSweep: exactRight }, { ...pair, sweep: left, exactSweep: exactLeft });
        }
        nodes += 2; return true;
    };
    const finish = (value: ClippedSweepResult): ClippedSweepResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped sweep slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped sweep cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped sweep work limit exhausted' });
                if (certificate) {
                    const result = certificate.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    certificate.cancel(); certificate = undefined;
                    if (certificatePhase === 'inner' && result.status === 'hit') return finish({ status: 'hit' });
                    if (certificatePhase === 'inner' && result.status === 'miss' && low === high) { deferred = undefined; continue; }
                    if (certificatePhase === 'inner' && result.status === 'miss') {
                        certificatePhase = 'outer'; certificate = createCurveCapsuleCertificate(deferred!.exactPath, deferred!.exactSweep[0], deferred!.exactSweep[1], high); continue;
                    }
                    if (certificatePhase === 'outer' && result.status === 'miss') { deferred = undefined; continue; }
                    if (!subdivide(deferred!)) return finish({ status: 'uncertain', reason: 'Clipped sweep node limit exhausted' });
                    deferred = undefined; continue;
                }
                const pair = stack.pop();
                if (pair) {
                    const lower = lowerCurvePairDistance(pair.path.points, pair.sweep.points);
                    if (!Number.isFinite(lower)) return finish({ status: 'uncertain', reason: 'Clipped sweep distance overflows' });
                    if (lower > threshold.hi) continue;
                    const bounds = expandCertifiedClipBox(certifiedCurveBox(pair.path.points), Math.max(0, radius.hi));
                    if (invisible(bounds)) continue;
                    const a = pair.path.points, b = pair.sweep.points;
                    for (const source of [a[0], a[a.length - 1]]) for (const sample of [b[0], b[b.length - 1]]) {
                        const distance = upperIntervalPairDistance(source, sample);
                        if (distance <= radius.lo && allowed(certifiedIntervalPointBox(sample))) return finish({ status: 'hit' });
                        if (distance <= query.radiusCss && allowed(certifiedIntervalPointBox(source))) return finish({ status: 'hit' });
                    }
                    if (allowed(bounds)) {
                        deferred = pair; certificatePhase = 'inner';
                        certificate = createCurveCapsuleCertificate(pair.exactPath, pair.exactSweep[0], pair.exactSweep[1], low); continue;
                    }
                    if (!subdivide(pair)) return finish({ status: 'uncertain', reason: 'Clipped sweep node limit exhausted' });
                    continue;
                }
                if (segment) {
                    const count = Math.max(1, query.points.length - 1);
                    if (sweepIndex < count) {
                        const first = query.points[sweepIndex], last = query.points[Math.min(sweepIndex + 1, query.points.length - 1)];
                        const a = point(first), b = point(last), depth = first.x === last.x && first.y === last.y ? maxDepth : 0;
                        sweepIndex++; if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped sweep node limit exhausted' });
                        stack.push({ path: segment, sweep: { points: [a, b], depth }, exactPath: segmentExact!, exactSweep: [exactPoint(first), exactPoint(last)] }); continue;
                    }
                    segment = undefined; segmentExact = undefined; sweepIndex = 0; continue;
                }
                if (pathIndex >= paths.length) return finish(uncertain
                    ? { status: 'uncertain', reason: 'Clipped sweep boundary cannot be certified' } : { status: 'miss' });
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; start = previous = undefined; startExact = previousExact = undefined; continue; }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Clipped sweep command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { startExact = previousExact = exactAffinePoint(query.localToSurface, op.p); start = previous = exactPointIntervals(startExact); continue; }
                if (!start || !previous || !startExact || !previousExact) throw new RangeError('Clipped sweep path must begin with M');
                const endExact = op.op === 'Z' ? startExact : exactAffinePoint(query.localToSurface, op.p), end = exactPointIntervals(endExact);
                if (op.op === 'C') {
                    const c1 = exactAffinePoint(query.localToSurface, op.c1), c2 = exactAffinePoint(query.localToSurface, op.c2);
                    segmentExact = [previousExact, c1, c2, endExact]; segment = { points: [previous, exactPointIntervals(c1), exactPointIntervals(c2), end], depth: 0 };
                } else { segmentExact = [previousExact, endExact]; segment = { points: [previous, end], depth: 0 }; }
                previous = end; previousExact = endExact;
            }
            return PENDING;
        },
        cancel() { cancelled = true; certificate?.cancel(); certificate = undefined; deferred = undefined; stack.length = 0; },
    };
}
