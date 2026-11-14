import { createFillPointJob } from './fillPoint';
import { classifyCertifiedClipBox, createClippedPointPathJob, preparePointClip, type PointClipContour } from './clippedPointPathJob';
import type { PointQuery } from './types';
import type { VectorNarrowDescriptor, VectorNarrowResult } from './vectorNarrow';

const PENDING: VectorNarrowResult = Object.freeze({ status: 'pending' });

/** Preserve provider part priority while certifying each semantic fill or
 * realized stroke against all ancestor frame clips. */
export function createClippedVectorPointJob(descriptor: VectorNarrowDescriptor, query: PointQuery, frames: readonly PointClipContour[]): {
    step(budget: { readonly deadline: number; readonly maxWork: number }): VectorNarrowResult; cancel(): void;
} {
    const clips = frames.map(preparePointClip), box = [query.point.x, query.point.y, query.point.x, query.point.y] as const;
    const pointerVisible = clips.every(clip => classifyCertifiedClipBox(box, clip) === 'inside');
    let index = 0, cancelled = false, finished: VectorNarrowResult | undefined, fillUncertain = false, fillStarted = false;
    let fill: ReturnType<typeof createFillPointJob> | undefined, stroke: ReturnType<typeof createClippedPointPathJob> | undefined;
    const finish = (value: VectorNarrowResult): VectorNarrowResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped vector point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped vector point cancelled', part: 'body' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (index >= descriptor.parts.length) return finish({ status: 'miss' });
                const part = descriptor.parts[index];
                if (!fillStarted) {
                    fillStarted = true;
                    if (pointerVisible && part.options.interiorPaths?.length) fill = createFillPointJob(part.options.interiorPaths, query.point, 'nonzero',
                        { localToWorld: query.localToSurface, maxCommands: part.options.maxSegments });
                }
                if (fill) {
                    const value = fill.step({ deadline: budget.deadline, maxWork: 1 });
                    if (value.status === 'pending') continue;
                    fill = undefined;
                    if (value.status === 'inside') return finish({ status: 'hit', result: { hit: true, distanceCss: 0, part: part.part } });
                    if (value.status === 'uncertain') fillUncertain = true;
                    continue;
                }
                stroke ??= createClippedPointPathJob(part.paths, query, { frames, exclusions: [], strokeRadiusLocal: part.options.strokeRadiusLocal,
                    marginCss: part.options.marginCss, maxCommands: part.options.maxSegments });
                const value = stroke.step({ deadline: budget.deadline, maxWork: 1 });
                if (value.status === 'pending') continue;
                stroke.cancel(); stroke = undefined;
                if (value.status === 'hit') return finish({ status: 'hit', result: { hit: true, distanceCss: value.distanceCss, part: part.part } });
                if (value.status === 'uncertain' || fillUncertain) return finish({ status: 'uncertain',
                    reason: value.status === 'uncertain' ? value.reason : 'Clipped vector fill boundary cannot be certified', part: part.part });
                index++; fillStarted = false; fillUncertain = false;
            }
            return PENDING;
        },
        cancel() { cancelled = true; stroke?.cancel(); stroke = undefined; fill = undefined; },
    };
}
