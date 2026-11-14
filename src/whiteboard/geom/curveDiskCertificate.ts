import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import { createPolynomialArithmetic } from './polynomial';
import type { ExactCurvePoint } from './cubicRootCertificate';

export type CurveDiskResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface CurveDiskLimits { readonly maxBits?: number; readonly maxWork?: number }
type Curve = readonly [ExactCurvePoint, ExactCurvePoint] | readonly [ExactCurvePoint, ExactCurvePoint, ExactCurvePoint, ExactCurvePoint];
const PENDING: CurveDiskResult = Object.freeze({ status: 'pending' });
const ZERO: Dyadic = Object.freeze({ n: 0n, e: 0 });
function add(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function times(a: Dyadic, coefficient: bigint): Dyadic { return { n: a.n * coefficient, e: a.e }; }
export function bernsteinPower(values: readonly Dyadic[], origin: Dyadic): Dyadic[] {
    if (values.length === 2) return [dyadicSubtract(values[0], origin), dyadicSubtract(values[1], values[0])];
    if (values.length !== 4) throw new RangeError('Unsupported curve degree');
    return [dyadicSubtract(values[0], origin), times(dyadicSubtract(values[1], values[0]), 3n),
        times(add(dyadicSubtract(values[0], times(values[1], 2n)), values[2]), 3n),
        add(dyadicSubtract(times(values[1], 3n), values[0]), dyadicSubtract(values[3], times(values[2], 3n)))];
}

/** Exact curve/closed-disk intersection. The degree-six distance polynomial
 * is nonpositive somewhere iff an endpoint is nonpositive or it has a real root. */
export function createCurveDiskCertificate(curve: Curve, centre: ExactCurvePoint, radius: number,
    limits: CurveDiskLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CurveDiskResult; cancel(): void } {
    const maxBits = limits.maxBits ?? 16384, maxWork = limits.maxWork ?? 1000000;
    if (!Number.isFinite(radius) || radius < 0 || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid curve disk certificate');
    const arithmetic = createPolynomialArithmetic(maxBits);
    const calculate = function* (): Generator<void, CurveDiskResult> {
        const x = bernsteinPower(curve.map(point => point.x), centre.x), y = bernsteinPower(curve.map(point => point.y), centre.y), count = x.length * 2 - 1;
        const polynomial: Dyadic[] = Array.from({ length: count }, () => ZERO);
        for (let i = 0; i < x.length; i++) for (let j = 0; j < x.length; j++) {
            polynomial[i + j] = add(polynomial[i + j], add(dyadicMultiply(x[i], x[j]), dyadicMultiply(y[i], y[j]))); yield;
        }
        const r = dyadic(radius); polynomial[0] = dyadicSubtract(polynomial[0], dyadicMultiply(r, r));
        const exact = arithmetic.integer(polynomial); yield;
        if (!exact.length || exact[0] <= 0n || arithmetic.atOne(exact) <= 0n) return { status: 'hit' };
        return { status: (yield* arithmetic.hasRoot01(exact)) ? 'hit' : 'miss' };
    };
    let iterator: Generator<void, CurveDiskResult> | undefined, finished: CurveDiskResult | undefined, cancelled = false, spent = 0;
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid curve disk slice');
            if (cancelled) return Object.freeze({ status: 'uncertain', reason: 'Curve disk certificate cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) { finished = Object.freeze({ status: 'uncertain', reason: 'Curve disk work limit exhausted' }); return finished; }
                    const next = iterator.next(); if (next.done) { finished = Object.freeze(next.value); return finished; }
                }
                return PENDING;
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                finished = Object.freeze({ status: 'uncertain', reason: error.message }); return finished;
            }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Curve disk certificate cancelled' }); iterator = undefined; },
    };
}
