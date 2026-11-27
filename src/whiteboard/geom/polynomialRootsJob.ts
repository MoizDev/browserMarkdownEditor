import { createPolynomialArithmetic, type DyadicRootCell } from './polynomial';
import type { Dyadic } from './numeric';

export type PolynomialRootsResult = Readonly<{ status: 'pending' }> | Readonly<{ status: 'done'; roots: readonly DyadicRootCell[] }>
    | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: PolynomialRootsResult = Object.freeze({ status: 'pending' });

export function createPolynomialRootsJob(coefficients: readonly Dyadic[], options: {
    readonly minDepth?: number; readonly maxDepth?: number; readonly maxNodes?: number; readonly maxBits?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): PolynomialRootsResult; cancel(): void } {
    const minDepth = options.minDepth ?? 0, maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 262144;
    const maxWork = options.maxWork ?? 2000000, arithmetic = createPolynomialArithmetic(options.maxBits ?? 16384);
    if (!coefficients.length || coefficients.length > 33 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid polynomial root job');
    let iterator: Generator<void, readonly DyadicRootCell[]> | undefined, cancelled = false, spent = 0, finished: PolynomialRootsResult | undefined;
    const finish = (result: PolynomialRootsResult): PolynomialRootsResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid polynomial root slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Polynomial root job cancelled' });
            if (finished) return finished;
            try {
                iterator ??= arithmetic.roots01(arithmetic.integer(coefficients), { minDepth, maxDepth, maxNodes });
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Polynomial root work limit exhausted' });
                    const next = iterator.next();
                    if (next.done) return finish({ status: 'done', roots: Object.freeze(next.value.map(root => Object.freeze(root))) });
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return([]); iterator = undefined; },
    };
}
