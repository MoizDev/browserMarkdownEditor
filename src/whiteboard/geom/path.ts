import { add, interval, multiply, nextDown, nextUp, subtract } from './numeric';
import type { Interval } from './numeric';

export interface Vec2 { readonly x: number; readonly y: number }
export type PathOp =
    | Readonly<{ op: 'M' | 'L'; p: Vec2 }>
    | Readonly<{ op: 'C'; c1: Vec2; c2: Vec2; p: Vec2 }>
    | Readonly<{ op: 'Z' }>;
export interface Cubic { readonly p0: Vec2; readonly p1: Vec2; readonly p2: Vec2; readonly p3: Vec2 }
export interface Arc { readonly centre: Vec2; readonly radius: number; readonly start: number; readonly sweep: number }

// Bernstein coefficients bound the degree-six squared-radius error throughout a cubic.
function radialBound(points: readonly Vec2[]): number {
    const choose3 = [1, 3, 3, 1], choose6 = [1, 6, 15, 20, 15, 6, 1];
    const uncertain = (x: number): Interval => ({ lo: nextDown(nextDown(x)), hi: nextUp(nextUp(x)) });
    let worst = 0;
    for (let k = 0; k <= 6; k++) {
        let value = interval(0);
        for (let i = Math.max(0, k - 3); i <= Math.min(3, k); i++) {
            const j = k - i;
            const dot = add(multiply(uncertain(points[i].x), uncertain(points[j].x)), multiply(uncertain(points[i].y), uncertain(points[j].y)));
            value = add(value, multiply(uncertain(choose3[i] * choose3[j] / choose6[k]), dot));
        }
        const delta = subtract(value, interval(1));
        worst = Math.max(worst, Math.abs(delta.lo), Math.abs(delta.hi));
    }
    return worst;
}
export function arcToCubics(arc: Arc, error: number, maxPieces = 262144): readonly PathOp[] {
    const { centre, radius, start, sweep } = arc;
    if (![centre.x, centre.y, radius, start, sweep, error].every(Number.isFinite) || radius < 0 || error <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid arc conversion budget');
    const roundoff = 64 * Number.EPSILON * (Math.max(1, Math.abs(centre.x), Math.abs(centre.y), radius) + radius * (Math.abs(start) + Math.abs(sweep)));
    if (roundoff >= error / 2) throw new RangeError('Arc conversion cannot certify this coordinate scale');
    let count = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    if (count > maxPieces) throw new RangeError('Arc conversion exceeds its piece ceiling');
    for (;;) {
        const half = sweep / count / 2, c = Math.cos(half), s = Math.sin(half), handle = 4 / 3 * Math.tan(half / 2);
        const normalized: readonly Vec2[] = [{ x: c, y: -s }, { x: c + handle * s, y: -s + handle * c }, { x: c + handle * s, y: s - handle * c }, { x: c, y: s }];
        if (radius * radialBound(normalized) <= error / 2) break;
        if (count > maxPieces / 2) throw new RangeError('Arc conversion cannot certify the requested error within its piece ceiling');
        count *= 2;
    }
    const result: PathOp[] = [];
    const point = (angle: number): Vec2 => ({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
    result.push({ op: 'M', p: point(start) });
    for (let i = 0; i < count; i++) {
        const a = start + sweep * i / count, b = start + sweep * (i + 1) / count;
        const p = point(a), q = point(b), h = 4 / 3 * radius * Math.tan((b - a) / 4);
        const c1 = { x: p.x - h * Math.sin(a), y: p.y + h * Math.cos(a) };
        const c2 = { x: q.x + h * Math.sin(b), y: q.y - h * Math.cos(b) };
        if (![p.x, p.y, q.x, q.y, c1.x, c1.y, c2.x, c2.y].every(Number.isFinite)) throw new RangeError('Arc coordinates overflow');
        result.push({ op: 'C', c1, c2, p: q });
    }
    return result;
}
