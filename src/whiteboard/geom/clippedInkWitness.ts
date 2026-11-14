import type { Affine } from '../../platform/types';
import { INK_COARSE_MARGIN_CSS, INK_FINE_MARGIN_CSS, type InkPickQuery } from '../ink/pick';
import type { InkCoverage } from '../ink/outline';
import { exactAffinePoint } from './exactAffine';
import { exactPoint, exactPointIntervals } from './homogeneous';
import { add, dyadic, dyadicMultiply, dyadicSubtract, interval, subtract } from './numeric';
import { classifyCertifiedClipBox, type CertifiedClipRegion } from './clippedPointPathJob';
import { upperPointIntervalDistance } from './pointPathJob';
import { createCurveCapsuleCertificate } from './curveCapsuleCertificate';
import { createFillPointJob } from './fillPoint';
import type { PathOp } from './path';
import type { RegionQuery } from './types';

export type InkWitnessResult = Readonly<{ status: 'pending' | 'hit' | 'none' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: InkWitnessResult = Object.freeze({ status: 'pending' });
type Query = Readonly<{ kind: 'point'; point: Extract<InkPickQuery, { kind: 'point' }> }> | Readonly<{ kind: 'region'; region: RegionQuery }>;
interface Disc { readonly x: number; readonly y: number; readonly radius: number }
function insideDisc(x: number, y: number, centre: Disc, radius: number): boolean {
    const dx = dyadicSubtract(dyadic(x), dyadic(centre.x)), dy = dyadicSubtract(dyadic(y), dyadic(centre.y)), r = dyadic(radius);
    const xx = dyadicMultiply(dx, dx), yy = dyadicMultiply(dy, dy), square = dyadicSubtract(xx, { n: -yy.n, e: yy.e });
    return dyadicSubtract(square, dyadicMultiply(r, r)).n <= 0n;
}

/** Find a fully visible point of an error-contracted ink disc. Exhausting the
 * finite grid proves nothing and is deliberately not returned as a miss. */
export function createClippedInkWitnessJob(coverage: InkCoverage, matrix: Affine, frames: readonly CertifiedClipRegion[], query: Query,
    options: { readonly maxSamples?: number; readonly maxWork?: number } = {}): {
        step(budget: { readonly deadline: number; readonly maxWork: number }): InkWitnessResult; cancel(): void;
    } {
    const maxSamples = options.maxSamples ?? 1024, maxWork = options.maxWork ?? 1000000;
    if (!matrix.every(Number.isFinite) || !Number.isSafeInteger(maxSamples) || maxSamples < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1
        || (query.kind === 'region' && query.region.kind === 'polygon' && query.region.containment)) throw new RangeError('Invalid clipped ink witness query');
    const errors = [coverage.centreErrorWorld, coverage.radiusErrorWorld, coverage.dashPhaseErrorWorld];
    if (!errors.every(value => Number.isFinite(value) && value >= 0)) throw new RangeError('Invalid ink witness error');
    const error = add(add(interval(errors[0]), interval(errors[1])), interval(errors[2])).hi;
    const discs: Disc[] = [];
    if (coverage.segments.length) {
        if (coverage.segments.length !== 6) throw new RangeError('Ink witness requires one primitive');
        const d = coverage.segments; discs.push({ x: d[0], y: d[1], radius: d[2] }, { x: d[3], y: d[4], radius: d[5] });
    } else if (coverage.discs.length) {
        if (coverage.discs.length !== 3) throw new RangeError('Ink witness requires one primitive');
        const d = coverage.discs; discs.push({ x: d[0], y: d[1], radius: d[2] });
    }
    const calculate = function* (): Generator<void, InkWitnessResult> {
        let samples = 0;
        let polygon: PathOp[] | undefined;
        if (query.kind === 'region' && query.region.kind === 'polygon') {
            polygon = [];
            for (const point of query.region.points) { polygon.push({ op: polygon.length ? 'L' : 'M', p: point }); yield; }
            polygon.push({ op: 'Z' });
        }
        for (const disc of discs) {
            if (![disc.x, disc.y, disc.radius].every(Number.isFinite) || disc.radius < 0) throw new RangeError('Invalid ink witness disc');
            const radius = subtract(interval(disc.radius), interval(error)).lo;
            if (!(radius > 0)) continue;
            for (let level = 0; level <= 5; level++) {
                const steps = 1 << level;
                for (let iy = 0; iy <= steps; iy++) for (let ix = 0; ix <= steps; ix++) {
                    if (++samples > maxSamples) return { status: 'none' };
                    const x = disc.x + radius * ((2 * ix - steps) / steps), y = disc.y + radius * ((2 * iy - steps) / steps);
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !insideDisc(x, y, disc, radius)) { yield; continue; }
                    const exact = exactAffinePoint(matrix, { x, y }), p = exactPointIntervals(exact), box = [p.x.lo, p.y.lo, p.x.hi, p.y.hi] as const;
                    if (!frames.every(frame => classifyCertifiedClipBox(box, frame) === 'inside')) { yield; continue; }
                    if (query.kind === 'point') {
                        const q = query.point, margin = q.pointer === 'touch' || q.pointer === 'coarse' ? INK_COARSE_MARGIN_CSS : INK_FINE_MARGIN_CSS;
                        if (upperPointIntervalDistance({ x: q.x, y: q.y }, p) <= margin) return { status: 'hit' };
                    } else if (query.region.kind === 'polygon') {
                        const fill = createFillPointJob([polygon!], { x: 0, y: 0 }, 'nonzero', { exactPoint: exact, maxCommands: query.region.points.length + 1 });
                        for (;;) {
                            const result = fill.step({ deadline: performance.now() + 3, maxWork: 1 });
                            if (result.status === 'pending') { yield; continue; }
                            if (result.status === 'inside') return { status: 'hit' };
                            break;
                        }
                    } else {
                        const q = query.region, count = Math.max(1, q.points.length - 1);
                        for (let i = 0; i < count; i++) {
                            const a = exactPoint(q.points[i]), b = exactPoint(q.points[Math.min(i + 1, q.points.length - 1)]);
                            const certificate = createCurveCapsuleCertificate([exact, exact], a, b, q.radiusCss);
                            try {
                                for (;;) {
                                    const result = certificate.step({ deadline: performance.now() + 3, maxWork: 1 });
                                    if (result.status === 'pending') { yield; continue; }
                                    if (result.status === 'hit') return { status: 'hit' };
                                    break;
                                }
                            } finally { certificate.cancel(); }
                            yield;
                        }
                    }
                    yield;
                }
            }
        }
        return { status: 'none' };
    };
    let iterator: Generator<void, InkWitnessResult> | undefined, spent = 0, cancelled = false, finished: InkWitnessResult | undefined;
    const finish = (value: InkWitnessResult): InkWitnessResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid ink witness slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Ink witness cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Ink witness work limit exhausted' });
                    const next = iterator.next(); if (next.done) return finish(next.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Ink witness cancelled' }); iterator = undefined; },
    };
}
