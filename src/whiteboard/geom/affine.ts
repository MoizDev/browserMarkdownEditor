import type { Affine } from '../../platform/types';
import type { Vec2 } from './path';
import { inverseAffine, multiplyAffine } from './bounds';

export function transformPoint(m: Affine, p: Vec2): Vec2 {
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}
export function compose(a: Affine, b: Affine): Affine {
    const out = new Float64Array(6);
    multiplyAffine(out, 0, a, 0, b, 0);
    return [out[0], out[1], out[2], out[3], out[4], out[5]];
}
export function singularValues(m: Affine): readonly [number, number] {
    const scale = Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
    if (!Number.isFinite(scale)) throw new RangeError('Non-finite transform');
    if (scale === 0) return [0, 0];
    const a = m[0] / scale, b = m[1] / scale, c = m[2] / scale, d = m[3] / scale;
    const sum = Math.hypot(a + d, b - c), difference = Math.hypot(a - d, b + c);
    const largest = (sum + difference) * scale / 2;
    const smallest = Math.abs(a * d - b * c) * scale / ((sum + difference) / 2);
    return [largest, smallest];
}
// Refuse poorly conditioned inverses; callers use forward geometry instead.
export function inverse(m: Affine, maxCondition: number): Affine | null {
    if (!(maxCondition >= 1) || !Number.isFinite(maxCondition)) throw new RangeError('Invalid conditioning limit');
    const [largest, smallest] = singularValues(m);
    if (!(smallest > 0) || largest / smallest > maxCondition) return null;
    const out = new Float64Array(6);
    return inverseAffine(out, 0, m) ? [out[0], out[1], out[2], out[3], out[4], out[5]] : null;
}
