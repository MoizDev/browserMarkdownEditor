import type { Affine } from '../../platform/types';
import { exactPointIntervals, type ExactPoint } from './homogeneous';
import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import { classifyClippedVisibility, type CertifiedClipRegion } from './clippedPointPathJob';
import { upperPointIntervalDistance } from './pointPathJob';
import type { Vec2 } from './path';

export type StrokeWitnessResult = Readonly<{ status: 'pending' | 'hit' | 'none' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: StrokeWitnessResult = Object.freeze({ status: 'pending' });
function add(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function inside(u: number, v: number, radius: number): boolean {
    const x = dyadic(u), y = dyadic(v), r = dyadic(radius);
    return dyadicSubtract(add(dyadicMultiply(x, x), dyadicMultiply(y, y)), dyadicMultiply(r, r)).n <= 0n;
}

export function createClippedStrokeWitnessJob(curve: ExactCurve, matrix: Affine, radius: number, query: Vec2, margin: number,
    frames: readonly CertifiedClipRegion[], exclusions: readonly CertifiedClipRegion[], options: {
        readonly maxSamples?: number; readonly maxWork?: number;
    } = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): StrokeWitnessResult; cancel(): void } {
    const maxSamples = options.maxSamples ?? 512, maxWork = options.maxWork ?? 100000;
    if (![...matrix, radius, query.x, query.y, margin].every(Number.isFinite) || radius < 0 || margin < 0
        || !Number.isSafeInteger(maxSamples) || maxSamples < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid clipped stroke witness');
    const [a, b, c, d] = matrix.map(dyadic);
    const calculate = function* (): Generator<void, StrokeWitnessResult> {
        const [left, right] = splitExactCurve(curve), centres = [curve[0], left[left.length - 1], right[right.length - 1]];
        let samples = 0;
        for (let level = 0; level <= (radius ? 4 : 0); level++) {
            const steps = 1 << level;
            for (const centre of centres) {
                for (let y = 0; y <= steps; y++) for (let x = 0; x <= steps; x++) {
                    if (++samples > maxSamples) return { status: 'none' };
                    const u = radius * ((2 * x - steps) / steps), v = radius * ((2 * y - steps) / steps);
                    if (!Number.isFinite(u) || !Number.isFinite(v) || !inside(u, v, radius)) { yield; continue; }
                    const du = dyadic(u), dv = dyadic(v), point: ExactPoint = {
                        x: add(centre.x, add(dyadicMultiply(a, du), dyadicMultiply(c, dv))),
                        y: add(centre.y, add(dyadicMultiply(b, du), dyadicMultiply(d, dv))), w: { n: 1n, e: 0 },
                    };
                    const intervals = exactPointIntervals(point), box = [intervals.x.lo, intervals.y.lo, intervals.x.hi, intervals.y.hi] as const;
                    if (classifyClippedVisibility(box, frames, exclusions) === 'inside' && upperPointIntervalDistance(query, intervals) <= margin)
                        return { status: 'hit' };
                    yield;
                }
            }
        }
        return { status: 'none' };
    };
    let iterator: Generator<void, StrokeWitnessResult> | undefined, spent = 0, cancelled = false, finished: StrokeWitnessResult | undefined;
    const finish = (value: StrokeWitnessResult): StrokeWitnessResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped stroke witness slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped stroke witness cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped stroke witness work limit exhausted' });
                    const next = iterator.next(); if (next.done) return finish(next.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Clipped stroke witness cancelled' }); iterator = undefined; },
    };
}
