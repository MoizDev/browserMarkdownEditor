import { createFillPointJob } from './fillPoint';
import { classifyCertifiedClipBox, preparePointClip, type PointClipContour } from './clippedPointPathJob';
import { createClippedSweptPathJob, type ClippedSweepResult } from './clippedSweptPathJob';
import type { PathOp } from './path';
import type { RegionQuery } from './types';

type Sweep = Extract<RegionQuery, { kind: 'swept' }>;
const PENDING: ClippedSweepResult = Object.freeze({ status: 'pending' });

export function createClippedFilledSweepJob(path: readonly PathOp[], query: Sweep, options: {
    readonly frames: readonly PointClipContour[];
    readonly strokeRadiusLocal: number;
    readonly fill: boolean;
    readonly maxCommands?: number;
    readonly maxWork?: number;
}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ClippedSweepResult; cancel(): void } {
    const maxWork = options.maxWork ?? 2000000, maxCommands = options.maxCommands ?? 8192;
    if (!Number.isSafeInteger(maxWork) || maxWork < 1 || !Number.isSafeInteger(maxCommands) || maxCommands < 1)
        throw new RangeError('Invalid clipped filled sweep budget');
    const frames = options.frames.map(preparePointClip);
    const boundary = createClippedSweptPathJob([path], query, { frames: options.frames, exclusions: [],
        strokeRadiusLocal: options.strokeRadiusLocal, maxCommands });
    let finished: ClippedSweepResult | undefined, cancelled = false, spent = 0, index = 0, uncertain = false;
    let fill: ReturnType<typeof createFillPointJob> | undefined;
    const finish = (value: ClippedSweepResult): ClippedSweepResult => { finished = Object.freeze(value); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid filled sweep slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped filled sweep cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped filled sweep work limit exhausted' });
                if (options.fill && index < query.points.length) {
                    const point = query.points[index];
                    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid sweep point');
                    const box = [point.x, point.y, point.x, point.y] as const;
                    if (frames.some(frame => classifyCertifiedClipBox(box, frame) !== 'inside')) {
                        if (query.points.length > 1) uncertain = true;
                        fill = undefined; index++; continue;
                    }
                    if (!fill) fill = createFillPointJob([path], point, 'nonzero', { localToWorld: query.localToSurface, maxCommands });
                    const state = fill.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    if (state.status === 'inside') return finish({ status: 'hit' });
                    if (state.status === 'uncertain') uncertain = true;
                    fill = undefined; index++; continue;
                }
                const state = boundary.step({ deadline: budget.deadline, maxWork: 1 });
                if (state.status === 'pending') continue;
                if (state.status === 'hit') return finish(state);
                if (state.status === 'uncertain') return finish(state);
                return finish(uncertain ? { status: 'uncertain', reason: 'Clipped filled boundary cannot be certified' } : { status: 'miss' });
            }
            return PENDING;
        },
        cancel() { cancelled = true; boundary.cancel(); },
    };
}
