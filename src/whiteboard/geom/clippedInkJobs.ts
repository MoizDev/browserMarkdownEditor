import type { Affine } from '../../platform/types';
import { InkPickJob, type InkPickQuery } from '../ink/pick';
import { InkRegionPickJob } from '../ink/regionPick';
import type { InkCoverage } from '../ink/outline';
import { exactAffinePoint } from './exactAffine';
import { exactPointIntervals } from './homogeneous';
import { add, interval } from './numeric';
import { strokeRadiusBounds } from './strokeRadiusBounds';
import { classifyCertifiedClipBox, expandCertifiedClipBox, preparePointClip, type CertifiedClipBox, type PointClipContour } from './clippedPointPathJob';
import type { RegionQuery } from './types';

export type ClippedInkResult = Readonly<{ status: 'pending' | 'hit' | 'miss' | 'empty' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: ClippedInkResult = Object.freeze({ status: 'pending' });
type Primitive = Readonly<{ coverage: InkCoverage; bounds: CertifiedClipBox }>;

/** Geometry enclosures are transformed before frame classification; a source
 * enclosure outside any frame cannot contribute, including its error margin. */
function primitiveBounds(matrix: Affine, ax: number, ay: number, bx: number, by: number, radius: number, error: number): CertifiedClipBox {
    if (![ax, ay, bx, by, radius, error].every(Number.isFinite) || radius < 0 || error < 0) throw new RangeError('Invalid clipped ink primitive');
    const a = exactPointIntervals(exactAffinePoint(matrix, { x: ax, y: ay })), b = exactPointIntervals(exactAffinePoint(matrix, { x: bx, y: by }));
    const localRadius = add(interval(radius), interval(error)).hi, extent = strokeRadiusBounds(matrix, localRadius);
    if (!extent || !Number.isFinite(extent.hi)) throw new RangeError('Clipped ink extent overflows');
    return expandCertifiedClipBox([Math.min(a.x.lo, b.x.lo), Math.min(a.y.lo, b.y.lo), Math.max(a.x.hi, b.x.hi), Math.max(a.y.hi, b.y.hi)], extent.hi);
}
function outwardError(coverage: InkCoverage): number {
    if (![coverage.centreErrorWorld, coverage.radiusErrorWorld, coverage.dashPhaseErrorWorld].every(value => Number.isFinite(value) && value >= 0))
        throw new RangeError('Invalid clipped ink error');
    const value = add(add(interval(coverage.centreErrorWorld), interval(coverage.radiusErrorWorld)), interval(coverage.dashPhaseErrorWorld)).hi;
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid clipped ink error');
    return value;
}
function primitives(coverage: InkCoverage, matrix: Affine, includeCentreline: boolean): Generator<Primitive> {
    const error = outwardError(coverage), emptySegments = coverage.segments.subarray(0, 0), emptyDiscs = coverage.discs.subarray(0, 0);
    const emptyCentre = coverage.centreline.subarray(0, 0);
    return (function* () {
        if (coverage.segments.length % 6 || coverage.discs.length % 3 || coverage.centreline.length % 4) throw new RangeError('Invalid clipped ink storage');
        for (let i = 0; i < coverage.segments.length; i += 6) {
            const d = coverage.segments;
            if (![d[i + 2], d[i + 5]].every(value => Number.isFinite(value) && value >= 0)) throw new RangeError('Invalid clipped ink radius');
            const bounds = primitiveBounds(matrix, d[i], d[i + 1], d[i + 3], d[i + 4], Math.max(d[i + 2], d[i + 5]), error);
            yield { bounds, coverage: { ...coverage, segments: d.subarray(i, i + 6), discs: emptyDiscs, centreline: emptyCentre } };
        }
        for (let i = 0; i < coverage.discs.length; i += 3) {
            const d = coverage.discs, bounds = primitiveBounds(matrix, d[i], d[i + 1], d[i], d[i + 1], d[i + 2], error);
            yield { bounds, coverage: { ...coverage, segments: emptySegments, discs: d.subarray(i, i + 3), centreline: emptyCentre } };
        }
        if (includeCentreline) for (let i = 0; i < coverage.centreline.length; i += 4) {
            const d = coverage.centreline, bounds = primitiveBounds(matrix, d[i], d[i + 1], d[i + 2], d[i + 3], 0, coverage.centreErrorWorld);
            yield { bounds, coverage: { ...coverage, segments: emptySegments, discs: emptyDiscs, centreline: d.subarray(i, i + 4) } };
        }
    })();
}
function clipRelation(box: CertifiedClipBox, frames: ReturnType<typeof preparePointClip>[]): 'inside' | 'outside' | 'overlap' {
    let overlap = false;
    for (const frame of frames) {
        const value = classifyCertifiedClipBox(box, frame);
        if (value === 'outside') return 'outside';
        if (value === 'overlap') overlap = true;
    }
    return overlap ? 'overlap' : 'inside';
}

/** A point hit is accepted only when its entire generating ink primitive is
 * visible. A partial clip with a possible witness remains explicit uncertainty. */
export function createClippedInkPointJob(coverage: InkCoverage, matrix: Affine, query: InkPickQuery, dpr: number,
    frames: readonly PointClipContour[], maxWork = 2000000): { step(budget: { deadline: number; maxWork: number }): ClippedInkResult; cancel(): void } {
    if (query.kind !== 'point' || !matrix.every(Number.isFinite) || !Number.isFinite(dpr) || dpr <= 0 || frames.length > 64
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid clipped ink point query');
    const clips = frames.map(preparePointClip), iterator = primitives(coverage, matrix, true);
    let active: InkPickJob | undefined, relation: 'inside' | 'outside' | 'overlap' = 'outside', uncertain = false;
    let spent = 0, cancelled = false, finished: ClippedInkResult | undefined;
    const finish = (value: ClippedInkResult): ClippedInkResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped ink point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped ink point cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped ink point work limit exhausted' });
                    if (!active) {
                        const next = iterator.next();
                        if (next.done) return finish(uncertain ? { status: 'uncertain', reason: 'Ink point witness intersects a frame boundary' } : { status: 'miss' });
                        relation = clipRelation(next.value.bounds, clips); if (relation === 'outside') continue;
                        active = new InkPickJob(next.value.coverage, matrix, query, dpr);
                    }
                    const state = active.step(1);
                    if (state === 'pending') continue;
                    if (state === 'cancelled') return finish({ status: 'uncertain', reason: 'Clipped ink point cancelled' });
                    const result = active.result; active.cancel(); active = undefined;
                    if (result.decision === 'hit' && relation === 'inside') return finish({ status: 'hit' });
                    if (result.decision !== 'miss') uncertain = true;
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; active?.cancel(); active = undefined; iterator.return(undefined); },
    };
}

/** Region containment requires every visible primitive; overlap needs one
 * fully visible witness. Frame-straddling undecided primitives are not dropped. */
export function createClippedInkRegionJob(coverage: InkCoverage, matrix: Affine, query: RegionQuery, dpr: number,
    frames: readonly PointClipContour[], maxWork = 4000000): { step(budget: { deadline: number; maxWork: number }): ClippedInkResult; cancel(): void } {
    if (!matrix.every(Number.isFinite) || !Number.isFinite(dpr) || dpr <= 0 || frames.length > 64
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid clipped ink region query');
    const clips = frames.map(preparePointClip), iterator = primitives(coverage, matrix, false), containment = query.kind === 'polygon' && query.containment;
    let active: InkRegionPickJob | undefined, relation: 'inside' | 'outside' | 'overlap' = 'outside';
    let seen = false, uncertain = false, spent = 0, cancelled = false, finished: ClippedInkResult | undefined;
    const finish = (value: ClippedInkResult): ClippedInkResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped ink region slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped ink region cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped ink region work limit exhausted' });
                    if (!active) {
                        const next = iterator.next();
                        if (next.done) {
                            if (uncertain) return finish({ status: 'uncertain', reason: 'Ink region meets a frame boundary' });
                            return finish(containment ? { status: seen ? 'hit' : 'empty' } : { status: 'miss' });
                        }
                        relation = clipRelation(next.value.bounds, clips); if (relation === 'outside') continue;
                        active = new InkRegionPickJob(next.value.coverage, matrix, query, dpr);
                    }
                    const state = active.step({ deadline: budget.deadline, maxVisits: 1 });
                    if (state.status === 'pending') continue;
                    const decision = state.result!.decision; active.cancel(); active = undefined;
                    if (relation === 'inside') {
                        seen = true;
                        if (containment && decision === 'miss') return finish({ status: 'miss' });
                        if (!containment && decision === 'hit') return finish({ status: 'hit' });
                        if (decision === 'uncertain') uncertain = true;
                    } else if (containment || decision !== 'miss') uncertain = true;
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; active?.cancel(); active = undefined; iterator.return(undefined); },
    };
}
