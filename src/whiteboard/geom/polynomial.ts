import type { Dyadic } from './numeric';

export type ExactPolynomial = bigint[]; // Ascending powers.
export interface DyadicRootCell { readonly index: bigint; readonly depth: number; readonly point: boolean }
const absolute = (value: bigint) => value < 0n ? -value : value;
function trim(value: ExactPolynomial): ExactPolynomial { while (value.length && value[value.length - 1] === 0n) value.pop(); return value; }

/** Bounded integer polynomial arithmetic; every Euclidean step is cooperative. */
export function createPolynomialArithmetic(maxBits: number) {
    if (!Number.isSafeInteger(maxBits) || maxBits < 64 || maxBits > 65536) throw new RangeError('Invalid polynomial bit limit');
    const valid = (value: bigint) => { if ((absolute(value) >> BigInt(maxBits)) !== 0n) throw new RangeError('Polynomial arithmetic bit limit'); };
    const integer = (values: readonly Dyadic[]): ExactPolynomial => {
        const nonzero = values.filter(value => value.n !== 0n);
        if (!nonzero.length) return [];
        const exponent = Math.min(...nonzero.map(value => value.e));
        return trim(values.map(value => {
            if (!Number.isSafeInteger(value.e) || value.e - exponent > maxBits) throw new RangeError('Polynomial exponent limit');
            const result = value.n << BigInt(value.e - exponent); valid(result); return result;
        }));
    };
    const gcdInt = function* (a: bigint, b: bigint): Generator<void, bigint> {
        a = absolute(a); b = absolute(b);
        while (b) { const next = a % b; a = b; b = next; yield; }
        return a;
    };
    const primitive = function* (input: ExactPolynomial, positive: boolean): Generator<void, ExactPolynomial> {
        const value = trim(input); if (!value.length) return value;
        let factor = 0n;
        for (const coefficient of value) { factor = yield* gcdInt(factor, coefficient); if (factor === 1n) break; yield; }
        if (factor > 1n) for (let i = 0; i < value.length; i++) { value[i] /= factor; yield; }
        if (positive && value[value.length - 1] < 0n) for (let i = 0; i < value.length; i++) { value[i] = -value[i]; yield; }
        return value;
    };
    // A positive pseudo-division multiplier preserves the rational remainder's
    // sign; the signed Sturm sequence must not normalize that sign away.
    const remainder = function* (left: ExactPolynomial, right: ExactPolynomial): Generator<void, ExactPolynomial> {
        if (!right.length) throw new Error('Polynomial division by zero');
        const divisor = right[right.length - 1] < 0n ? right.map(value => -value) : [...right];
        const leading = divisor[divisor.length - 1]; let result = [...left];
        while (result.length >= divisor.length && result.length) {
            const shift = result.length - divisor.length, coefficient = result[result.length - 1];
            for (let i = 0; i < result.length; i++) { result[i] *= leading; valid(result[i]); yield; }
            for (let i = 0; i < divisor.length; i++) { result[i + shift] -= coefficient * divisor[i]; valid(result[i + shift]); yield; }
            result = yield* primitive(trim(result), false); yield;
        }
        return result;
    };
    const gcd = function* (left: ExactPolynomial, right: ExactPolynomial): Generator<void, ExactPolynomial> {
        let a = yield* primitive([...left], true), b = yield* primitive([...right], true);
        while (b.length) { const next = yield* remainder(a, b); a = b; b = yield* primitive(next, true); yield; }
        return yield* primitive(a, true);
    };
    const atOne = (polynomial: readonly bigint[]): bigint => {
        let value = 0n; for (const coefficient of polynomial) { value += coefficient; valid(value); } return value;
    };
    const sign = (value: bigint): number => value < 0n ? -1 : value > 0n ? 1 : 0;
    const variations = (sequence: readonly ExactPolynomial[], endpoint: 0 | 1): number => {
        let previous = 0, result = 0;
        for (const polynomial of sequence) {
            const current = sign(endpoint ? atOne(polynomial) : polynomial[0] ?? 0n);
            if (current && previous && current !== previous) result++;
            if (current) previous = current;
        }
        return result;
    };
    const hasRoot01 = function* (input: ExactPolynomial): Generator<void, boolean> {
        const polynomial = yield* primitive([...input], true);
        if (!polynomial.length) return true;
        if (polynomial.length === 1) return false;
        if (polynomial[0] === 0n || atOne(polynomial) === 0n) return true;
        const derivative: ExactPolynomial = [];
        for (let i = 1; i < polynomial.length; i++) { derivative.push(polynomial[i] * BigInt(i)); valid(derivative[i - 1]); yield; }
        const sequence: ExactPolynomial[] = [polynomial, yield* primitive(derivative, false)];
        while (sequence[sequence.length - 1].length) {
            const raw = yield* remainder(sequence[sequence.length - 2], sequence[sequence.length - 1]);
            if (!raw.length) break;
            for (let i = 0; i < raw.length; i++) { raw[i] = -raw[i]; yield; }
            sequence.push(yield* primitive(raw, false)); yield;
        }
        return variations(sequence, 0) > variations(sequence, 1);
    };
    const sturm = function* (input: ExactPolynomial): Generator<void, ExactPolynomial[]> {
        const polynomial = yield* primitive([...input], true);
        if (!polynomial.length) throw new RangeError('Zero polynomial has no isolated root set');
        if (polynomial.length === 1) return [polynomial];
        const derivative: ExactPolynomial = [];
        for (let i = 1; i < polynomial.length; i++) { derivative.push(polynomial[i] * BigInt(i)); valid(derivative[i - 1]); yield; }
        const sequence: ExactPolynomial[] = [polynomial, yield* primitive(derivative, false)];
        while (sequence[sequence.length - 1].length) {
            const raw = yield* remainder(sequence[sequence.length - 2], sequence[sequence.length - 1]);
            if (!raw.length) break;
            for (let i = 0; i < raw.length; i++) { raw[i] = -raw[i]; yield; }
            sequence.push(yield* primitive(raw, false)); yield;
        }
        return sequence;
    };
    const evaluate = function* (polynomial: readonly bigint[], numerator: bigint, depth: number): Generator<void, bigint> {
        const denominator = 1n << BigInt(depth); valid(denominator); valid(numerator);
        let value = polynomial[polynomial.length - 1] ?? 0n, power = 1n;
        for (let i = polynomial.length - 2; i >= 0; i--) {
            power *= denominator; valid(power); value = value * numerator + polynomial[i] * power; valid(value); yield;
        }
        return value;
    };
    const endpointVariation = function* (sequence: readonly ExactPolynomial[], numerator: bigint, depth: number,
        side: -1 | 1): Generator<void, number> {
        let previous = 0, changes = 0;
        for (const source of sequence) {
            let polynomial = source, order = 0, value = yield* evaluate(polynomial, numerator, depth);
            while (!value && polynomial.length > 1) {
                const derivative: ExactPolynomial = [];
                for (let i = 1; i < polynomial.length; i++) { derivative.push(polynomial[i] * BigInt(i)); valid(derivative[i - 1]); yield; }
                polynomial = derivative; order++; value = yield* evaluate(polynomial, numerator, depth);
            }
            let current = sign(value);
            if (side < 0 && order % 2) current = -current;
            if (current && previous && current !== previous) changes++;
            if (current) previous = current;
            yield;
        }
        return changes;
    };
    /** Isolate distinct roots, including even-multiplicity and dyadic endpoint roots. */
    const roots01 = function* (input: ExactPolynomial, options: { readonly minDepth: number; readonly maxDepth: number; readonly maxNodes: number }):
        Generator<void, readonly DyadicRootCell[]> {
        const { minDepth, maxDepth, maxNodes } = options;
        if (!Number.isSafeInteger(minDepth) || !Number.isSafeInteger(maxDepth) || minDepth < 0 || maxDepth < minDepth || maxDepth > 128
            || !Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new RangeError('Invalid polynomial root limits');
        const sequence = yield* sturm(input), polynomial = sequence[0], result: DyadicRootCell[] = [];
        if (!(yield* evaluate(polynomial, 0n, 0))) result.push({ index: 0n, depth: 0, point: true });
        if (!(yield* evaluate(polynomial, 1n, 0))) result.push({ index: 1n, depth: 0, point: true });
        const stack: { index: bigint; depth: number }[] = [{ index: 0n, depth: 0 }]; let nodes = 1;
        while (stack.length) {
            const cell = stack.pop()!, left = yield* endpointVariation(sequence, cell.index, cell.depth, 1);
            const right = yield* endpointVariation(sequence, cell.index + 1n, cell.depth, -1), count = left - right;
            if (count < 0) throw new RangeError('Invalid polynomial root count');
            if (!count) { yield; continue; }
            if (count === 1 && cell.depth >= minDepth) { result.push({ ...cell, point: false }); yield; continue; }
            if (cell.depth >= maxDepth || nodes + 2 > maxNodes) throw new RangeError('Polynomial roots cannot be isolated');
            const index = cell.index * 2n, depth = cell.depth + 1, middle = index + 1n;
            if (!(yield* evaluate(polynomial, middle, depth))) result.push({ index: middle, depth, point: true });
            stack.push({ index: index + 1n, depth }, { index, depth }); nodes += 2; yield;
        }
        return result;
    };
    return { integer, atOne, gcd, hasRoot01, roots01 };
}
