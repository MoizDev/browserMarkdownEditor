import type { Affine } from '../../platform/types';
import { dyadic, dyadicMultiply, dyadicSubtract, interval, add, multiply, type Dyadic, type Interval } from './numeric';
import { dyadicRatioInterval } from './dyadicRatio';
import { lowerPointHullDistance, splitCertifiedCurve, type BoundsPoint, type CertifiedCurve } from './pointPathJob';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import type { Vec2 } from './path';

export type AnisotropicPointResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface AnisotropicPointLimits { readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number }
type Range = Readonly<{ lo: Dyadic; hi: Dyadic; depth: number }>;
type Work = Readonly<{ curve: CertifiedCurve; exact: ExactCurve; x: Range; y: Range }>;
const PENDING: AnisotropicPointResult = Object.freeze({ status: 'pending' });
const ZERO: Dyadic = Object.freeze({ n: 0n, e: 0 });
const ONE: Dyadic = Object.freeze({ n: 1n, e: 0 });
function addExact(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function compare(a: Dyadic, b: Dyadic): -1 | 0 | 1 { const value = dyadicSubtract(a, b).n; return value < 0n ? -1 : value > 0n ? 1 : 0; }
function midpoint(a: Dyadic, b: Dyadic): Dyadic { const value = addExact(a, b); return { n: value.n, e: value.e - 1 }; }
function minimumMagnitude(range: Range): Dyadic {
    if (compare(range.lo, ZERO) > 0) return range.lo;
    if (compare(range.hi, ZERO) < 0) return { n: -range.hi.n, e: range.hi.e };
    return ZERO;
}
function bounds(range: Range): Interval {
    return { lo: dyadicRatioInterval(range.lo, ONE).lo, hi: dyadicRatioInterval(range.hi, ONE).hi };
}
function mapped(p: { readonly x: Dyadic; readonly y: Dyadic }): BoundsPoint {
    return { x: dyadicRatioInterval(p.x, ONE), y: dyadicRatioInterval(p.y, ONE) };
}
function initialCurve(exact: ExactCurve): CertifiedCurve {
    return { points: exact.map(mapped) as unknown as CertifiedCurve['points'], depth: 0 };
}

export function createAnisotropicPointJob(curve: ExactCurve, matrix: Affine, localRadius: number, point: Vec2, marginCss: number,
    limits: AnisotropicPointLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): AnisotropicPointResult; cancel(): void } {
    const maxDepth = limits.maxDepth ?? 32, maxNodes = limits.maxNodes ?? 262144, maxWork = limits.maxWork ?? 2000000;
    if (![...matrix, localRadius, point.x, point.y, marginCss].every(Number.isFinite) || localRadius < 0 || marginCss < 0
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid anisotropic point job');
    const [a, b, c, d] = matrix.map(dyadic), radius = dyadic(localRadius), radiusSquared = dyadicMultiply(radius, radius);
    const qx = dyadic(point.x), qy = dyadic(point.y), margin = dyadic(marginCss), marginSquared = dyadicMultiply(margin, margin);
    const initial: Range = { lo: { n: -radius.n, e: radius.e }, hi: radius, depth: localRadius ? 0 : maxDepth };
    const stack: Work[] = [{ curve: initialCurve(curve), exact: curve, x: initial, y: initial }];
    let finished: AnisotropicPointResult | undefined, cancelled = false, spent = 0, nodes = 1, uncertain = false;
    const finish = (value: AnisotropicPointResult): AnisotropicPointResult => { finished = Object.freeze(value); return finished; };
    const outsideDisk = (x: Range, y: Range) => {
        const u = minimumMagnitude(x), v = minimumMagnitude(y);
        return compare(addExact(dyadicMultiply(u, u), dyadicMultiply(v, v)), radiusSquared) > 0;
    };
    const witness = (source: ExactCurve[number], u: Dyadic, v: Dyadic): boolean => {
        if (compare(addExact(dyadicMultiply(u, u), dyadicMultiply(v, v)), radiusSquared) > 0) return false;
        const x = addExact(source.x, addExact(dyadicMultiply(a, u), dyadicMultiply(c, v)));
        const y = addExact(source.y, addExact(dyadicMultiply(b, u), dyadicMultiply(d, v)));
        const dx = dyadicSubtract(x, qx), dy = dyadicSubtract(y, qy);
        return compare(addExact(dyadicMultiply(dx, dx), dyadicMultiply(dy, dy)), marginSquared) <= 0;
    };
    const imageBounds = (work: Work): readonly [BoundsPoint, BoundsPoint] => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of work.curve.points) { x0 = Math.min(x0, p.x.lo); y0 = Math.min(y0, p.y.lo); x1 = Math.max(x1, p.x.hi); y1 = Math.max(y1, p.y.hi); }
        const u = bounds(work.x), v = bounds(work.y);
        const x = add(multiply(interval(matrix[0]), u), multiply(interval(matrix[2]), v));
        const y = add(multiply(interval(matrix[1]), u), multiply(interval(matrix[3]), v));
        return [{ x: add(interval(x0), x), y: add(interval(y0), y) }, { x: add(interval(x1), x), y: add(interval(y1), y) }];
    };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid anisotropic point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Anisotropic point job cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Anisotropic point work limit exhausted' });
                    const item = stack.pop();
                    if (!item) return finish(uncertain ? { status: 'uncertain', reason: 'Anisotropic point boundary cannot be certified' } : { status: 'miss' });
                    if (outsideDisk(item.x, item.y)) continue;
                    const box = imageBounds(item), lower = lowerPointHullDistance(point, box);
                    if (!Number.isFinite(lower)) { uncertain = true; continue; }
                    if (lower > marginCss) continue;
                    const u = midpoint(item.x.lo, item.x.hi), v = midpoint(item.y.lo, item.y.hi);
                    if (witness(item.exact[0], u, v) || witness(item.exact[item.exact.length - 1], u, v)) return finish({ status: 'hit' });
                    const curveDepth = item.curve.depth, xDepth = item.x.depth, yDepth = item.y.depth;
                    if (curveDepth >= maxDepth && xDepth >= maxDepth && yDepth >= maxDepth) { uncertain = true; continue; }
                    if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Anisotropic point node limit exhausted' });
                    if (curveDepth <= xDepth && curveDepth <= yDepth && curveDepth < maxDepth) {
                        const [left, right] = splitCertifiedCurve(item.curve), [exactLeft, exactRight] = splitExactCurve(item.exact);
                        stack.push({ ...item, curve: right, exact: exactRight }, { ...item, curve: left, exact: exactLeft });
                    } else if (xDepth <= yDepth && xDepth < maxDepth) {
                        const m = midpoint(item.x.lo, item.x.hi), depth = xDepth + 1;
                        stack.push({ ...item, x: { lo: m, hi: item.x.hi, depth } }, { ...item, x: { lo: item.x.lo, hi: m, depth } });
                    } else if (yDepth < maxDepth) {
                        const m = midpoint(item.y.lo, item.y.hi), depth = yDepth + 1;
                        stack.push({ ...item, y: { lo: m, hi: item.y.hi, depth } }, { ...item, y: { lo: item.y.lo, hi: m, depth } });
                    } else if (curveDepth < maxDepth) {
                        const [left, right] = splitCertifiedCurve(item.curve), [exactLeft, exactRight] = splitExactCurve(item.exact);
                        stack.push({ ...item, curve: right, exact: exactRight }, { ...item, curve: left, exact: exactLeft });
                    } else { uncertain = true; continue; }
                    nodes += 2;
                }
                return PENDING;
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                return finish({ status: 'uncertain', reason: error.message });
            }
        },
        cancel() { cancelled = true; stack.length = 0; },
    };
}
