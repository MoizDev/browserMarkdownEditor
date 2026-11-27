import type { Affine } from '../../platform/types';
import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import type { ExactCurvePoint } from './cubicRootCertificate';

function add(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }

export function createExactInverseDistance(matrix: Affine): {
    map(point: ExactCurvePoint): ExactCurvePoint;
    radius(localRadius: number): Dyadic;
} | null {
    if (!matrix.every(Number.isFinite)) throw new RangeError('Invalid exact inverse transform');
    const [a, b, c, d, e, f] = matrix.map(dyadic), determinant = dyadicSubtract(dyadicMultiply(a, d), dyadicMultiply(b, c));
    if (!determinant.n) return null;
    const magnitude = { n: determinant.n < 0n ? -determinant.n : determinant.n, e: determinant.e };
    return {
        map(point) {
            const x = dyadicSubtract(point.x, e), y = dyadicSubtract(point.y, f);
            return { x: dyadicSubtract(dyadicMultiply(d, x), dyadicMultiply(c, y)),
                y: add(dyadicMultiply({ n: -b.n, e: b.e }, x), dyadicMultiply(a, y)) };
        },
        radius(localRadius) {
            if (!Number.isFinite(localRadius) || localRadius < 0) throw new RangeError('Invalid exact inverse radius');
            return dyadicMultiply(magnitude, dyadic(localRadius));
        },
    };
}
