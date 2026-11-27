import type { Affine } from '../../platform/types';
import { add, dyadic, dyadicMultiply, dyadicSubtract, interval, multiply, type Dyadic, type Interval } from './numeric';
import { dyadicRatioInterval } from './dyadicRatio';
import { splitCertifiedCurve, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import { lowerCurvePairDistance } from './sweptPathJob';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import type { Vec2 } from './path';
import type { ExactCurvePoint } from './cubicRootCertificate';

export type AnisotropicSweepResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
type Range = Readonly<{ lo: Dyadic; hi: Dyadic; depth: number }>;
type Work = Readonly<{ curve: CertifiedCurve; exact: ExactCurve; x: Range; y: Range }>;
const ZERO: Dyadic = Object.freeze({ n: 0n, e: 0 }), ONE: Dyadic = Object.freeze({ n: 1n, e: 0 });
const PENDING: AnisotropicSweepResult = Object.freeze({ status: 'pending' });
const opposite = (value: Dyadic): Dyadic => ({ n: -value.n, e: value.e });
function sum(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, opposite(b)); }
function compare(a: Dyadic, b: Dyadic): -1 | 0 | 1 { const n = dyadicSubtract(a, b).n; return n < 0n ? -1 : n > 0n ? 1 : 0; }
function mid(a: Dyadic, b: Dyadic): Dyadic { const value = sum(a, b); return { n: value.n, e: value.e - 1 }; }
function norm2(x: Dyadic, y: Dyadic): Dyadic { return sum(dyadicMultiply(x, x), dyadicMultiply(y, y)); }
function minMagnitude(range: Range): Dyadic {
    if (compare(range.lo, ZERO) > 0) return range.lo;
    if (compare(range.hi, ZERO) < 0) return opposite(range.hi);
    return ZERO;
}
function enclose(range: Range): Interval { return { lo: dyadicRatioInterval(range.lo, ONE).lo, hi: dyadicRatioInterval(range.hi, ONE).hi }; }
function pointBounds(p: { readonly x: Dyadic; readonly y: Dyadic }): BoundsPoint { return { x: dyadicRatioInterval(p.x, ONE), y: dyadicRatioInterval(p.y, ONE) }; }

export function createAnisotropicSweepJob(curve: ExactCurve, matrix: Affine, localRadius: number, start: Vec2 | ExactCurvePoint, end: Vec2 | ExactCurvePoint, marginCss: number,
    limits: { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number } = {}): {
        step(budget: { readonly deadline: number; readonly maxWork: number }): AnisotropicSweepResult; cancel(): void;
    } {
    const maxDepth = limits.maxDepth ?? 32, maxNodes = limits.maxNodes ?? 262144, maxWork = limits.maxWork ?? 2000000;
    const validPoint = (p: Vec2 | ExactCurvePoint) => typeof p.x === 'number' && typeof p.y === 'number'
        ? Number.isFinite(p.x) && Number.isFinite(p.y) : typeof p.x !== 'number' && typeof p.y !== 'number'
            && Number.isSafeInteger(p.x.e) && Number.isSafeInteger(p.y.e);
    if (![...matrix, localRadius, marginCss].every(Number.isFinite) || !validPoint(start) || !validPoint(end) || localRadius < 0 || marginCss < 0
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid anisotropic sweep job');
    const [a, b, c, d] = matrix.map(dyadic), radius = dyadic(localRadius), radiusSquared = dyadicMultiply(radius, radius);
    const exact = (value: number | Dyadic): Dyadic => typeof value === 'number' ? dyadic(value) : value;
    const sx = exact(start.x), sy = exact(start.y), ex = exact(end.x), ey = exact(end.y), vx = dyadicSubtract(ex, sx), vy = dyadicSubtract(ey, sy);
    const lengthSquared = norm2(vx, vy), margin = dyadic(marginCss), marginSquared = dyadicMultiply(margin, margin);
    const sweep: readonly [BoundsPoint, BoundsPoint] = [pointBounds({ x: sx, y: sy }), pointBounds({ x: ex, y: ey })];
    const initial: Range = { lo: opposite(radius), hi: radius, depth: localRadius ? 0 : maxDepth };
    const stack: Work[] = [{ exact: curve, curve: { points: curve.map(pointBounds) as unknown as CertifiedCurve['points'], depth: 0 }, x: initial, y: initial }];
    let finished: AnisotropicSweepResult | undefined, cancelled = false, nodes = 1, spent = 0, uncertain = false;
    const finish = (result: AnisotropicSweepResult): AnisotropicSweepResult => { finished = Object.freeze(result); return finished; };
    const outside = (x: Range, y: Range) => compare(norm2(minMagnitude(x), minMagnitude(y)), radiusSquared) > 0;
    const inSweep = (x: Dyadic, y: Dyadic): boolean => {
        const dx = dyadicSubtract(x, sx), dy = dyadicSubtract(y, sy), along = sum(dyadicMultiply(dx, vx), dyadicMultiply(dy, vy));
        if (compare(along, ZERO) <= 0 || !lengthSquared.n) return compare(norm2(dx, dy), marginSquared) <= 0;
        if (compare(along, lengthSquared) >= 0) return compare(norm2(dyadicSubtract(x, ex), dyadicSubtract(y, ey)), marginSquared) <= 0;
        const cross = dyadicSubtract(dyadicMultiply(dx, vy), dyadicMultiply(dy, vx));
        return compare(dyadicMultiply(cross, cross), dyadicMultiply(marginSquared, lengthSquared)) <= 0;
    };
    const witness = (p: ExactCurve[number], u: Dyadic, v: Dyadic): boolean => {
        if (compare(norm2(u, v), radiusSquared) > 0) return false;
        return inSweep(sum(p.x, sum(dyadicMultiply(a, u), dyadicMultiply(c, v))), sum(p.y, sum(dyadicMultiply(b, u), dyadicMultiply(d, v))));
    };
    const imageBox = (work: Work): readonly [BoundsPoint, BoundsPoint] => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of work.curve.points) { x0 = Math.min(x0, p.x.lo); y0 = Math.min(y0, p.y.lo); x1 = Math.max(x1, p.x.hi); y1 = Math.max(y1, p.y.hi); }
        const u = enclose(work.x), v = enclose(work.y), x = add(multiply(interval(matrix[0]), u), multiply(interval(matrix[2]), v));
        const y = add(multiply(interval(matrix[1]), u), multiply(interval(matrix[3]), v));
        return [{ x: add(interval(x0), x), y: add(interval(y0), y) }, { x: add(interval(x1), x), y: add(interval(y1), y) }];
    };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid anisotropic sweep slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Anisotropic sweep job cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Anisotropic sweep work limit exhausted' });
                    const item = stack.pop();
                    if (!item) return finish(uncertain ? { status: 'uncertain', reason: 'Anisotropic sweep boundary cannot be certified' } : { status: 'miss' });
                    if (outside(item.x, item.y)) continue;
                    const lower = lowerCurvePairDistance(imageBox(item), sweep);
                    if (!Number.isFinite(lower)) { uncertain = true; continue; }
                    if (lower > marginCss) continue;
                    const u = mid(item.x.lo, item.x.hi), v = mid(item.y.lo, item.y.hi);
                    if (witness(item.exact[0], u, v) || witness(item.exact[item.exact.length - 1], u, v)) return finish({ status: 'hit' });
                    const cd = item.curve.depth, xd = item.x.depth, yd = item.y.depth;
                    if (cd >= maxDepth && xd >= maxDepth && yd >= maxDepth) { uncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Anisotropic sweep node limit exhausted' });
                    if (cd <= xd && cd <= yd && cd < maxDepth) {
                        const [left, right] = splitCertifiedCurve(item.curve), [exactLeft, exactRight] = splitExactCurve(item.exact);
                        stack.push({ ...item, curve: right, exact: exactRight }, { ...item, curve: left, exact: exactLeft });
                    } else if (xd <= yd && xd < maxDepth) {
                        const middle = mid(item.x.lo, item.x.hi), depth = xd + 1;
                        stack.push({ ...item, x: { lo: middle, hi: item.x.hi, depth } }, { ...item, x: { lo: item.x.lo, hi: middle, depth } });
                    } else if (yd < maxDepth) {
                        const middle = mid(item.y.lo, item.y.hi), depth = yd + 1;
                        stack.push({ ...item, y: { lo: middle, hi: item.y.hi, depth } }, { ...item, y: { lo: item.y.lo, hi: middle, depth } });
                    } else if (cd < maxDepth) {
                        const [left, right] = splitCertifiedCurve(item.curve), [exactLeft, exactRight] = splitExactCurve(item.exact);
                        stack.push({ ...item, curve: right, exact: exactRight }, { ...item, curve: left, exact: exactLeft });
                    } else { uncertain = true; continue; }
                    nodes += 2;
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
