import type { Affine } from '../../platform/types';
import { exactPoint, exactPointIntervals, type ExactPoint } from './homogeneous';
import { exactPointOnSegment } from './exactSegments';
import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import { splitExactCurve, type ExactCurve } from './exactCurve';
import { classifyClippedVisibility, type CertifiedClipRegion } from './clippedPointPathJob';
import { createCurveCapsuleCertificate } from './curveCapsuleCertificate';
import type { ExactCurvePoint } from './cubicRootCertificate';
import { createFillPointJob } from './fillPoint';
import type { PathOp, Vec2 } from './path';

export type StrokeRegionWitnessResult = Readonly<{ status: 'pending' | 'hit' | 'none' }> | Readonly<{ status: 'uncertain'; reason: string }>;
type Query = Readonly<{ kind: 'swept'; endpoints: readonly [ExactCurvePoint, ExactCurvePoint]; radius: number }>
    | Readonly<{ kind: 'polygon'; points: readonly Vec2[] }>;
const PENDING: StrokeRegionWitnessResult = Object.freeze({ status: 'pending' });
function add(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function inside(u: number, v: number, radius: number): boolean {
    const x = dyadic(u), y = dyadic(v), r = dyadic(radius);
    return dyadicSubtract(add(dyadicMultiply(x, x), dyadicMultiply(y, y)), dyadicMultiply(r, r)).n <= 0n;
}

export function createClippedStrokeRegionWitnessJob(curve: ExactCurve, matrix: Affine, radius: number,
    frames: readonly CertifiedClipRegion[], exclusions: readonly CertifiedClipRegion[], query: Query, options: {
        readonly maxSamples?: number; readonly maxWork?: number;
    } = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): StrokeRegionWitnessResult; cancel(): void } {
    const maxSamples = options.maxSamples ?? 512, maxWork = options.maxWork ?? 1000000;
    if (![...matrix, radius].every(Number.isFinite) || radius < 0 || !Number.isSafeInteger(maxSamples) || maxSamples < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || (query.kind === 'swept' && (!Number.isFinite(query.radius) || query.radius < 0))
        || (query.kind === 'polygon' && query.points.length < 3)) throw new RangeError('Invalid clipped stroke region witness');
    const [a, b, c, d] = matrix.map(dyadic);
    const calculate = function* (): Generator<void, StrokeRegionWitnessResult> {
        const [left, right] = splitExactCurve(curve), centres = [curve[0], left[left.length - 1], right[right.length - 1]];
        const polygon: PathOp[] = [], vertices: ExactPoint[] = [];
        if (query.kind === 'polygon') {
            for (const point of query.points) { vertices.push(exactPoint(point)); polygon.push({ op: polygon.length ? 'L' : 'M', p: point }); yield; }
            polygon.push({ op: 'Z' });
        }
        let samples = 0;
        for (let level = 0; level <= (radius ? 4 : 0); level++) {
            const steps = 1 << level;
            for (const centre of centres) for (let y = 0; y <= steps; y++) for (let x = 0; x <= steps; x++) {
                if (++samples > maxSamples) return { status: 'none' };
                const u = radius * ((2 * x - steps) / steps), v = radius * ((2 * y - steps) / steps);
                if (!Number.isFinite(u) || !Number.isFinite(v) || !inside(u, v, radius)) { yield; continue; }
                const du = dyadic(u), dv = dyadic(v), point: ExactPoint = {
                    x: add(centre.x, add(dyadicMultiply(a, du), dyadicMultiply(c, dv))),
                    y: add(centre.y, add(dyadicMultiply(b, du), dyadicMultiply(d, dv))), w: { n: 1n, e: 0 },
                };
                const p = exactPointIntervals(point), box = [p.x.lo, p.y.lo, p.x.hi, p.y.hi] as const;
                if (classifyClippedVisibility(box, frames, exclusions) !== 'inside') { yield; continue; }
                if (query.kind === 'swept') {
                    const job = createCurveCapsuleCertificate([point, point], query.endpoints[0], query.endpoints[1], query.radius);
                    try {
                        for (;;) {
                            const value = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                            if (value.status === 'pending') { yield; continue; }
                            if (value.status === 'hit') return { status: 'hit' };
                            break;
                        }
                    } finally { job.cancel(); }
                } else {
                    const fill = createFillPointJob([polygon], { x: 0, y: 0 }, 'nonzero', { exactPoint: point, maxCommands: vertices.length + 1 });
                    for (;;) {
                        const value = fill.step({ deadline: performance.now() + 3, maxWork: 1 });
                        if (value.status === 'pending') { yield; continue; }
                        if (value.status === 'inside') return { status: 'hit' };
                        if (value.status === 'uncertain') for (let i = 0; i < vertices.length; i++) {
                            if (exactPointOnSegment(point, vertices[i], vertices[(i + 1) % vertices.length])) return { status: 'hit' };
                            yield;
                        }
                        break;
                    }
                }
                yield;
            }
        }
        return { status: 'none' };
    };
    let iterator: Generator<void, StrokeRegionWitnessResult> | undefined, spent = 0, cancelled = false, finished: StrokeRegionWitnessResult | undefined;
    const finish = (value: StrokeRegionWitnessResult): StrokeRegionWitnessResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid stroke region witness slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Stroke region witness cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Stroke region witness work limit exhausted' });
                    const next = iterator.next(); if (next.done) return finish(next.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Stroke region witness cancelled' }); iterator = undefined; },
    };
}
