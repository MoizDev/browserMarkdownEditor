import { dyadic, dyadicMultiply, dyadicSubtract } from './numeric';
import type { Dyadic, Interval } from './numeric';
import { dyadicRatioInterval } from './dyadicRatio';
import type { Vec2 } from './path';

export interface ExactPoint { readonly x: Dyadic; readonly y: Dyadic; readonly w: Dyadic }
export interface ExactLine { readonly a: Dyadic; readonly b: Dyadic; readonly c: Dyadic }

const MAX_BITS = 16384, MAX_EXPONENT = 32768;
function bits(n: bigint): number { return n === 0n ? 0 : (n < 0n ? -n : n).toString(2).length; }
function valid(v: Dyadic): void {
    if (typeof v.n !== 'bigint' || !Number.isSafeInteger(v.e) || Math.abs(v.e) > MAX_EXPONENT
        || (v.n < 0n ? -v.n : v.n) >> BigInt(MAX_BITS)) throw new RangeError('Exact geometry exceeds dyadic limits');
}
function sub(a: Dyadic, b: Dyadic): Dyadic {
    valid(a); valid(b);
    const e = Math.min(a.e, b.e);
    if ((a.n !== 0n && bits(a.n) + a.e - e > MAX_BITS) || (b.n !== 0n && bits(b.n) + b.e - e > MAX_BITS)) {
        throw new RangeError('Exact geometry shift exceeds dyadic limits');
    }
    const out = dyadicSubtract(a, b); valid(out); return out;
}
function mul(a: Dyadic, b: Dyadic): Dyadic {
    valid(a); valid(b);
    if (Math.abs(a.e + b.e) > MAX_EXPONENT || (a.n !== 0n && b.n !== 0n && bits(a.n) + bits(b.n) - 1 > MAX_BITS)) {
        throw new RangeError('Exact geometry product exceeds dyadic limits');
    }
    const out = dyadicMultiply(a, b); valid(out); return out;
}
function neg(a: Dyadic): Dyadic { return { n: -a.n, e: a.e }; }
function plus(a: Dyadic, b: Dyadic): Dyadic { return sub(a, neg(b)); }
function pointValid(p: ExactPoint): void {
    valid(p.x); valid(p.y); valid(p.w);
    if (p.w.n <= 0n) throw new RangeError('Exact point must have positive homogeneous weight');
}
function lineValid(l: ExactLine): void {
    valid(l.a); valid(l.b); valid(l.c);
    if (l.a.n === 0n && l.b.n === 0n) throw new RangeError('Invalid exact line');
}
export function exactPoint(p: Vec2): ExactPoint {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError('Exact point requires finite coordinates');
    return { x: dyadic(p.x), y: dyadic(p.y), w: { n: 1n, e: 0 } };
}
export function exactLineBetween(p: ExactPoint, q: ExactPoint): ExactLine {
    pointValid(p); pointValid(q);
    const line = { a: sub(mul(p.y, q.w), mul(p.w, q.y)), b: sub(mul(p.w, q.x), mul(p.x, q.w)),
        c: sub(mul(p.x, q.y), mul(p.y, q.x)) };
    lineValid(line); return line;
}
export function exactLineThrough(p: Vec2, q: Vec2): ExactLine { return exactLineBetween(exactPoint(p), exactPoint(q)); }
export function exactIntersection(p: ExactLine, q: ExactLine): ExactPoint | null {
    lineValid(p); lineValid(q);
    const x = sub(mul(p.b, q.c), mul(p.c, q.b)), y = sub(mul(p.c, q.a), mul(p.a, q.c)),
        w = sub(mul(p.a, q.b), mul(p.b, q.a));
    if (w.n === 0n) return null;
    return w.n > 0n ? { x, y, w } : { x: neg(x), y: neg(y), w: neg(w) };
}
export function exactSide(line: ExactLine, p: ExactPoint): -1 | 0 | 1 {
    lineValid(line); pointValid(p);
    const n = plus(plus(mul(line.a, p.x), mul(line.b, p.y)), mul(line.c, p.w)).n;
    return n < 0n ? -1 : n > 0n ? 1 : 0;
}
export function sameExactPoint(p: ExactPoint, q: ExactPoint): boolean {
    pointValid(p); pointValid(q);
    return sub(mul(p.x, q.w), mul(q.x, p.w)).n === 0n && sub(mul(p.y, q.w), mul(q.y, p.w)).n === 0n;
}
export function exactPointIntervals(p: ExactPoint): { readonly x: Interval; readonly y: Interval } {
    pointValid(p);
    return { x: dyadicRatioInterval(p.x, p.w), y: dyadicRatioInterval(p.y, p.w) };
}
