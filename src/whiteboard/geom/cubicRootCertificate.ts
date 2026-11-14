import { dyadicSubtract, type Dyadic } from './numeric';

export interface ExactCurvePoint { readonly x: Dyadic; readonly y: Dyadic }
export type CubicRootResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface CubicRootLimits { readonly maxBits?: number; readonly maxWork?: number }
type Polynomial = bigint[]; // Ascending powers.
const PENDING: CubicRootResult = Object.freeze({ status: 'pending' });
const absolute = (value: bigint) => value < 0n ? -value : value;
function trim(value: Polynomial): Polynomial { while (value.length && value[value.length - 1] === 0n) value.pop(); return value; }
function sum(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function times(a: Dyadic, coefficient: bigint): Dyadic { return { n: a.n * coefficient, e: a.e }; }
function coefficients(p: readonly [Dyadic, Dyadic, Dyadic, Dyadic], q: Dyadic): readonly Dyadic[] {
    return [dyadicSubtract(p[0], q), times(dyadicSubtract(p[1], p[0]), 3n),
        times(sum(dyadicSubtract(p[0], times(p[1], 2n)), p[2]), 3n),
        sum(dyadicSubtract(times(p[1], 3n), p[0]), dyadicSubtract(p[3], times(p[2], 3n)))];
}

/** Exact common-root certificate for the two dyadic cubic coordinate polynomials.
 * Rational polynomial gcd and a Sturm sequence prove existence in [0,1]. */
export function createCubicRootCertificate(points: readonly [ExactCurvePoint, ExactCurvePoint, ExactCurvePoint, ExactCurvePoint],
    query: ExactCurvePoint, limits: CubicRootLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CubicRootResult; cancel(): void } {
    const maxBits = limits.maxBits ?? 16384, maxWork = limits.maxWork ?? 1000000;
    if (!Number.isSafeInteger(maxBits) || maxBits < 64 || maxBits > 65536 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid cubic root certificate budget');
    const valid = (value: bigint) => { if ((absolute(value) >> BigInt(maxBits)) !== 0n) throw new RangeError('Cubic root arithmetic bit limit'); };
    const integer = (values: readonly Dyadic[]): Polynomial => {
        const nonzero = values.filter(value => value.n !== 0n);
        if (!nonzero.length) return [];
        const exponent = Math.min(...nonzero.map(value => value.e));
        return trim(values.map(value => {
            if (!Number.isSafeInteger(value.e) || value.e - exponent > maxBits) throw new RangeError('Cubic root exponent limit');
            const result = value.n << BigInt(value.e - exponent); valid(result); return result;
        }));
    };
    const gcdInt = function* (a: bigint, b: bigint): Generator<void, bigint> {
        a = absolute(a); b = absolute(b);
        while (b) { const next = a % b; a = b; b = next; yield; }
        return a;
    };
    const primitive = function* (input: Polynomial, positive: boolean): Generator<void, Polynomial> {
        const value = trim(input); if (!value.length) return value;
        let factor = 0n;
        for (const coefficient of value) { factor = yield* gcdInt(factor, coefficient); if (factor === 1n) break; yield; }
        if (factor > 1n) for (let i = 0; i < value.length; i++) { value[i] /= factor; yield; }
        if (positive && value[value.length - 1] < 0n) for (let i = 0; i < value.length; i++) { value[i] = -value[i]; yield; }
        return value;
    };
    // Multiplication by a positive leading coefficient preserves the sign of
    // the rational remainder, which the Sturm sequence depends on.
    const remainder = function* (left: Polynomial, right: Polynomial): Generator<void, Polynomial> {
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
    const gcdPoly = function* (left: Polynomial, right: Polynomial): Generator<void, Polynomial> {
        let a = yield* primitive(left, true), b = yield* primitive(right, true);
        while (b.length) { const next = yield* remainder(a, b); a = b; b = yield* primitive(next, true); yield; }
        return yield* primitive(a, true);
    };
    const sign = (value: bigint): number => value < 0n ? -1 : value > 0n ? 1 : 0;
    const atOne = (polynomial: Polynomial): bigint => { let value = 0n; for (const coefficient of polynomial) { value += coefficient; valid(value); } return value; };
    const variations = (sequence: readonly Polynomial[], endpoint: 0 | 1): number => {
        let previous = 0, result = 0;
        for (const polynomial of sequence) {
            const current = sign(endpoint ? atOne(polynomial) : polynomial[0] ?? 0n);
            if (current && previous && current !== previous) result++;
            if (current) previous = current;
        }
        return result;
    };
    const calculate = function* (): Generator<void, CubicRootResult> {
        const x = integer(coefficients(points.map(point => point.x) as unknown as readonly [Dyadic, Dyadic, Dyadic, Dyadic], query.x)); yield;
        const y = integer(coefficients(points.map(point => point.y) as unknown as readonly [Dyadic, Dyadic, Dyadic, Dyadic], query.y)); yield;
        if (!x.length && !y.length) return { status: 'hit' };
        const common = yield* gcdPoly(x, y);
        if (common.length <= 1) return { status: 'miss' };
        if (common[0] === 0n || atOne(common) === 0n) return { status: 'hit' };
        const derivative: Polynomial = [];
        for (let i = 1; i < common.length; i++) { derivative.push(common[i] * BigInt(i)); valid(derivative[i - 1]); yield; }
        const sequence: Polynomial[] = [common, yield* primitive(derivative, false)];
        while (sequence[sequence.length - 1].length) {
            const raw = yield* remainder(sequence[sequence.length - 2], sequence[sequence.length - 1]);
            if (!raw.length) break;
            for (let i = 0; i < raw.length; i++) { raw[i] = -raw[i]; yield; }
            sequence.push(yield* primitive(raw, false)); yield;
        }
        return { status: variations(sequence, 0) > variations(sequence, 1) ? 'hit' : 'miss' };
    };
    let iterator: Generator<void, CubicRootResult> | undefined, finished: CubicRootResult | undefined, cancelled = false, spent = 0;
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid cubic root slice');
            if (cancelled) return Object.freeze({ status: 'uncertain', reason: 'Cubic root certificate cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) { finished = Object.freeze({ status: 'uncertain', reason: 'Cubic root work limit exhausted' }); return finished; }
                    const next = iterator.next(); if (next.done) { finished = Object.freeze(next.value); return finished; }
                }
                return PENDING;
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                finished = Object.freeze({ status: 'uncertain', reason: error.message }); return finished;
            }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Cubic root certificate cancelled' }); iterator = undefined; },
    };
}
