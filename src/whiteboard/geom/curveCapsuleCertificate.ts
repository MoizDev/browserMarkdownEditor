import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import { createPolynomialArithmetic } from './polynomial';
import { bernsteinPower, createCurveDiskCertificate } from './curveDiskCertificate';
import type { ExactCurvePoint } from './cubicRootCertificate';
import { splitExactCurve } from './exactCurve';

export type CurveCapsuleResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
type Curve = readonly [ExactCurvePoint, ExactCurvePoint] | readonly [ExactCurvePoint, ExactCurvePoint, ExactCurvePoint, ExactCurvePoint];
type Work = Readonly<{ points: Curve; depth: number }>;
const PENDING: CurveCapsuleResult = Object.freeze({ status: 'pending' });
const ZERO: Dyadic = Object.freeze({ n: 0n, e: 0 });
function add(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function compare(a: Dyadic, b: Dyadic): -1 | 0 | 1 { const value = dyadicSubtract(a, b).n; return value < 0n ? -1 : value > 0n ? 1 : 0; }
function split(value: Work): readonly [Work, Work] {
    const [left, right] = splitExactCurve(value.points), depth = value.depth + 1;
    return [{ points: left, depth }, { points: right, depth }];
}

/** Exact curve/closed-capsule intersection: end disks plus a certified finite
 * projection of the strip polynomial. Every polynomial step remains resumable. */
export function createCurveCapsuleCertificate(points: Curve, start: ExactCurvePoint, end: ExactCurvePoint, radius: number, options: {
    readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number; readonly maxBits?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CurveCapsuleResult; cancel(): void } {
    const maxDepth = options.maxDepth ?? 64, maxNodes = options.maxNodes ?? 131072, maxWork = options.maxWork ?? 1000000;
    if (!Number.isFinite(radius) || radius < 0 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128
        || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid curve capsule certificate');
    const arithmetic = createPolynomialArithmetic(options.maxBits ?? 16384), r = dyadic(radius);
    const dx = dyadicSubtract(end.x, start.x), dy = dyadicSubtract(end.y, start.y);
    const lengthSquared = add(dyadicMultiply(dx, dx), dyadicMultiply(dy, dy));
    const degenerate = lengthSquared.n === 0n, limit = dyadicMultiply(dyadicMultiply(r, r), lengthSquared);
    const project = (p: ExactCurvePoint) => {
        const x = dyadicSubtract(p.x, start.x), y = dyadicSubtract(p.y, start.y);
        return { cross: dyadicSubtract(dyadicMultiply(x, dy), dyadicMultiply(y, dx)),
            along: add(dyadicMultiply(x, dx), dyadicMultiply(y, dy)) };
    };
    const strip = function* (cross: readonly Dyadic[]): Generator<void, boolean> {
        const power = bernsteinPower(cross, ZERO), polynomial: Dyadic[] = Array.from({ length: power.length * 2 - 1 }, () => ZERO);
        for (let i = 0; i < power.length; i++) for (let j = 0; j < power.length; j++) {
            polynomial[i + j] = add(polynomial[i + j], dyadicMultiply(power[i], power[j])); yield;
        }
        polynomial[0] = dyadicSubtract(polynomial[0], limit);
        const value = arithmetic.integer(polynomial); yield;
        if (!value.length || value[0] <= 0n || arithmetic.atOne(value) <= 0n) return true;
        return yield* arithmetic.hasRoot01(value);
    };
    let finished: CurveCapsuleResult | undefined, cancelled = false, spent = 0, nodes = 1, uncertain = false;
    let phase: 'start' | 'end' | 'curves' = 'start', disk: ReturnType<typeof createCurveDiskCertificate> | undefined;
    let stripJob: Generator<void, boolean> | undefined, activeCurve: Work | undefined, activeContained = false;
    const stack: Work[] = [{ points, depth: 0 }];
    const finish = (value: CurveCapsuleResult): CurveCapsuleResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid curve capsule slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Curve capsule certificate cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Curve capsule work limit exhausted' });
                    if (disk) {
                        const value = disk.step({ deadline: budget.deadline, maxWork: 1 });
                        if (value.status === 'pending') continue;
                        disk.cancel(); disk = undefined;
                        if (value.status === 'hit') return finish({ status: 'hit' });
                        if (value.status === 'uncertain') uncertain = true;
                        if (phase === 'start' && !degenerate) { phase = 'end'; continue; }
                        if (degenerate) return finish(uncertain ? { status: 'uncertain', reason: 'Capsule endpoint cannot be certified' } : { status: 'miss' });
                        phase = 'curves'; continue;
                    }
                    if (stripJob) {
                        const result = stripJob.next(); if (!result.done) continue;
                        stripJob = undefined; const curve = activeCurve!; activeCurve = undefined;
                        if (!result.value) continue;
                        if (activeContained) return finish({ status: 'hit' });
                        if (curve.depth >= maxDepth) { uncertain = true; continue; }
                        if (nodes + 2 > maxNodes) return finish({ status: 'uncertain', reason: 'Curve capsule node limit exhausted' });
                        const [left, right] = split(curve); nodes += 2; stack.push(right, left); continue;
                    }
                    if (phase === 'start') { disk = createCurveDiskCertificate(points, start, radius, { maxBits: options.maxBits }); continue; }
                    if (phase === 'end') { disk = createCurveDiskCertificate(points, end, radius, { maxBits: options.maxBits }); continue; }
                    const curve = stack.pop();
                    if (!curve) return finish(uncertain ? { status: 'uncertain', reason: 'Curve capsule boundary cannot be certified' } : { status: 'miss' });
                    const projected = curve.points.map(project);
                    if (projected.every(value => compare(value.along, ZERO) < 0) || projected.every(value => compare(value.along, lengthSquared) > 0)) continue;
                    activeContained = projected.every(value => compare(value.along, ZERO) >= 0 && compare(value.along, lengthSquared) <= 0);
                    activeCurve = curve; stripJob = strip(projected.map(value => value.cross));
                }
                return PENDING;
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                return finish({ status: 'uncertain', reason: error.message });
            }
        },
        cancel() { cancelled = true; disk?.cancel(); disk = undefined; stripJob?.return(false); stripJob = undefined; stack.length = 0; },
    };
}
