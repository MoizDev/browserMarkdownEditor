import type { Affine } from '../../platform/types';
import { dyadicRatioInterval } from './dyadicRatio';
import { add, dyadic, dyadicMultiply, dyadicSubtract, interval, multiply, sqrtInterval, type Interval } from './numeric';

const opposite = (value: { readonly n: bigint; readonly e: number }) => ({ n: -value.n, e: value.e });
function addDyadic(a: ReturnType<typeof dyadic>, b: ReturnType<typeof dyadic>) { return dyadicSubtract(a, opposite(b)); }
function square(value: number): Interval { return multiply(interval(value), interval(value)); }

/** Exact dyadic test, not a tolerance on an almost-similarity matrix. */
export function isUniformDistanceMatrix(matrix: Affine): boolean {
    const [a, b, c, d] = matrix.map(dyadic), aa = dyadicMultiply(a, a), bb = dyadicMultiply(b, b);
    const cc = dyadicMultiply(c, c), dd = dyadicMultiply(d, d);
    return dyadicSubtract(addDyadic(aa, bb), addDyadic(cc, dd)).n === 0n
        && addDyadic(dyadicMultiply(a, c), dyadicMultiply(b, d)).n === 0n;
}

/** Enclose the affine image of a local round stroke between concentric CSS
 * disks. Similarities use their exact uniform norm; other matrices use the
 * Frobenius upper and determinant/Frobenius lower singular-value bounds. */
export function strokeRadiusBounds(matrix: Affine, localRadius: number): Interval | null {
    if (!matrix.every(Number.isFinite) || !Number.isFinite(localRadius) || localRadius < 0) throw new RangeError('Invalid stroke transform');
    if (!localRadius) return interval(0);
    const first = add(square(matrix[0]), square(matrix[1])), uniform = isUniformDistanceMatrix(matrix);
    const squared = uniform ? first : add(first, add(square(matrix[2]), square(matrix[3])));
    if (!Number.isFinite(squared.hi) || squared.hi < 0) return null;
    const upperScale = sqrtInterval({ lo: Math.max(0, squared.lo), hi: squared.hi });
    let lower = upperScale.lo;
    if (!uniform) {
        const determinant = dyadicSubtract(dyadicMultiply(dyadic(matrix[0]), dyadic(matrix[3])), dyadicMultiply(dyadic(matrix[1]), dyadic(matrix[2])));
        if (!determinant.n || !upperScale.hi) lower = 0;
        else {
            const absolute = { n: determinant.n < 0n ? -determinant.n : determinant.n, e: determinant.e };
            try { lower = Math.max(0, dyadicRatioInterval(absolute, dyadic(upperScale.hi)).lo); }
            catch (error) { if (error instanceof RangeError) return null; throw error; }
        }
    }
    const result = multiply({ lo: Math.max(0, lower), hi: upperScale.hi }, interval(localRadius));
    if (!Number.isFinite(result.lo) || !Number.isFinite(result.hi)) return null;
    return { lo: Math.max(0, result.lo), hi: Math.max(0, result.hi) };
}
