// Geometry §2: intervals are outward rounded; topology never uses a visual epsilon.
export interface Interval { readonly lo: number; readonly hi: number }
const buffer = new ArrayBuffer(8);
const bits = new DataView(buffer);

export function finite(value: number): number {
    if (!Number.isFinite(value)) throw new RangeError('Geometry requires finite numbers');
    return value;
}
export function nextUp(value: number): number {
    if (Number.isNaN(value) || value === Infinity) return value;
    if (value === 0) return Number.MIN_VALUE;
    bits.setFloat64(0, value);
    let n = bits.getBigUint64(0);
    n = value > 0 ? n + 1n : n - 1n;
    bits.setBigUint64(0, n);
    return bits.getFloat64(0);
}
export function nextDown(value: number): number { return -nextUp(-value); }
export function interval(value: number): Interval { return { lo: value, hi: value }; }
export function subtract(a: Interval, b: Interval): Interval {
    const lo = a.lo - b.hi, hi = a.hi - b.lo;
    return Number.isNaN(lo) || Number.isNaN(hi) ? { lo: -Infinity, hi: Infinity } : { lo: nextDown(lo), hi: nextUp(hi) };
}
export function multiply(a: Interval, b: Interval): Interval {
    const values = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
    if (values.some(Number.isNaN)) return { lo: -Infinity, hi: Infinity };
    return { lo: nextDown(Math.min(...values)), hi: nextUp(Math.max(...values)) };
}

export interface Dyadic { readonly n: bigint; readonly e: number }
export function dyadic(value: number): Dyadic {
    finite(value);
    bits.setFloat64(0, value);
    const raw = bits.getBigUint64(0), exponent = Number((raw >> 52n) & 0x7ffn);
    const fraction = raw & ((1n << 52n) - 1n);
    const magnitude = exponent === 0 ? fraction : fraction | (1n << 52n);
    return { n: raw >> 63n ? -magnitude : magnitude, e: exponent === 0 ? -1074 : exponent - 1075 };
}
export function dyadicSubtract(a: Dyadic, b: Dyadic): Dyadic {
    const e = Math.min(a.e, b.e);
    return { n: (a.n << BigInt(a.e - e)) - (b.n << BigInt(b.e - e)), e };
}
export function dyadicMultiply(a: Dyadic, b: Dyadic): Dyadic { return { n: a.n * b.n, e: a.e + b.e }; }
