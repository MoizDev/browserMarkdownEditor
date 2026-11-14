import { dyadicRatioInterval } from './dyadicRatio';
import { dyadic, dyadicSubtract, type Dyadic } from './numeric';

export interface ExactSnapDelta { readonly value: Dyadic; readonly rounded: number; readonly representable: boolean }
const ONE: Dyadic = Object.freeze({ n: 1n, e: 0 });
function negate(value: Dyadic): Dyadic { return { n: -value.n, e: value.e }; }
function plus(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, negate(b)); }
function magnitude(value: Dyadic): Dyadic { return value.n < 0n ? negate(value) : value; }
function compare(a: Dyadic, b: Dyadic): number { const n = dyadicSubtract(a, b).n; return n < 0n ? -1 : n > 0n ? 1 : 0; }
export function snapDeltaFromDyadic(value: Dyadic): ExactSnapDelta {
    const interval = dyadicRatioInterval(value, ONE);
    const finite = Number.isFinite(interval.lo) && Number.isFinite(interval.hi);
    return Object.freeze({ value, rounded: finite ? (interval.lo === interval.hi ? interval.lo : interval.lo / 2 + interval.hi / 2) : 0,
        representable: finite && interval.lo === interval.hi });
}
/** Coordinate operands are the actual binary64 positions used by the board. */
export function exactSnapDisplacement(target: number, source: number): ExactSnapDelta {
    return snapDeltaFromDyadic(dyadicSubtract(dyadic(target), dyadic(source)));
}
/** Equal gaps are computed before rounding, including the half-gap division. */
export function exactGapDisplacement(beforeEnd: number, afterStart: number, size: number, start: number): ExactSnapDelta | null {
    const spare = dyadicSubtract(dyadicSubtract(dyadic(afterStart), dyadic(beforeEnd)), dyadic(size));
    if (spare.n < 0n) return null;
    const half: Dyadic = { n: spare.n, e: spare.e - 1 };
    return snapDeltaFromDyadic(dyadicSubtract(plus(dyadic(beforeEnd), half), dyadic(start)));
}
export function snapWithin(delta: ExactSnapDelta, threshold: number): boolean {
    return compare(magnitude(delta.value), dyadic(threshold)) <= 0;
}
export function compareSnapMagnitude(a: ExactSnapDelta, b: ExactSnapDelta): number {
    return compare(magnitude(a.value), magnitude(b.value));
}
