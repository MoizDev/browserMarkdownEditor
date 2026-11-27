import { dyadicSubtract, type Dyadic } from './numeric';
import { createPolynomialArithmetic } from './polynomial';

export interface ExactCurvePoint { readonly x: Dyadic; readonly y: Dyadic }
export type CubicRootResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
export interface CubicRootLimits { readonly maxBits?: number; readonly maxWork?: number }
const PENDING: CubicRootResult = Object.freeze({ status: 'pending' });
function sum(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function times(a: Dyadic, coefficient: bigint): Dyadic { return { n: a.n * coefficient, e: a.e }; }
function coefficients(p: readonly [Dyadic, Dyadic, Dyadic, Dyadic], q: Dyadic): readonly Dyadic[] {
    return [dyadicSubtract(p[0], q), times(dyadicSubtract(p[1], p[0]), 3n),
        times(sum(dyadicSubtract(p[0], times(p[1], 2n)), p[2]), 3n),
        sum(dyadicSubtract(times(p[1], 3n), p[0]), dyadicSubtract(p[3], times(p[2], 3n)))];
}

export function createCubicRootCertificate(points: readonly [ExactCurvePoint, ExactCurvePoint, ExactCurvePoint, ExactCurvePoint],
    query: ExactCurvePoint, limits: CubicRootLimits = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CubicRootResult; cancel(): void } {
    const maxBits = limits.maxBits ?? 16384, maxWork = limits.maxWork ?? 1000000;
    if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid cubic root certificate budget');
    const arithmetic = createPolynomialArithmetic(maxBits);
    const calculate = function* (): Generator<void, CubicRootResult> {
        const x = arithmetic.integer(coefficients(points.map(point => point.x) as unknown as readonly [Dyadic, Dyadic, Dyadic, Dyadic], query.x)); yield;
        const y = arithmetic.integer(coefficients(points.map(point => point.y) as unknown as readonly [Dyadic, Dyadic, Dyadic, Dyadic], query.y)); yield;
        if (!x.length && !y.length) return { status: 'hit' };
        const common = yield* arithmetic.gcd(x, y);
        return { status: (yield* arithmetic.hasRoot01(common)) ? 'hit' : 'miss' };
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
