import { exactAffinePoint } from './exactAffine';
import { exactPoint, exactPointIntervals, type ExactPoint } from './homogeneous';
import { dyadicSubtract, type Dyadic } from './numeric';
import { exactPointOnSegment } from './exactSegments';
import { createFillPointJob } from './fillPoint';
import { createCurveCapsuleCertificate } from './curveCapsuleCertificate';
import { classifyCertifiedClipBox, preparePointClip, type PointClipContour } from './clippedPointPathJob';
import { createClippedFilledPolygonJob } from './clippedFilledPolygonJob';
import { createClippedFilledSweepJob } from './clippedFilledSweepJob';
import type { PathOp } from './path';
import type { RegionQuery } from './types';

export type CompoundFillResult = Readonly<{ status: 'pending' | 'hit' | 'miss' | 'empty' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: CompoundFillResult = Object.freeze({ status: 'pending' });
function midpoint(a: Dyadic, b: Dyadic): Dyadic {
    const sum = dyadicSubtract(a, { n: -b.n, e: b.e }); return { n: sum.n, e: sum.e - 1 };
}
function middle(a: ExactPoint, b: ExactPoint): ExactPoint {
    return { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y), w: { n: 1n, e: 0 } };
}

export function createClippedCompoundFillJob(paths: readonly (readonly PathOp[])[], query: RegionQuery, frames: readonly PointClipContour[], options: {
    readonly maxCommands?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): CompoundFillResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 8192, maxWork = options.maxWork ?? 4000000;
    if (!Number.isSafeInteger(maxCommands) || maxCommands < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1 || frames.length > 64)
        throw new RangeError('Invalid compound fill query');
    const containment = query.kind === 'polygon' && query.containment, clips = frames.map(preparePointClip);
    const calculate = function* (): Generator<void, CompoundFillResult> {
        let any = false, possible = false, uncertain = false;
        for (const path of paths) {
            const job = query.kind === 'polygon' ? createClippedFilledPolygonJob(path, query, { frames, fill: true, strokeRadiusLocal: 0, maxCommands })
                : createClippedFilledSweepJob(path, query, { frames, fill: true, strokeRadiusLocal: 0, maxCommands });
            try {
                for (;;) {
                    const result = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                    if (result.status === 'pending') { yield; continue; }
                    if (result.status === 'uncertain') uncertain = true;
                    else if (result.status !== 'empty') {
                        any = true;
                        if (containment && result.status === 'miss') uncertain = true;
                        if (!containment && result.status === 'hit') possible = true;
                    }
                    break;
                }
            } finally { job.cancel(); }
            yield;
        }
        if (containment && uncertain) return { status: 'uncertain', reason: 'Compound fill containment needs a winding partition' };
        if (containment && !any) return { status: 'empty' };
        if (!containment && !possible && !uncertain) return { status: 'miss' };
        const vertices: ExactPoint[] = [], regionPath: PathOp[] = [];
        for (const point of query.points) { vertices.push(exactPoint(point)); regionPath.push({ op: regionPath.length ? 'L' : 'M', p: point }); yield; }
        if (query.kind === 'polygon') regionPath.push({ op: 'Z' });
        const candidates: ExactPoint[] = [];
        for (let i = 0; i < vertices.length; i++) {
            candidates.push(vertices[i]);
            if (i) candidates.push(middle(vertices[i - 1], vertices[i]));
            yield;
        }
        if (query.kind === 'polygon' && vertices.length > 2) candidates.push(middle(vertices[0], middle(vertices[1], vertices[2])));
        for (const path of paths) {
            let prior: ExactPoint | undefined;
            for (const op of path) {
                if (op.op === 'Z') continue;
                const next = exactAffinePoint(query.localToSurface, op.p);
                candidates.push(next); if (prior) candidates.push(middle(prior, next)); prior = next;
                if (candidates.length > maxCommands * 4) return { status: 'uncertain', reason: 'Compound fill witness budget exhausted' };
                yield;
            }
        }
        for (const candidate of candidates) {
            const p = exactPointIntervals(candidate), box = [p.x.lo, p.y.lo, p.x.hi, p.y.hi] as const;
            if (!clips.every(frame => classifyCertifiedClipBox(box, frame) === 'inside')) { yield; continue; }
            const fill = createFillPointJob(paths, { x: 0, y: 0 }, 'nonzero', { exactPoint: candidate, localToWorld: query.localToSurface, maxCommands });
            let inFill = false;
            for (;;) {
                const result = fill.step({ deadline: performance.now() + 3, maxWork: 1 });
                if (result.status === 'pending') { yield; continue; }
                inFill = result.status === 'inside'; break;
            }
            if (!inFill) { yield; continue; }
            if (containment) return { status: 'hit' };
            if (query.kind === 'polygon') {
                const region = createFillPointJob([regionPath], { x: 0, y: 0 }, 'nonzero', { exactPoint: candidate, maxCommands: query.points.length + 1 });
                for (;;) {
                    const result = region.step({ deadline: performance.now() + 3, maxWork: 1 });
                    if (result.status === 'pending') { yield; continue; }
                    if (result.status === 'inside') return { status: 'hit' };
                    if (result.status === 'uncertain') for (let i = 0; i < vertices.length; i++) {
                        if (exactPointOnSegment(candidate, vertices[i], vertices[(i + 1) % vertices.length])) return { status: 'hit' };
                        yield;
                    }
                    break;
                }
            } else {
                const count = Math.max(1, vertices.length - 1);
                for (let i = 0; i < count; i++) {
                    const job = createCurveCapsuleCertificate([candidate, candidate], vertices[i], vertices[Math.min(i + 1, vertices.length - 1)], query.radiusCss);
                    try {
                        for (;;) {
                            const result = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                            if (result.status === 'pending') { yield; continue; }
                            if (result.status === 'hit') return { status: 'hit' };
                            break;
                        }
                    } finally { job.cancel(); }
                    yield;
                }
            }
        }
        return { status: 'uncertain', reason: containment ? 'Compound fill visibility has no certified winding witness' : 'Compound fill overlap has no certified winding witness' };
    };
    let iterator: Generator<void, CompoundFillResult> | undefined, spent = 0, cancelled = false, finished: CompoundFillResult | undefined;
    const finish = (result: CompoundFillResult): CompoundFillResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid compound fill slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Compound fill query cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Compound fill work limit exhausted' });
                    const result = iterator.next(); if (result.done) return finish(result.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Compound fill query cancelled' }); iterator = undefined; },
    };
}
