import { createFillPointJob } from './fillPoint';
import { createCubicBoundaryJob } from './cubicBoundaryJob';
import { classifyCertifiedClipBox, createClippedPointPathJob, preparePointClip,
    type ClippedPointResult, type PointClipContour } from './clippedPointPathJob';
import type { PathOp } from './path';
import type { PointQuery } from './types';

const PENDING: ClippedPointResult = Object.freeze({ status: 'pending' });

export function createClippedFilledPointJob(path: readonly PathOp[], query: PointQuery, options: {
    readonly frames: readonly PointClipContour[];
    readonly fill: boolean;
    readonly strokeRadiusLocal: number;
    readonly marginCss: number;
    readonly maxCommands?: number;
    readonly maxWork?: number;
}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ClippedPointResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 8192, maxWork = options.maxWork ?? 1000000;
    if (!Number.isSafeInteger(maxCommands) || maxCommands < 1 || !Number.isSafeInteger(maxWork) || maxWork < 1)
        throw new RangeError('Invalid clipped filled point budget');
    const frames = options.frames.map(preparePointClip), box = [query.point.x, query.point.y, query.point.x, query.point.y] as const;
    const pointerVisible = frames.every(frame => classifyCertifiedClipBox(box, frame) === 'inside');
    const fill = options.fill && pointerVisible ? createFillPointJob([path], query.point, 'nonzero', { localToWorld: query.localToSurface, maxCommands }) : undefined;
    const boundary = createClippedPointPathJob([path], query, { frames: options.frames, exclusions: [],
        strokeRadiusLocal: options.strokeRadiusLocal, marginCss: options.marginCss, maxCommands });
    let fillPending = !!fill, fillUncertain = false, cancelled = false, spent = 0, finished: ClippedPointResult | undefined;
    let exactBoundary: ReturnType<typeof createCubicBoundaryJob> | undefined, boundaryReason = '';
    const finish = (value: ClippedPointResult): ClippedPointResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped filled point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped filled point cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped filled point work limit exhausted' });
                if (exactBoundary) {
                    const value = exactBoundary.step({ deadline: budget.deadline, maxWork: 1 });
                    if (value.status === 'pending') continue;
                    exactBoundary.cancel(); exactBoundary = undefined;
                    return value.status === 'hit' ? finish({ status: 'hit', distanceCss: 0 }) : finish({ status: 'uncertain', reason: boundaryReason });
                }
                if (fillPending) {
                    const state = fill!.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    fillPending = false;
                    if (state.status === 'inside') return finish({ status: 'hit', distanceCss: 0 });
                    if (state.status === 'uncertain') fillUncertain = true;
                    continue;
                }
                const state = boundary.step({ deadline: budget.deadline, maxWork: 1 });
                if (state.status === 'pending') continue;
                if (state.status === 'hit') return finish(state);
                if (state.status === 'uncertain' || fillUncertain) {
                    boundaryReason = state.status === 'uncertain' ? state.reason : 'Clipped fill boundary cannot be certified';
                    if (pointerVisible) { exactBoundary = createCubicBoundaryJob([path], query.point, query.localToSurface, { maxCommands }); continue; }
                    return finish({ status: 'uncertain', reason: boundaryReason });
                }
                return finish({ status: 'miss' });
            }
            return PENDING;
        },
        cancel() { cancelled = true; boundary.cancel(); exactBoundary?.cancel(); exactBoundary = undefined; },
    };
}
