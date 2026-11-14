import { createPointPathJob } from './pointPathJob';
import { createFillPointJob } from './fillPoint';
import { createCubicBoundaryJob } from './cubicBoundaryJob';
import type { PathOp } from './path';
import type { PointQuery } from './types';

export type AttachmentPointResult = Readonly<{ status: 'pending' | 'hit' | 'miss' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: AttachmentPointResult = Object.freeze({ status: 'pending' });

/** Attachments use the closed coverage, not the selection halo. An approximate
 * contour is usable only when the query is provably farther than its error. */
export function createAttachmentPointJob(outline: readonly PathOp[], query: PointQuery, options: {
    readonly boundaryErrorLocal?: number; readonly maxCommands?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): AttachmentPointResult; cancel(): void } {
    const error = options.boundaryErrorLocal ?? 0, maxCommands = options.maxCommands ?? 8192, maxWork = options.maxWork ?? 2000000;
    if (!Number.isFinite(error) || error < 0 || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid attachment point query');
    let proximity: ReturnType<typeof createPointPathJob> | undefined = error ? createPointPathJob([outline], { ...query, input: 'mouse' }, {
        strokeRadiusLocal: error, marginCss: 0, errorCss: 0.01, maxSegments: maxCommands }) : undefined;
    let fill: ReturnType<typeof createFillPointJob> | undefined, boundary: ReturnType<typeof createCubicBoundaryJob> | undefined;
    let spent = 0, cancelled = false, finished: AttachmentPointResult | undefined;
    const finish = (result: AttachmentPointResult): AttachmentPointResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid attachment point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Attachment point query cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Attachment point work limit exhausted' });
                if (proximity) {
                    const result = proximity.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    proximity.cancel(); proximity = undefined;
                    if (result.status !== 'miss') return finish({ status: 'uncertain', reason: 'Point is within attachment contour error' });
                }
                if (boundary) {
                    const result = boundary.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    boundary.cancel(); boundary = undefined;
                    return finish(result.status === 'hit' ? { status: 'hit' }
                        : { status: 'uncertain', reason: 'Attachment boundary could not be classified' });
                }
                fill ??= createFillPointJob([outline], query.point, 'nonzero', { localToWorld: query.localToSurface, maxCommands, maxWork });
                const result = fill.step({ deadline: budget.deadline, maxWork: 1 });
                if (result.status === 'pending') continue;
                if (result.status === 'inside') return finish({ status: 'hit' });
                if (result.status === 'outside') return finish({ status: 'miss' });
                fill = undefined;
                if (error && result.status === 'uncertain') return finish({ status: 'uncertain', reason: result.reason });
                boundary = createCubicBoundaryJob([outline], query.point, query.localToSurface, { maxCommands, maxWork });
            }
            return PENDING;
        },
        cancel() { cancelled = true; proximity?.cancel(); boundary?.cancel(); proximity = undefined; boundary = undefined; fill = undefined; },
    };
}
