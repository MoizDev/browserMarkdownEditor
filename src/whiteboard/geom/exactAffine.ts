import type { Affine } from '../../platform/types';
import type { Vec2 } from './path';
import type { ExactPoint } from './homogeneous';
import { add, subtract, multiply, interval, sqrtInterval, dyadic, dyadicMultiply, dyadicSubtract, type Dyadic, type Interval } from './numeric';

const plus = (a: Dyadic, b: Dyadic): Dyadic => dyadicSubtract(a, { n: -b.n, e: b.e });
/** Matrix coefficients and source coordinates are exact binary64 inputs. Do not
 * make a rounded world vertex the authority for clipping a distant thin frame. */
export function exactAffinePoint(matrix: Affine, point: Vec2): ExactPoint {
    if (matrix.length !== 6 || !matrix.every(Number.isFinite) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid exact affine input');
    const x = dyadic(point.x), y = dyadic(point.y);
    const row = (a: number, b: number, t: number) => plus(plus(dyadicMultiply(dyadic(a), x), dyadicMultiply(dyadic(b), y)), dyadic(t));
    return { x: row(matrix[0], matrix[2], matrix[4]), y: row(matrix[1], matrix[3], matrix[5]), w: dyadic(1) };
}
function square(value: Interval): Interval {
    const result = multiply(value, value);
    return { lo: Math.max(0, result.lo), hi: result.hi };
}
/** An affine round cap is an ellipse. Inner/outer singular radii bound that
 * ellipse, including the small non-orthogonality of composed rotation matrices. */
export function affineRadiusScale(matrix: Affine): Interval {
    if (matrix.length !== 6 || !matrix.every(Number.isFinite)) throw new RangeError('Invalid affine radius input');
    const [a, b, c, d] = matrix.map(interval);
    const aa = add(square(a), square(b)), cc = add(square(c), square(d));
    const ac = add(multiply(a, c), multiply(b, d)), sum = add(aa, cc);
    const difference = sqrtInterval(add(square(subtract(aa, cc)), multiply(interval(4), square(ac))));
    const low = multiply(interval(0.5), subtract(sum, difference)), high = multiply(interval(0.5), add(sum, difference));
    return { lo: sqrtInterval({ lo: Math.max(0, low.lo), hi: Math.max(0, low.hi) }).lo,
        hi: sqrtInterval({ lo: Math.max(0, high.lo), hi: Math.max(0, high.hi) }).hi };
}
