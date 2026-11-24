import { add, divide, interval, multiply, subtract, type Interval } from './numeric';

function negative(value: Interval): Interval { return { lo: -value.hi, hi: -value.lo }; }
function times(value: Interval, factor: number): Interval { return multiply(value, interval(factor)); }
function absoluteUpper(value: Interval): number { return Math.max(Math.abs(value.lo), Math.abs(value.hi)); }
function finite(value: Interval): boolean { return Number.isFinite(value.lo) && Number.isFinite(value.hi) && value.lo <= value.hi; }
function hull(a: Interval, b: Interval): Interval { return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) }; }

// Alternating series on [0, 1/2], with an explicit next-term remainder.
function atanSmall(value: Interval): Interval {
    if (!finite(value) || value.lo < 0 || value.hi > 0.500000000000001) throw new RangeError('Atan argument outside certified range');
    const square = multiply(value, value); let power = value, result = interval(0);
    for (let k = 0; k < 80; k++) {
        const term = divide(power, interval(2 * k + 1));
        result = k % 2 ? subtract(result, term) : add(result, term);
        power = multiply(power, square);
    }
    const remainder = divide(power, interval(161)).hi;
    return add(result, { lo: -remainder, hi: remainder });
}
let cachedPi: Interval | undefined;
/** A closed enclosure of mathematical π computed from Machin's identity. */
export function certifiedPi(): Interval {
    if (!cachedPi) {
        const a = atanSmall(divide(interval(1), interval(5))), b = atanSmall(divide(interval(1), interval(239)));
        cachedPi = Object.freeze(subtract(times(a, 16), times(b, 4)));
    }
    return cachedPi;
}
function atanUnit(value: Interval): Interval {
    if (!finite(value) || value.lo < 0 || value.hi > 1.000000000000001) throw new RangeError('Atan unit argument is invalid');
    if (value.hi <= 0.5) return atanSmall(value);
    if (value.lo >= 0.5) {
        const reduced = divide(subtract(interval(1), value), add(interval(1), value));
        const positive = { lo: Math.max(0, reduced.lo), hi: Math.max(0, reduced.hi) };
        return subtract(times(certifiedPi(), 0.25), atanSmall(positive));
    }
    return hull(atanUnit({ lo: value.lo, hi: 0.5 }), atanUnit({ lo: 0.5, hi: value.hi }));
}
function atanPositive(value: number): Interval {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid atan argument');
    if (value <= 1) return atanUnit(interval(value));
    const reciprocal = divide(interval(1), interval(value));
    return subtract(times(certifiedPi(), 0.5), atanUnit(reciprocal));
}

/** An atan2 enclosure in [0, 2π]. The box must fit one open quadrant, or be
 * an exact axis point; callers subdivide boxes that straddle an axis. */
export function certifiedAngleBox(x: Interval, y: Interval): Interval | null {
    if (!finite(x) || !finite(y)) return null;
    const pi = certifiedPi(), half = times(pi, 0.5), twice = times(pi, 2);
    if (x.lo === 0 && x.hi === 0) {
        if (y.lo > 0) return half;
        if (y.hi < 0) return times(pi, 1.5);
        return null;
    }
    if (y.lo === 0 && y.hi === 0) {
        if (x.lo > 0) return interval(0);
        if (x.hi < 0) return pi;
        return null;
    }
    const sx = x.lo > 0 ? 1 : x.hi < 0 ? -1 : 0, sy = y.lo > 0 ? 1 : y.hi < 0 ? -1 : 0;
    if (!sx || !sy) return null;
    const ax = sx > 0 ? x : negative(x), ay = sy > 0 ? y : negative(y), ratio = divide(ay, ax);
    if (!finite(ratio) || ratio.lo < 0) return null;
    const low = atanPositive(ratio.lo), high = atanPositive(ratio.hi), angle = { lo: low.lo, hi: high.hi };
    if (sx > 0 && sy > 0) return angle;
    if (sx < 0 && sy > 0) return subtract(pi, angle);
    if (sx < 0 && sy < 0) return add(pi, angle);
    return subtract(twice, angle);
}

/** Certified sin/cos for an angle interval with a stable quadrant reduction. */
export function certifiedSinCos(angle: Interval): { readonly sin: Interval; readonly cos: Interval } | null {
    if (!finite(angle)) return null;
    const pi = certifiedPi(), half = times(pi, 0.5), midpoint = angle.lo / 2 + angle.hi / 2;
    const quadrant = Math.round(midpoint / ((pi.lo / 2 + pi.hi / 2) / 2));
    if (!Number.isSafeInteger(quadrant)) return null;
    const x = subtract(angle, times(half, quadrant));
    if (!finite(x) || absoluteUpper(x) > 0.9) return null;
    const square = multiply(x, x);
    let sin = x, cos = interval(1), sinTerm = x, cosTerm = interval(1);
    for (let k = 1; k <= 24; k++) {
        sinTerm = negative(divide(multiply(sinTerm, square), interval((2 * k) * (2 * k + 1))));
        cosTerm = negative(divide(multiply(cosTerm, square), interval((2 * k - 1) * (2 * k))));
        sin = add(sin, sinTerm); cos = add(cos, cosTerm);
    }
    const sinRemainder = absoluteUpper(divide(multiply(sinTerm, square), interval(50 * 51)));
    const cosRemainder = absoluteUpper(divide(multiply(cosTerm, square), interval(49 * 50)));
    sin = add(sin, { lo: -sinRemainder, hi: sinRemainder }); cos = add(cos, { lo: -cosRemainder, hi: cosRemainder });
    switch ((quadrant % 4 + 4) % 4) {
        case 0: return { sin, cos };
        case 1: return { sin: cos, cos: negative(sin) };
        case 2: return { sin: negative(sin), cos: negative(cos) };
        default: return { sin: negative(cos), cos: sin };
    }
}
