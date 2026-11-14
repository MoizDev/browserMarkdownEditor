import type { Affine } from '../../platform/types';
import { add, interval, multiply, sqrtInterval, subtract, type Interval } from './numeric';
import type { BoundsPoint, CertifiedCurve } from './pointPathJob';
import type { Vec2 } from './path';

function magnitude(x: Interval, y: Interval): number {
    const xx = multiply(x, x), yy = multiply(y, y), sum = add(xx, yy);
    if (!Number.isFinite(sum.hi) || sum.hi < 0) return Infinity;
    return sqrtInterval({ lo: Math.max(0, sum.lo), hi: sum.hi }).hi;
}
function product(a: Interval, b: number): Interval { return multiply(a, interval(b)); }
function dot(point: BoundsPoint, x: number, y: number): Interval { return add(product(point.x, x), product(point.y, y)); }

/** Certified upper support of an affine-transformed local disk in any finite,
 * not necessarily normalized, CSS direction. */
export function strokeSupportUpper(matrix: Affine, localRadius: number, x: number, y: number): number {
    if (![...matrix, localRadius, x, y].every(Number.isFinite) || localRadius < 0) throw new RangeError('Invalid stroke support request');
    if (!localRadius || (!x && !y)) return 0;
    const ux = add(product(interval(matrix[0]), x), product(interval(matrix[1]), y));
    const uy = add(product(interval(matrix[2]), x), product(interval(matrix[3]), y));
    const norm = magnitude(ux, uy); if (!Number.isFinite(norm)) return Infinity;
    const support = multiply(interval(localRadius), interval(norm));
    return Number.isFinite(support.hi) ? Math.max(0, support.hi) : Infinity;
}
function radiusSupport(margin: number, x: number, y: number): number {
    if (!margin || (!x && !y)) return 0;
    const norm = magnitude(interval(x), interval(y)); if (!Number.isFinite(norm)) return Infinity;
    const result = multiply(interval(margin), interval(norm));
    return Number.isFinite(result.hi) ? Math.max(0, result.hi) : Infinity;
}
function upper(points: CertifiedCurve['points'], x: number, y: number): number {
    let value = -Infinity; for (const point of points) value = Math.max(value, dot(point, x, y).hi); return value;
}
function lower(points: readonly BoundsPoint[], x: number, y: number): number {
    let value = Infinity; for (const point of points) value = Math.min(value, dot(point, x, y).lo); return value;
}
function directions(path: CertifiedCurve['points'], target: readonly BoundsPoint[]): readonly Vec2[] {
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity;
    for (const p of path) { px0 = Math.min(px0, p.x.lo); py0 = Math.min(py0, p.y.lo); px1 = Math.max(px1, p.x.hi); py1 = Math.max(py1, p.y.hi); }
    for (const p of target) { qx0 = Math.min(qx0, p.x.lo); qy0 = Math.min(qy0, p.y.lo); qx1 = Math.max(qx1, p.x.hi); qy1 = Math.max(qy1, p.y.hi); }
    const x = (qx0 / 2 + qx1 / 2) - (px0 / 2 + px1 / 2), y = (qy0 / 2 + qy1 / 2) - (py0 / 2 + py1 / 2);
    const result: Vec2[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    if (Number.isFinite(x) && Number.isFinite(y) && (x || y)) result.push({ x, y });
    return result;
}

/** A positive separating support gap proves the complete curve stroke misses
 * the target hull plus its CSS margin; failure to separate is not a hit. */
export function strokeSeparatedFromHull(path: CertifiedCurve['points'], target: readonly BoundsPoint[], matrix: Affine,
    localRadius: number, margin: number): boolean {
    if (!target.length || !Number.isFinite(margin) || margin < 0) throw new RangeError('Invalid stroke separation query');
    for (const direction of directions(path, target)) {
        try {
            const a = upper(path, direction.x, direction.y), b = lower(target, direction.x, direction.y);
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            const gap = subtract(interval(b), interval(a)).lo;
            const stroke = strokeSupportUpper(matrix, localRadius, direction.x, direction.y), halo = radiusSupport(margin, direction.x, direction.y);
            if (!Number.isFinite(stroke) || !Number.isFinite(halo)) continue;
            const support = add(interval(stroke), interval(halo)).hi;
            if (Number.isFinite(gap) && Number.isFinite(support) && gap > support) return true;
        } catch (error) { if (!(error instanceof RangeError)) throw error; }
    }
    return false;
}
export function strokeSeparatedFromPoint(path: CertifiedCurve['points'], point: Vec2, matrix: Affine,
    localRadius: number, margin: number): boolean {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid stroke separation point');
    return strokeSeparatedFromHull(path, [{ x: interval(point.x), y: interval(point.y) }], matrix, localRadius, margin);
}
