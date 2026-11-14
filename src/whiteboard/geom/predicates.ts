import { dyadic, dyadicMultiply, dyadicSubtract, finite, interval, multiply, subtract } from './numeric';
import type { Vec2 } from './path';
import type { Sign } from './types';

export type { Sign } from './types';
export interface PredicateStats { filtered: number; exact: number; exactMilliseconds: number }
export const predicateStats: PredicateStats = { filtered: 0, exact: 0, exactMilliseconds: 0 };
function sign(n: number | bigint): Sign { return n < 0 ? -1 : n > 0 ? 1 : 0; }
export function orient2d(a: Vec2, b: Vec2, c: Vec2): Sign {
    for (const v of [a.x, a.y, b.x, b.y, c.x, c.y]) finite(v);
    const ax = subtract(interval(a.x), interval(c.x)), ay = subtract(interval(a.y), interval(c.y));
    const bx = subtract(interval(b.x), interval(c.x)), by = subtract(interval(b.y), interval(c.y));
    const d = subtract(multiply(ax, by), multiply(ay, bx));
    if (d.lo > 0 || d.hi < 0) { predicateStats.filtered++; return d.lo > 0 ? 1 : -1; }
    const start = performance.now();
    const dx = (x: number, y: number) => dyadicSubtract(dyadic(x), dyadic(y));
    const exact = dyadicSubtract(dyadicMultiply(dx(a.x, c.x), dx(b.y, c.y)), dyadicMultiply(dx(a.y, c.y), dx(b.x, c.x)));
    predicateStats.exact++; predicateStats.exactMilliseconds += performance.now() - start;
    return sign(exact.n);
}
function between(a: number, b: number, v: number): boolean { return v >= Math.min(a, b) && v <= Math.max(a, b); }
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
    return between(a.x, b.x, p.x) && between(a.y, b.y, p.y);
}
export type SegmentIntersection =
    | { readonly kind: 'none' }
    | { readonly kind: 'point'; readonly point?: Vec2 }
    | { readonly kind: 'overlap'; readonly from: Vec2; readonly to: Vec2 };
export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): SegmentIntersection {
    const abC = orient2d(a, b, c), abD = orient2d(a, b, d), cdA = orient2d(c, d, a), cdB = orient2d(c, d, b);
    if (abC === 0 && abD === 0 && cdA === 0 && cdB === 0) {
        const points = [a, b, c, d].filter(p => onSegment(a, b, p) && onSegment(c, d, p));
        if (!points.length) return { kind: 'none' };
        points.sort((p, q) => p.x - q.x || p.y - q.y);
        const from = points[0], to = points[points.length - 1];
        return from.x === to.x && from.y === to.y ? { kind: 'point', point: from } : { kind: 'overlap', from, to };
    }
    for (const [s, p, u, v] of [[abC, c, a, b], [abD, d, a, b], [cdA, a, c, d], [cdB, b, c, d]] as const) {
        if (s === 0 && onSegment(u, v, p)) return { kind: 'point', point: p };
    }
    return abC * abD < 0 && cdA * cdB < 0 ? { kind: 'point' } : { kind: 'none' };
}
export function winding(point: Vec2, polygon: readonly Vec2[]): number | 'boundary' {
    let result = 0;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length], o = orient2d(a, b, point);
        if (o === 0 && onSegment(a, b, point)) return 'boundary';
        if (a.y <= point.y && point.y < b.y && o > 0) result++;
        if (b.y <= point.y && point.y < a.y && o < 0) result--;
    }
    return result;
}
