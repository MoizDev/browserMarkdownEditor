import { createClippedFilledPolygonJob } from './clippedFilledPolygonJob';
import { createClippedFilledSweepJob } from './clippedFilledSweepJob';
import type { PointClipContour } from './clippedPointPathJob';
import type { PathOp } from './path';
import type { RegionQuery } from './types';
import type { VectorNarrowDescriptor, VectorNarrowResult } from './vectorNarrow';

const PENDING: VectorNarrowResult = Object.freeze({ status: 'pending' });

/** Every visible realized stroke and semantic fill participates in containment;
 * any one certified component can establish ordinary overlap. */
export function createClippedVectorRegionJob(descriptor: VectorNarrowDescriptor, query: RegionQuery, frames: readonly PointClipContour[]): {
    step(budget: { readonly deadline: number; readonly maxWork: number }): VectorNarrowResult; cancel(): void;
} {
    const containment = query.kind === 'polygon' && query.containment;
    let partIndex = 0, pathIndex = 0, fillDone = false, seen = false, cancelled = false, finished: VectorNarrowResult | undefined;
    let uncertain: { reason: string; part: VectorNarrowDescriptor['parts'][number]['part'] } | undefined;
    let active: ReturnType<typeof createClippedFilledPolygonJob> | ReturnType<typeof createClippedFilledSweepJob> | undefined;
    const finish = (value: VectorNarrowResult): VectorNarrowResult => { finished = Object.freeze(value); return finished; };
    const start = (path: readonly PathOp[], fill: boolean, strokeRadiusLocal: number, maxCommands: number) => query.kind === 'polygon'
        ? createClippedFilledPolygonJob(path, query, { frames, fill, strokeRadiusLocal, maxCommands })
        : createClippedFilledSweepJob(path, query, { frames, fill, strokeRadiusLocal, maxCommands });
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped vector region slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped vector region cancelled', part: 'body' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (partIndex >= descriptor.parts.length) {
                    if (uncertain) return finish({ status: 'uncertain', ...uncertain });
                    return containment && seen ? finish({ status: 'hit', result: { hit: true, distanceCss: 0, part: 'body' } }) : finish({ status: 'miss' });
                }
                const part = descriptor.parts[partIndex], fills = part.options.interiorPaths ?? [];
                if (fills.length > 1) return finish({ status: 'uncertain', reason: 'Compound clipped fills require a winding partition', part: part.part });
                if (!active) {
                    if (!fillDone && fills.length) { fillDone = true; active = start(fills[0], true, 0, part.options.maxSegments); }
                    else if (pathIndex < part.paths.length) active = start(part.paths[pathIndex++], false, part.options.strokeRadiusLocal, part.options.maxSegments);
                    else { partIndex++; pathIndex = 0; fillDone = false; continue; }
                }
                const state = active.step({ deadline: budget.deadline, maxWork: 1 });
                if (state.status === 'pending') continue;
                active.cancel(); active = undefined;
                if (state.status === 'uncertain') { uncertain ??= { reason: state.reason, part: part.part }; continue; }
                if (state.status === 'empty') continue;
                seen = true;
                if (containment && state.status === 'miss') return finish({ status: 'miss' });
                if (!containment && state.status === 'hit') return finish({ status: 'hit', result: { hit: true, distanceCss: 0, part: part.part } });
            }
            return PENDING;
        },
        cancel() { cancelled = true; active?.cancel(); active = undefined; },
    };
}
