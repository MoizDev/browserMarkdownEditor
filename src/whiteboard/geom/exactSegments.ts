import { exactIntersection, exactLineBetween, exactSide, sameExactPoint, type ExactPoint } from './homogeneous';
import { dyadicMultiply, dyadicSubtract } from './numeric';

export function compareExactCoordinate(a: ExactPoint, b: ExactPoint, axis: 'x' | 'y'): -1 | 0 | 1 {
    const value = dyadicSubtract(dyadicMultiply(a[axis], b.w), dyadicMultiply(b[axis], a.w)).n;
    return value < 0n ? -1 : value > 0n ? 1 : 0;
}
/** Exact closed-segment membership on homogeneous dyadic points. */
export function exactPointOnSegment(point: ExactPoint, a: ExactPoint, b: ExactPoint): boolean {
    if (sameExactPoint(a, b)) return sameExactPoint(point, a);
    return exactSide(exactLineBetween(a, b), point) === 0
        && compareExactCoordinate(point, a, 'x') * compareExactCoordinate(point, b, 'x') <= 0
        && compareExactCoordinate(point, a, 'y') * compareExactCoordinate(point, b, 'y') <= 0;
}
/** Exact closed-segment intersection, including tangency, overlap and points. */
export type ExactSegmentIntersection = Readonly<{ kind: 'none' }> | Readonly<{ kind: 'point'; point: ExactPoint }>
    | Readonly<{ kind: 'overlap'; from: ExactPoint; to: ExactPoint }>;
/** Closed-segment intersection with a homogeneous rational witness. */
export function exactSegmentIntersection(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint): ExactSegmentIntersection {
    if (sameExactPoint(a, b)) return exactPointOnSegment(a, c, d) ? { kind: 'point', point: a } : { kind: 'none' };
    if (sameExactPoint(c, d)) return exactPointOnSegment(c, a, b) ? { kind: 'point', point: c } : { kind: 'none' };
    const ab = exactLineBetween(a, b), cd = exactLineBetween(c, d);
    const ac = exactSide(ab, c), ad = exactSide(ab, d), ca = exactSide(cd, a), cb = exactSide(cd, b);
    if (!ac && !ad && !ca && !cb) {
        const points = [a, b, c, d].filter(p => exactPointOnSegment(p, a, b) && exactPointOnSegment(p, c, d));
        if (!points.length) return { kind: 'none' };
        points.sort((p, q) => compareExactCoordinate(p, q, 'x') || compareExactCoordinate(p, q, 'y'));
        const from = points[0], to = points[points.length - 1];
        return sameExactPoint(from, to) ? { kind: 'point', point: from } : { kind: 'overlap', from, to };
    }
    if (!ac && exactPointOnSegment(c, a, b)) return { kind: 'point', point: c };
    if (!ad && exactPointOnSegment(d, a, b)) return { kind: 'point', point: d };
    if (!ca && exactPointOnSegment(a, c, d)) return { kind: 'point', point: a };
    if (!cb && exactPointOnSegment(b, c, d)) return { kind: 'point', point: b };
    if (ac * ad >= 0 || ca * cb >= 0) return { kind: 'none' };
    const point = exactIntersection(ab, cd);
    if (!point) throw new RangeError('Proper exact segments have parallel lines');
    return { kind: 'point', point };
}

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
