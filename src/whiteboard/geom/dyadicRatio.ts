import { nextUp } from './numeric';
import type { Dyadic, Interval } from './numeric';

// Homogeneous clip coordinates arise from a bounded number of binary64
// products. Reject malformed callers before any attacker-sized BigInt shift.
const MAX_BITS = 16384;
const MAX_EXPONENT = 32768;
function validate(value: Dyadic): void {
    if (typeof value.n !== 'bigint' || !Number.isSafeInteger(value.e) || Math.abs(value.e) > MAX_EXPONENT) {
        throw new RangeError('Invalid dyadic value');
    }
    const magnitude = value.n < 0n ? -value.n : value.n;
    if (magnitude >> BigInt(MAX_BITS)) throw new RangeError('Dyadic integer exceeds geometry limit');
}
function bitLength(value: bigint): number { return value.toString(2).length; }

/** Smallest binary64 interval enclosing the exact quotient of two dyadics. */
export function dyadicRatioInterval(a: Dyadic, b: Dyadic): Interval {
    validate(a); validate(b);
    if (b.n === 0n) throw new RangeError('Dyadic division by zero');
    if (a.n === 0n) return { lo: 0, hi: 0 };
    const negative = (a.n < 0n) !== (b.n < 0n);
    const n = a.n < 0n ? -a.n : a.n, d = b.n < 0n ? -b.n : b.n;
    const exponent = a.e - b.e;
    let log = bitLength(n) - bitLength(d);
    // The bit-length difference is either floor(log2(n/d)) or one above it.
    if (log >= 0 ? n < (d << BigInt(log)) : (n << BigInt(-log)) < d) log--;
    const k = log + exponent;
    let low: number, high: number;
    if (k > 1023) { low = Number.MAX_VALUE; high = Infinity; }
    else if (k < -1074) { low = 0; high = Number.MIN_VALUE; }
    else {
        const q = Math.max(k - 52, -1074), shift = exponent - q;
        const numerator = shift >= 0 ? n << BigInt(shift) : n;
        const denominator = shift < 0 ? d << BigInt(-shift) : d;
        const mantissa = numerator / denominator, remainder = numerator % denominator;
        // Integer division gives the adjacent lower grid point. The mantissa
        // has at most 53 bits, and multiplying by 2^q is exact even for a
        // subnormal: q is never below -1074. A remainder means the next
        // binary64 value is the least representable upper bound.
        low = Number(mantissa) * 2 ** q;
        high = remainder === 0n ? low : nextUp(low);
    }
    return negative ? { lo: -high, hi: -low } : { lo: low, hi: high };
}
