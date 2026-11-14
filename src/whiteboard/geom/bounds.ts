import { add, divide, interval, multiply, nextDown, nextUp, sqrtInterval, subtract } from './numeric';
import type { Interval } from './numeric';
import type { Arc, Cubic } from './path';

// Packed scene/index boxes use [minX,minY,maxX,maxY], never Float32 absolute positions.
export type Box = readonly [number, number, number, number];
export function validBox(a: ArrayLike<number>, offset = 0): boolean {
    return Number.isFinite(a[offset]) && Number.isFinite(a[offset + 1]) && Number.isFinite(a[offset + 2])
        && Number.isFinite(a[offset + 3]) && a[offset] <= a[offset + 2] && a[offset + 1] <= a[offset + 3];
}
export function writeBox(out: Float64Array, offset: number, x0: number, y0: number, x1: number, y1: number): void {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || x1 < x0 || y1 < y0) {
        throw new RangeError('Scene bounds must be finite and ordered');
    }
    out[offset] = x0; out[offset + 1] = y0; out[offset + 2] = x1; out[offset + 3] = y1;
}
export function unionBox(out: Float64Array, offset: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
    out[offset] = Math.min(a[ai], b[bi]); out[offset + 1] = Math.min(a[ai + 1], b[bi + 1]);
    out[offset + 2] = Math.max(a[ai + 2], b[bi + 2]); out[offset + 3] = Math.max(a[ai + 3], b[bi + 3]);
}
export function intersects(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): boolean {
    return a[ai] <= b[bi + 2] && b[bi] <= a[ai + 2] && a[ai + 1] <= b[bi + 3] && b[bi + 1] <= a[ai + 3];
}
export function transformBox(out: Float64Array, offset: number, box: ArrayLike<number>, start: number, matrix: ArrayLike<number>, mi = 0): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const x = box[start + (i & 1 ? 2 : 0)], y = box[start + (i & 2 ? 3 : 1)];
        const wx = add(add(multiply(interval(matrix[mi]), interval(x)), multiply(interval(matrix[mi + 2]), interval(y))), interval(matrix[mi + 4]));
        const wy = add(add(multiply(interval(matrix[mi + 1]), interval(x)), multiply(interval(matrix[mi + 3]), interval(y))), interval(matrix[mi + 5]));
        minX = Math.min(minX, wx.lo); minY = Math.min(minY, wy.lo); maxX = Math.max(maxX, wx.hi); maxY = Math.max(maxY, wy.hi);
    }
    writeBox(out, offset, minX, minY, maxX, maxY);
}
export function multiplyAffine(out: Float64Array, oi: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
    const x0 = a[ai] * b[bi] + a[ai + 2] * b[bi + 1], y0 = a[ai + 1] * b[bi] + a[ai + 3] * b[bi + 1];
    const x1 = a[ai] * b[bi + 2] + a[ai + 2] * b[bi + 3], y1 = a[ai + 1] * b[bi + 2] + a[ai + 3] * b[bi + 3];
    const x = a[ai] * b[bi + 4] + a[ai + 2] * b[bi + 5] + a[ai + 4], y = a[ai + 1] * b[bi + 4] + a[ai + 3] * b[bi + 5] + a[ai + 5];
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Scene transform overflows');
    out[oi] = x0; out[oi + 1] = y0; out[oi + 2] = x1; out[oi + 3] = y1; out[oi + 4] = x; out[oi + 5] = y;
}
// Roots that cannot be certified fall back to the control hull, never a smaller envelope.
function cubicAxis(p0: number, p1: number, p2: number, p3: number): readonly [number, number] {
    const points = [p0, p1, p2, p3];
    if (!points.every(Number.isFinite)) throw new RangeError('Non-finite cubic');
    const hull: readonly [number, number] = [nextDown(Math.min(...points)), nextUp(Math.max(...points))];
    const p = points.map(interval), two = interval(2), three = interval(3), four = interval(4);
    const a = add(subtract(p[3], p[0]), multiply(three, subtract(p[1], p[2])));
    const b = multiply(two, add(subtract(p[0], multiply(two, p[1])), p[2]));
    const c = subtract(p[1], p[0]);
    if (a.lo <= 0 && a.hi >= 0) return hull;
    const discriminant = subtract(multiply(b, b), multiply(four, multiply(a, c)));
    if (discriminant.hi < 0) return [nextDown(Math.min(p0, p3)), nextUp(Math.max(p0, p3))];
    if (discriminant.lo <= 0 || !Number.isFinite(discriminant.hi)) return hull;
    const root = sqrtInterval(discriminant), denom = multiply(two, a);
    const roots = [divide(subtract(interval(0), add(b, root)), denom), divide(subtract(root, b), denom)];
    let lo = Math.min(p0, p3), hi = Math.max(p0, p3);
    const lerp = (x: Interval, y: Interval, t: Interval) => add(multiply(x, subtract(interval(1), t)), multiply(y, t));
    for (const candidate of roots) {
        if (candidate.hi < 0 || candidate.lo > 1) continue;
        if (!Number.isFinite(candidate.lo) || !Number.isFinite(candidate.hi)) return hull;
        const t = { lo: Math.max(0, candidate.lo), hi: Math.min(1, candidate.hi) };
        const q0 = lerp(p[0], p[1], t), q1 = lerp(p[1], p[2], t), q2 = lerp(p[2], p[3], t);
        const value = lerp(lerp(q0, q1, t), lerp(q1, q2, t), t);
        lo = Math.min(lo, value.lo); hi = Math.max(hi, value.hi);
    }
    return [Math.max(hull[0], nextDown(lo)), Math.min(hull[1], nextUp(hi))];
}
export function cubicBounds(curve: Cubic): Box {
    const x = cubicAxis(curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x);
    const y = cubicAxis(curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y);
    return [x[0], y[0], x[1], y[1]];
}
export function arcBounds(arc: Arc): Box {
    const { centre, radius, start, sweep } = arc;
    if (![centre.x, centre.y, radius, start, sweep].every(Number.isFinite) || radius < 0) throw new RangeError('Invalid arc');
    const full = (): Box => [nextDown(centre.x - radius), nextDown(centre.y - radius), nextUp(centre.x + radius), nextUp(centre.y + radius)];
    if (Math.abs(sweep) >= 2 * Math.PI || Math.abs(start) > 2 ** 40) return full();
    const end = start + sweep;
    if (!Number.isFinite(end)) return full();
    let x0 = Math.min(Math.cos(start), Math.cos(end)), x1 = Math.max(Math.cos(start), Math.cos(end));
    let y0 = Math.min(Math.sin(start), Math.sin(end)), y1 = Math.max(Math.sin(start), Math.sin(end));
    const low = Math.min(start, end), high = Math.max(start, end), quarter = Math.PI / 2;
    // Include a neighbouring quadrant when angle rounding makes membership uncertain.
    const first = Math.ceil(nextDown(low / quarter)), last = Math.floor(nextUp(high / quarter));
    for (let k = first; k <= last; k++) {
        const axis = ((k % 4) + 4) % 4;
        if (axis === 0) x1 = 1; else if (axis === 1) y1 = 1; else if (axis === 2) x0 = -1; else y0 = -1;
    }
    const x = add(interval(centre.x), multiply(interval(radius), { lo: nextDown(x0), hi: nextUp(x1) }));
    const y = add(interval(centre.y), multiply(interval(radius), { lo: nextDown(y0), hi: nextUp(y1) }));
    return [x.lo, y.lo, x.hi, y.hi];
}
export function inverseAffine(out: Float64Array, oi: number, source: ArrayLike<number>, si = 0): boolean {
    const a = source[si], b = source[si + 1], c = source[si + 2], d = source[si + 3], e = source[si + 4], f = source[si + 5];
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || determinant === 0) return false;
    out[oi] = d / determinant; out[oi + 1] = -b / determinant; out[oi + 2] = -c / determinant; out[oi + 3] = a / determinant;
    out[oi + 4] = (c * f - d * e) / determinant; out[oi + 5] = (b * e - a * f) / determinant;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(out[oi + i])) return false;
    return true;
}

