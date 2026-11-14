import { exactLineBetween, exactSide, sameExactPoint, type ExactPoint } from './homogeneous';
import { dyadicMultiply, dyadicSubtract } from './numeric';

function compare(a: ExactPoint, b: ExactPoint, axis: 'x' | 'y'): -1 | 0 | 1 {
    const value = dyadicSubtract(dyadicMultiply(a[axis], b.w), dyadicMultiply(b[axis], a.w)).n;
    return value < 0n ? -1 : value > 0n ? 1 : 0;
}
/** Exact closed-segment membership on homogeneous dyadic points. */
export function exactPointOnSegment(point: ExactPoint, a: ExactPoint, b: ExactPoint): boolean {
    if (sameExactPoint(a, b)) return sameExactPoint(point, a);
    return exactSide(exactLineBetween(a, b), point) === 0
        && compare(point, a, 'x') * compare(point, b, 'x') <= 0
        && compare(point, a, 'y') * compare(point, b, 'y') <= 0;
}
/** Exact closed-segment intersection, including tangency, overlap and points. */
export function exactSegmentsIntersect(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint): boolean {
    if (sameExactPoint(a, b)) return exactPointOnSegment(a, c, d);
    if (sameExactPoint(c, d)) return exactPointOnSegment(c, a, b);
    const ab = exactLineBetween(a, b), cd = exactLineBetween(c, d);
    const ac = exactSide(ab, c), ad = exactSide(ab, d), ca = exactSide(cd, a), cb = exactSide(cd, b);
    if (!ac && exactPointOnSegment(c, a, b)) return true;
    if (!ad && exactPointOnSegment(d, a, b)) return true;
    if (!ca && exactPointOnSegment(a, c, d)) return true;
    if (!cb && exactPointOnSegment(b, c, d)) return true;
    return ac * ad < 0 && ca * cb < 0;
}
