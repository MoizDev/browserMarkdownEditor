// document-model.md §4, M-4; R-W7/R-W12 settle signed integers and bottom insertion.
export type OrderKey = string;
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = 62n;
const MIN_KEY = 'A' + '0'.repeat(26);
const MAX_KEY = 'z' + 'z'.repeat(26);
export const REKEY_LENGTH = 64;

function integerLength(head: string): number {
    const code = head.charCodeAt(0);
    if (code >= 97 && code <= 122) return code - 96;
    if (code >= 65 && code <= 90) return 91 - code;
    return 0;
}

export function isValidKey(key: string): boolean {
    if (key.length < 2 || key.length > 256 || key <= MIN_KEY || key >= MAX_KEY) return false;
    const count = integerLength(key[0]);
    if (!count || key.length < count + 1) return false;
    for (let i = 1; i < key.length; i++) {
        if (!DIGITS.includes(key[i])) return false;
    }
    return key.length === count + 1 || !key.endsWith('0');
}

function checkBounds(a: OrderKey | null, b: OrderKey | null): void {
    if (a !== null && !isValidKey(a)) throw new RangeError('Invalid lower order key');
    if (b !== null && !isValidKey(b)) throw new RangeError('Invalid upper order key');
    if (a !== null && b !== null && a >= b) throw new RangeError('Order keys must be strictly increasing');
}

function integerPart(key: OrderKey): string {
    return key.slice(0, integerLength(key[0]) + 1);
}

function integerValue(integer: string): bigint {
    let value = 0n;
    for (let i = 1; i < integer.length; i++) value = value * BASE + BigInt(DIGITS.indexOf(integer[i]));
    return integer[0] <= 'Z' ? value - BASE ** BigInt(integer.length - 1) : value;
}

function encodeInteger(value: bigint): string | null {
    let count = 1;
    let limit = BASE;
    if (value < 0n) {
        while (-value > limit && count < 26) { count++; limit *= BASE; }
        if (-value > limit) return null;
    } else {
        while (value >= limit && count < 26) { count++; limit *= BASE; }
        if (value >= limit) return null;
    }
    let rest = value < 0n ? limit + value : value;
    let digits = '';
    for (let i = 0; i < count; i++) {
        digits = DIGITS[Number(rest % BASE)] + digits;
        rest /= BASE;
    }
    return String.fromCharCode(value < 0n ? 91 - count : 96 + count) + digits;
}

// Fractions have an implicit zero suffix below and an exclusive 1.0 above.
function fractionBetween(a: string, b: string | null): string {
    let prefix = '';
    for (let i = 0; ; i++) {
        const low = i < a.length ? DIGITS.indexOf(a[i]) : 0;
        const high = b === null ? 62 : i < b.length ? DIGITS.indexOf(b[i]) : 0;
        if (high - low >= 2) return prefix + DIGITS[Math.floor((low + high) / 2)];
        prefix += DIGITS[low];
        if (low < high) b = null;
    }
}

function inside(key: string | null, a: string | null, b: string | null): key is string {
    return key !== null && key > MIN_KEY && key < MAX_KEY
        && (a === null || a < key) && (b === null || key < b);
}

function between(a: OrderKey | null, b: OrderKey | null): OrderKey {
    if (a === null && b === null) return 'a0';
    if (a === null) {
        const upper = integerPart(b!);
        const count = upper.length - 1;
        let value = integerValue(upper) - 1n;
        if (upper[0] <= 'Z') {
            const lastOfHead = count === 1 ? -1n : -(BASE ** BigInt(count - 1) + 1n);
            if (value > lastOfHead) value = lastOfHead;
        }
        const previous = encodeInteger(value);
        if (inside(previous, a, b)) return previous;
        // At the lower limit, use the reserved integer as a prefix, never as a key.
        // An integer bound one above it needs MIN+'V', not upper+'V' (which is above b).
        return MIN_KEY + fractionBetween('', upper === MIN_KEY ? b!.slice(upper.length) : null);
    }
    const lower = integerPart(a);
    if (b === null) {
        let value = integerValue(lower) + 1n;
        if (lower[0] >= 'a') {
            const firstOfHead = lower.length === 2 ? 0n : BASE ** BigInt(lower.length - 2);
            if (value < firstOfHead) value = firstOfHead;
        }
        const next = encodeInteger(value);
        if (inside(next, a, b)) return next;
        return lower + fractionBetween(a.slice(lower.length), null);
    }
    const upper = integerPart(b);
    if (lower === upper) return lower + fractionBetween(a.slice(lower.length), b.slice(upper.length));
    const low = integerValue(lower);
    const high = integerValue(upper);
    if (high - low >= 2n) {
        const middle = encodeInteger(low + (high - low) / 2n);
        // Imported non-canonical heads can disagree numerically with lexical order.
        // They stay verbatim; only a candidate that is lexically inside may be used.
        if (inside(middle, a, b)) return middle;
    }
    return lower + fractionBetween(a.slice(lower.length), null);
}

export function keyBetween(a: OrderKey | null, b: OrderKey | null): OrderKey {
    checkBounds(a, b);
    return between(a, b);
}

export function keysBetween(a: OrderKey | null, b: OrderKey | null, n: number): OrderKey[] {
    checkBounds(a, b);
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Order key count must be a non-negative safe integer');
    const keys = new Array<OrderKey>(n);
    if (b === null) {
        let previous = a;
        for (let i = 0; i < n; i++) keys[i] = previous = between(previous, null);
        return keys;
    }
    function fill(lower: OrderKey | null, upper: OrderKey, start: number, count: number): void {
        if (count === 0) return;
        const leftCount = Math.floor((count - 1) / 2);
        const index = start + leftCount;
        const middle = between(lower, upper);
        keys[index] = middle;
        fill(lower, middle, start, leftCount);
        fill(middle, upper, index + 1, count - leftCount - 1);
    }
    fill(a, b, 0, n);
    return keys;
}

// Apply re-keys the parent's sorted siblings in the same transaction (and inverse).
export function needsRekey(key: OrderKey): boolean { return key.length > REKEY_LENGTH; }

export function compareOrder(a: { readonly order: OrderKey; readonly id: string }, b: { readonly order: OrderKey; readonly id: string }): number {
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}
