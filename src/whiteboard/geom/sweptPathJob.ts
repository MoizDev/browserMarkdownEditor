import { exactAffinePoint } from './exactAffine';
import { exactPoint, exactPointIntervals, type ExactPoint } from './homogeneous';
import { exactSegmentsIntersect } from './exactSegments';
import { createFillPointJob } from './fillPoint';
import { add, interval, multiply, sqrtInterval, subtract, type Interval } from './numeric';
import { isUniformDistanceMatrix, splitCertifiedCurve, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import type { PathOp } from './path';
import type { PathPickOptions } from './pick';
import type { RegionQuery } from './types';

export type SweptPathResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface SweptPathLimits { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number; readonly probeInterior?: boolean }
type Sweep = Extract<RegionQuery, { kind: 'swept' }>;
type Pair = Readonly<{ path: CertifiedCurve; sweep: CertifiedCurve; radius: Interval }>;
const PENDING: SweptPathResult = Object.freeze({ status: 'pending' });
function square(value: number): Interval { return multiply(interval(value), interval(value)); }
export function upperIntervalPairDistance(a: BoundsPoint, b: BoundsPoint): number {
    const dx = subtract(a.x, b.x), dy = subtract(a.y, b.y);
    const x = Math.max(Math.abs(dx.lo), Math.abs(dx.hi)), y = Math.max(Math.abs(dy.lo), Math.abs(dy.hi));
    const sum = add(square(x), square(y)); return sqrtInterval({ lo: Math.max(0, sum.lo), hi: sum.hi }).hi;
}
function hull(points: CertifiedCurve['points']): readonly [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) { x0 = Math.min(x0, p.x.lo); y0 = Math.min(y0, p.y.lo); x1 = Math.max(x1, p.x.hi); y1 = Math.max(y1, p.y.hi); }
    return [x0, y0, x1, y1];
}
export function lowerCurvePairDistance(a: CertifiedCurve['points'], b: CertifiedCurve['points']): number {
    const x = hull(a), y = hull(b);
    const dx = x[2] < y[0] ? Math.max(0, subtract(interval(y[0]), interval(x[2])).lo)
        : y[2] < x[0] ? Math.max(0, subtract(interval(x[0]), interval(y[2])).lo) : 0;
    const dy = x[3] < y[1] ? Math.max(0, subtract(interval(y[1]), interval(x[3])).lo)
        : y[3] < x[1] ? Math.max(0, subtract(interval(x[1]), interval(y[3])).lo) : 0;
    const sum = add(square(dx), square(dy)); return sqrtInterval({ lo: Math.max(0, sum.lo), hi: sum.hi }).lo;
}

/** Certified swept-capsule/path intersection. Pair subdivision is cooperative;
 * uncertain boundaries and exhausted limits are never converted into misses. */
export function createSweptPathJob(paths: readonly (readonly PathOp[])[], query: Sweep, options: PathPickOptions,
    limits: SweptPathLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): SweptPathResult; cancel(): void } {
    const matrix = query.localToSurface, maxDepth = limits.maxDepth ?? 64, maxNodes = limits.maxNodes ?? 262144, maxWork = limits.maxWork ?? 2000000;
    if (!query.points.length || !Number.isFinite(query.radiusCss) || query.radiusCss < 0 || !Number.isFinite(options.strokeRadiusLocal)
        || options.strokeRadiusLocal < 0 || !Number.isSafeInteger(options.maxSegments) || options.maxSegments < 1
        || !matrix.every(Number.isFinite) || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128
        || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid swept path job');
    let finished: SweptPathResult | undefined, cancelled = false, spent = 0, nodes = 0, commands = 0, fillIndex = 0;
    if (options.strokeRadiusLocal && !isUniformDistanceMatrix(matrix)) finished = { status: 'uncertain', reason: 'Nonuniform stroke transform requires an anisotropic distance certificate' };
    const squared = options.strokeRadiusLocal ? add(square(matrix[0]), square(matrix[1])) : interval(0);
    if (!Number.isFinite(squared.hi)) finished = { status: 'uncertain', reason: 'Swept path transform scale overflows' };
    const scale = Number.isFinite(squared.hi) ? sqrtInterval({ lo: Math.max(0, squared.lo), hi: squared.hi }) : interval(0);
    const strokeRadius = add(multiply(interval(options.strokeRadiusLocal), scale), interval(query.radiusCss)), fillRadius = interval(query.radiusCss);
    if (![strokeRadius.lo, strokeRadius.hi].every(Number.isFinite)) finished = { status: 'uncertain', reason: 'Swept path radius overflows' };
    const point = (p: { readonly x: number; readonly y: number }): BoundsPoint => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError('Invalid sweep point');
        return { x: interval(p.x), y: interval(p.y) };
    };
    const mapped = (p: { readonly x: number; readonly y: number }): BoundsPoint => exactPointIntervals(exactAffinePoint(matrix, p));
    let fill: ReturnType<typeof createFillPointJob> | undefined, fillUncertain = false, curveUncertain = false;
    const allPaths = [...paths, ...(options.interiorPaths ?? [])];
    let pathIndex = 0, commandIndex = 0, sweepIndex = 0;
    let start: BoundsPoint | undefined, previous: BoundsPoint | undefined, segment: CertifiedCurve | undefined, segmentRadius = strokeRadius;
    let startExact: ExactPoint | undefined, previousExact: ExactPoint | undefined, segmentExact: readonly [ExactPoint, ExactPoint] | undefined;
    const stack: Pair[] = [];
    const finish = (result: SweptPathResult): SweptPathResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid swept path slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Swept path job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Swept path work limit exhausted' });
                if (limits.probeInterior !== false && options.interiorPaths?.length && fillIndex < query.points.length) {
                    if (!fill) fill = createFillPointJob(options.interiorPaths, query.points[fillIndex], 'nonzero',
                        { localToWorld: matrix, maxCommands: options.maxSegments });
                    const state = fill.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    if (state.status === 'inside') return finish({ status: 'hit' });
                    if (state.status === 'uncertain') fillUncertain = true;
                    fill = undefined; fillIndex++; continue;
                }
                const pair = stack.pop();
                if (pair) {
                    const lower = lowerCurvePairDistance(pair.path.points, pair.sweep.points);
                    if (!Number.isFinite(lower)) return finish({ status: 'uncertain', reason: 'Swept path distance overflows' });
                    if (lower > pair.radius.hi) continue;
                    const a = pair.path.points, b = pair.sweep.points;
                    const upper = Math.min(upperIntervalPairDistance(a[0], b[0]), upperIntervalPairDistance(a[0], b[b.length - 1]),
                        upperIntervalPairDistance(a[a.length - 1], b[0]), upperIntervalPairDistance(a[a.length - 1], b[b.length - 1]));
                    if (upper <= pair.radius.lo) return finish({ status: 'hit' });
                    if (pair.path.depth >= maxDepth && pair.sweep.depth >= maxDepth) { curveUncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Swept path node limit exhausted' });
                    if (pair.path.depth <= pair.sweep.depth && pair.path.depth < maxDepth) {
                        const [left, right] = splitCertifiedCurve(pair.path); stack.push({ path: right, sweep: pair.sweep, radius: pair.radius }, { path: left, sweep: pair.sweep, radius: pair.radius });
                    } else {
                        const [left, right] = splitCertifiedCurve(pair.sweep); stack.push({ path: pair.path, sweep: right, radius: pair.radius }, { path: pair.path, sweep: left, radius: pair.radius });
                    }
                    nodes += 2; continue;
                }
                if (segment) {
                    const count = Math.max(1, query.points.length - 1);
                    if (sweepIndex < count) {
                        const first = query.points[sweepIndex], last = query.points[Math.min(sweepIndex + 1, query.points.length - 1)];
                        const a = point(first), b = point(last), depth = first.x === last.x && first.y === last.y ? maxDepth : 0;
                        if (segmentExact && exactSegmentsIntersect(segmentExact[0], segmentExact[1], exactPoint(first), exactPoint(last))) return finish({ status: 'hit' });
                        sweepIndex++; if (++nodes > maxNodes) return finish({ status: 'uncertain', reason: 'Swept path node limit exhausted' });
                        stack.push({ path: segment, sweep: { points: [a, b], depth }, radius: segmentRadius }); continue;
                    }
                    segment = undefined; segmentExact = undefined; sweepIndex = 0; continue;
                }
                if (pathIndex >= allPaths.length) return finish(fillUncertain || curveUncertain
                    ? { status: 'uncertain', reason: 'Sweep touches an uncertified path boundary' } : { status: 'miss' });
                const path = allPaths[pathIndex];
                if (commandIndex >= path.length) {
                    if (pathIndex >= paths.length && start && previous && previous !== start) {
                        segmentRadius = fillRadius; segment = { points: [previous, start], depth: 0 }; segmentExact = [previousExact!, startExact!]; previous = start; previousExact = startExact; continue;
                    }
                    pathIndex++; commandIndex = 0; start = previous = undefined; startExact = previousExact = undefined; continue;
                }
                if (++commands > options.maxSegments) return finish({ status: 'uncertain', reason: 'Swept path command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') {
                    if (pathIndex >= paths.length && start && previous && previous !== start) {
                        commandIndex--; segmentRadius = fillRadius; segment = { points: [previous, start], depth: 0 }; segmentExact = [previousExact!, startExact!]; previous = start; previousExact = startExact; continue;
                    }
                    startExact = previousExact = exactAffinePoint(matrix, op.p); start = previous = exactPointIntervals(startExact); continue;
                }
                if (!start || !previous) throw new RangeError('Swept path must begin with M');
                const endExact = op.op === 'Z' ? startExact! : exactAffinePoint(matrix, op.p), end = exactPointIntervals(endExact);
                segmentRadius = pathIndex < paths.length ? strokeRadius : fillRadius;
                segment = { points: op.op === 'C' ? [previous, mapped(op.c1), mapped(op.c2), end] : [previous, end], depth: 0 };
                segmentExact = op.op === 'C' ? undefined : [previousExact!, endExact];
                previous = end; previousExact = endExact;
            }
            return PENDING;
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
