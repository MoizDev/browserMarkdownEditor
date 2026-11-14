import { exactAffinePoint } from './exactAffine';
import { exactPointIntervals } from './homogeneous';
import { add, interval, multiply, sqrtInterval } from './numeric';
import { isUniformDistanceMatrix, splitCertifiedCurve, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import { classifyCertifiedClipBox, certifiedCurveBox, certifiedIntervalPointBox, expandCertifiedClipBox, preparePointClip,
    type CertifiedClipBox, type PointClipContour } from './clippedPointPathJob';
import { lowerCurvePairDistance, upperIntervalPairDistance } from './sweptPathJob';
import type { PathOp } from './path';
import type { RegionQuery } from './types';

export type ClippedSweepResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
type Sweep = Extract<RegionQuery, { kind: 'swept' }>;
type Pair = Readonly<{ path: CertifiedCurve; sweep: CertifiedCurve }>;
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
    if (options.strokeRadiusLocal && !isUniformDistanceMatrix(query.localToSurface)) finished = { status: 'uncertain', reason: 'Nonuniform clipped stroke transform' };
    if (options.exclusions.length > 1) finished = { status: 'uncertain', reason: 'Multiple even-odd exclusions require a partition' };
    const squared = options.strokeRadiusLocal ? add(multiply(interval(query.localToSurface[0]), interval(query.localToSurface[0])),
        multiply(interval(query.localToSurface[1]), interval(query.localToSurface[1]))) : interval(0);
    if (!Number.isFinite(squared.hi)) finished = { status: 'uncertain', reason: 'Clipped stroke scale overflows' };
    const scale = Number.isFinite(squared.hi) ? sqrtInterval({ lo: Math.max(0, squared.lo), hi: squared.hi }) : interval(0);
    const radius = multiply(interval(options.strokeRadiusLocal), scale), threshold = add(radius, interval(query.radiusCss));
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
    const mapped = (p: { readonly x: number; readonly y: number }): BoundsPoint => exactPointIntervals(exactAffinePoint(query.localToSurface, p));
    let pathIndex = 0, commandIndex = 0, sweepIndex = 0, start: BoundsPoint | undefined, previous: BoundsPoint | undefined, segment: CertifiedCurve | undefined;
    const stack: Pair[] = [];
    const finish = (value: ClippedSweepResult): ClippedSweepResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped sweep slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped sweep cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped sweep work limit exhausted' });
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
                    if (pair.path.depth >= maxDepth && pair.sweep.depth >= maxDepth) { uncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped sweep node limit exhausted' });
                    if (pair.path.depth <= pair.sweep.depth && pair.path.depth < maxDepth) {
                        const [left, right] = splitCertifiedCurve(pair.path); stack.push({ path: right, sweep: pair.sweep }, { path: left, sweep: pair.sweep });
                    } else {
                        const [left, right] = splitCertifiedCurve(pair.sweep); stack.push({ path: pair.path, sweep: right }, { path: pair.path, sweep: left });
                    }
                    nodes += 2; continue;
                }
                if (segment) {
                    const count = Math.max(1, query.points.length - 1);
                    if (sweepIndex < count) {
                        const first = query.points[sweepIndex], last = query.points[Math.min(sweepIndex + 1, query.points.length - 1)];
                        const a = point(first), b = point(last), depth = first.x === last.x && first.y === last.y ? maxDepth : 0;
                        sweepIndex++; if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Clipped sweep node limit exhausted' });
                        stack.push({ path: segment, sweep: { points: [a, b], depth } }); continue;
                    }
                    segment = undefined; sweepIndex = 0; continue;
                }
                if (pathIndex >= paths.length) return finish(uncertain
                    ? { status: 'uncertain', reason: 'Clipped sweep boundary cannot be certified' } : { status: 'miss' });
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; start = previous = undefined; continue; }
                if (++commands > maxCommands) return finish({ status: 'uncertain', reason: 'Clipped sweep command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { start = previous = mapped(op.p); continue; }
                if (!start || !previous) throw new RangeError('Clipped sweep path must begin with M');
                const end = op.op === 'Z' ? start : mapped(op.p);
                segment = { points: op.op === 'C' ? [previous, mapped(op.c1), mapped(op.c2), end] : [previous, end], depth: 0 };
                previous = end;
            }
            return PENDING;
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
