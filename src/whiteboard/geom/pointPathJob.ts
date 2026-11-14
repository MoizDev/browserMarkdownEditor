import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactPointIntervals } from './homogeneous';
import { createFillPointJob } from './fillPoint';
import { add, dyadic, dyadicMultiply, dyadicSubtract, interval, multiply, sqrtInterval, subtract, type Interval } from './numeric';
import type { PathOp, Vec2 } from './path';
import type { PathPickOptions } from './pick';
import type { PointQuery } from './types';

export type PointPathJobResult =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'hit'; distanceCss: number }>
    | Readonly<{ status: 'miss'; distanceCss: number }>
    | Readonly<{ status: 'uncertain'; reason: string }>;
export interface PointPathJobLimits {
    readonly maxDepth?: number;
    readonly maxNodes?: number;
    readonly maxWork?: number;
}
export type BoundsPoint = Readonly<{ x: Interval; y: Interval }>;
export type CertifiedCurve = Readonly<{ points: readonly [BoundsPoint, BoundsPoint] | readonly [BoundsPoint, BoundsPoint, BoundsPoint, BoundsPoint]; depth: number }>;
type Curve = CertifiedCurve;
const PENDING: PointPathJobResult = Object.freeze({ status: 'pending' });
const opposite = (value: { readonly n: bigint; readonly e: number }) => ({ n: -value.n, e: value.e });
function addDyadic(a: ReturnType<typeof dyadic>, b: ReturnType<typeof dyadic>) { return dyadicSubtract(a, opposite(b)); }
export function isUniformDistanceMatrix(matrix: Affine): boolean {
    const [a, b, c, d] = matrix.map(dyadic), aa = dyadicMultiply(a, a), bb = dyadicMultiply(b, b);
    const cc = dyadicMultiply(c, c), dd = dyadicMultiply(d, d);
    return dyadicSubtract(addDyadic(aa, bb), addDyadic(cc, dd)).n === 0n
        && addDyadic(dyadicMultiply(a, c), dyadicMultiply(b, d)).n === 0n;
}
function middle(a: BoundsPoint, b: BoundsPoint): BoundsPoint {
    const half = interval(0.5);
    return { x: multiply(add(a.x, b.x), half), y: multiply(add(a.y, b.y), half) };
}
export function splitCertifiedCurve(curve: Curve): readonly [Curve, Curve] {
    const p = curve.points, depth = curve.depth + 1;
    if (p.length === 2) {
        const m = middle(p[0], p[1]);
        return [{ points: [p[0], m], depth }, { points: [m, p[1]], depth }];
    }
    const a = middle(p[0], p[1]), b = middle(p[1], p[2]), c = middle(p[2], p[3]);
    const d = middle(a, b), e = middle(b, c), m = middle(d, e);
    return [{ points: [p[0], a, d, m], depth }, { points: [m, e, c, p[3]], depth }];
}
function square(value: number): Interval { return multiply(interval(value), interval(value)); }
function upperDistance(point: Vec2, target: BoundsPoint): number {
    const dx = subtract(target.x, interval(point.x)), dy = subtract(target.y, interval(point.y));
    const x = Math.max(Math.abs(dx.lo), Math.abs(dx.hi)), y = Math.max(Math.abs(dy.lo), Math.abs(dy.hi));
    const sum = add(square(x), square(y)); return sqrtInterval({ lo: Math.max(0, sum.lo), hi: sum.hi }).hi;
}
function lowerDistance(point: Vec2, points: Curve['points']): number {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const p of points) { left = Math.min(left, p.x.lo); top = Math.min(top, p.y.lo); right = Math.max(right, p.x.hi); bottom = Math.max(bottom, p.y.hi); }
    const x = point.x < left ? Math.max(0, subtract(interval(left), interval(point.x)).lo)
        : point.x > right ? Math.max(0, subtract(interval(point.x), interval(right)).lo) : 0;
    const y = point.y < top ? Math.max(0, subtract(interval(top), interval(point.y)).lo)
        : point.y > bottom ? Math.max(0, subtract(interval(point.y), interval(bottom)).lo) : 0;
    const sum = add(square(x), square(y)); return sqrtInterval({ lo: Math.max(0, sum.lo), hi: sum.hi }).lo;
}

/** Resumable point/path classifier. Every hit has an actual curve witness inside
 * the closed CSS radius; every miss excludes every exact transformed control hull.
 * A boundary, arithmetic limit or exhausted budget is explicit uncertainty. */
export function createPointPathJob(paths: readonly (readonly PathOp[])[], query: PointQuery, options: PathPickOptions,
    limits: PointPathJobLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): PointPathJobResult; cancel(): void } {
    const matrix = query.localToSurface, margin = query.input === 'touch' ? Math.max(8, options.marginCss) : options.marginCss;
    const maxDepth = limits.maxDepth ?? 64, maxNodes = limits.maxNodes ?? 131072, maxWork = limits.maxWork ?? 1000000;
    if (![query.point.x, query.point.y, ...matrix, margin, options.strokeRadiusLocal, options.errorCss].every(Number.isFinite)
        || margin < 0 || options.strokeRadiusLocal < 0 || options.errorCss <= 0 || !Number.isSafeInteger(options.maxSegments) || options.maxSegments < 1
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid point path job');
    let finished: PointPathJobResult | undefined, cancelled = false, spent = 0, nodes = 0, commands = 0;
    if (!isUniformDistanceMatrix(matrix)) finished = { status: 'uncertain', reason: 'Nonuniform stroke transform requires an anisotropic distance certificate' };
    const scaleSquared = add(square(matrix[0]), square(matrix[1]));
    const scale = sqrtInterval({ lo: Math.max(0, scaleSquared.lo), hi: scaleSquared.hi });
    const radius = add(multiply(interval(options.strokeRadiusLocal), scale), interval(margin));
    if (![radius.lo, radius.hi].every(Number.isFinite)) finished = { status: 'uncertain', reason: 'Point path radius overflows' };
    const fill = options.interiorPaths?.length
        ? createFillPointJob(options.interiorPaths, query.point, 'nonzero', { localToWorld: matrix, maxCommands: options.maxSegments }) : undefined;
    let fillPending = !!fill, fillUncertain = false, curveUncertain = false, pathIndex = 0, commandIndex = 0;
    let start: BoundsPoint | undefined, previous: BoundsPoint | undefined, bestUpper = Infinity;
    const stack: Curve[] = [];
    const mapped = (point: Vec2): BoundsPoint => exactPointIntervals(exactAffinePoint(matrix, point));
    const finish = (value: PointPathJobResult): PointPathJobResult => { finished = Object.freeze(value); return finished; };
    const push = (points: Curve['points']) => {
        if (++nodes > maxNodes) return false;
        stack.push({ points, depth: 0 }); return true;
    };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid point path slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Point path job cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Point path work limit exhausted' });
                if (fillPending) {
                    const state = fill!.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    fillPending = false;
                    if (state.status === 'inside') return finish({ status: 'hit', distanceCss: 0 });
                    if (state.status === 'uncertain') fillUncertain = true;
                    continue;
                }
                const curve = stack.pop();
                if (curve) {
                    const lower = lowerDistance(query.point, curve.points);
                    if (!Number.isFinite(lower)) return finish({ status: 'uncertain', reason: 'Point path distance overflows' });
                    if (lower > radius.hi) continue;
                    const upper = Math.min(upperDistance(query.point, curve.points[0]), upperDistance(query.point, curve.points[curve.points.length - 1]));
                    bestUpper = Math.min(bestUpper, upper);
                    if (upper <= radius.lo) return finish({ status: 'hit', distanceCss: upper });
                    if (curve.depth >= maxDepth) { curveUncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Point path node limit exhausted' });
                    const [left, right] = splitCertifiedCurve(curve); nodes += 2; stack.push(right, left); continue;
                }
                if (pathIndex >= paths.length) return finish(fillUncertain || curveUncertain
                    ? { status: 'uncertain', reason: 'Point lies on or too near a path boundary' }
                    : { status: 'miss', distanceCss: bestUpper });
                const path = paths[pathIndex];
                if (commandIndex >= path.length) { pathIndex++; commandIndex = 0; start = previous = undefined; continue; }
                if (++commands > options.maxSegments) return finish({ status: 'uncertain', reason: 'Point path command limit exhausted' });
                const op = path[commandIndex++];
                if (op.op === 'M') { start = previous = mapped(op.p); continue; }
                if (!start || !previous) throw new RangeError('Point path must begin with M');
                const end = op.op === 'Z' ? start : mapped(op.p);
                const points: Curve['points'] = op.op === 'C' ? [previous, mapped(op.c1), mapped(op.c2), end] : [previous, end];
                if (!push(points)) return finish({ status: 'uncertain', reason: 'Point path node limit exhausted' });
                previous = end;
            }
            return PENDING;
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
