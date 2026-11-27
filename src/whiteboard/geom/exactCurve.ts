import { dyadicSubtract, type Dyadic } from './numeric';
import type { ExactCurvePoint } from './cubicRootCertificate';

export type ExactCurve = readonly [ExactCurvePoint, ExactCurvePoint]
    | readonly [ExactCurvePoint, ExactCurvePoint, ExactCurvePoint, ExactCurvePoint];
function midpoint(a: Dyadic, b: Dyadic): Dyadic {
    const sum = dyadicSubtract(a, { n: -b.n, e: b.e }); return { n: sum.n, e: sum.e - 1 };
}
function middle(a: ExactCurvePoint, b: ExactCurvePoint): ExactCurvePoint {
    return { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y) };
}
export function splitExactCurve(points: ExactCurve): readonly [ExactCurve, ExactCurve] {
    if (points.length === 2) {
        const m = middle(points[0], points[1]); return [[points[0], m], [m, points[1]]];
    }
    const a = middle(points[0], points[1]), b = middle(points[1], points[2]), c = middle(points[2], points[3]);
    const d = middle(a, b), e = middle(b, c), m = middle(d, e);
    return [[points[0], a, d, m], [m, e, c, points[3]]];
}
