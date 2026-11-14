import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactPointIntervals } from './homogeneous';
import { createFillPointJob } from './fillPoint';
import { classifyCertifiedClipBox, preparePointClip, type PointClipContour } from './clippedPointPathJob';
import type { PathOp, Vec2 } from './path';

export type FillVisibilityResult = Readonly<{ status: 'pending' | 'visible' | 'unresolved' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: FillVisibilityResult = Object.freeze({ status: 'pending' });

/** A bounded grid can prove a compound nonzero fill is visible; failure to
 * find a witness never proves that the fill is empty. */
export function createFillVisibilityWitnessJob(paths: readonly (readonly PathOp[])[], matrix: Affine, frames: readonly PointClipContour[], options: {
    readonly maxCommands?: number; readonly maxSamples?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): FillVisibilityResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 65_536, maxSamples = options.maxSamples ?? 2048, maxWork = options.maxWork ?? 2000000;
    if (!matrix.every(Number.isFinite) || frames.length > 64 || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxSamples) || maxSamples < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid fill visibility query');
    const clips = frames.map(preparePointClip);
    const calculate = function* (): Generator<void, FillVisibilityResult> {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, commands = 0;
        const include = (point: Vec2) => {
            const value = exactPointIntervals(exactAffinePoint(matrix, point));
            x0 = Math.min(x0, value.x.lo); y0 = Math.min(y0, value.y.lo); x1 = Math.max(x1, value.x.hi); y1 = Math.max(y1, value.y.hi);
        };
        for (const path of paths) for (const op of path) {
            if (++commands > maxCommands) return { status: 'uncertain', reason: 'Fill visibility command limit exhausted' };
            if (op.op !== 'Z') { include(op.p); if (op.op === 'C') { include(op.c1); include(op.c2); } }
            yield;
        }
        if (![x0, y0, x1, y1].every(Number.isFinite) || x0 > x1 || y0 > y1) return { status: 'unresolved' };
        let samples = 0;
        for (let level = 0; level <= 6; level++) {
            const steps = 1 << level;
            for (let iy = 0; iy < steps; iy++) for (let ix = 0; ix < steps; ix++) {
                if (++samples > maxSamples) return { status: 'unresolved' };
                const tx = (ix + 0.5) / steps, ty = (iy + 0.5) / steps;
                const point = { x: x0 * (1 - tx) + x1 * tx, y: y0 * (1 - ty) + y1 * ty };
                if (![point.x, point.y].every(Number.isFinite)) { yield; continue; }
                const box = [point.x, point.y, point.x, point.y] as const;
                if (!clips.every(frame => classifyCertifiedClipBox(box, frame) === 'inside')) { yield; continue; }
                const job = createFillPointJob(paths, point, 'nonzero', { localToWorld: matrix, maxCommands, maxWork });
                for (;;) {
                    const result = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                    if (result.status === 'pending') { yield; continue; }
                    if (result.status === 'inside') return { status: 'visible' };
                    break;
                }
                yield;
            }
        }
        return { status: 'unresolved' };
    };
    let iterator: Generator<void, FillVisibilityResult> | undefined, spent = 0, cancelled = false, finished: FillVisibilityResult | undefined;
    const finish = (result: FillVisibilityResult): FillVisibilityResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid fill visibility slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Fill visibility cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Fill visibility work limit exhausted' });
                    const next = iterator.next(); if (next.done) return finish(next.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Fill visibility cancelled' }); iterator = undefined; },
    };
}
