import type { Affine } from '../../platform/types';
import { createContourBoxClearJob } from './contourBoxClearJob';
import { createFillPointJob } from './fillPoint';
import type { CertifiedClipBox } from './clippedPointPathJob';
import type { PathOp } from './path';

export type ContourBoxFillResult = Readonly<{ status: 'pending' | 'inside' | 'outside' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: ContourBoxFillResult = Object.freeze({ status: 'pending' });

/** Classify every point of a closed box, first certifying that the contour
 * cannot cross the box and then classifying one exact representable witness. */
export function createContourBoxFillJob(path: readonly PathOp[], transform: Affine, box: CertifiedClipBox, options: {
    readonly fillRule?: 'nonzero' | 'evenodd'; readonly maxCommands?: number; readonly maxDepth?: number; readonly maxNodes?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ContourBoxFillResult; cancel(): void } {
    const maxWork = options.maxWork ?? 2000000;
    if (!Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid contour box fill budget');
    const point = { x: box[0] / 2 + box[2] / 2, y: box[1] / 2 + box[3] / 2 };
    if (![point.x, point.y].every(Number.isFinite) || point.x < box[0] || point.x > box[2] || point.y < box[1] || point.y > box[3])
        throw new RangeError('Contour box witness is not representable');
    let clear: ReturnType<typeof createContourBoxClearJob> | undefined = createContourBoxClearJob(path, transform, box, options);
    let fill: ReturnType<typeof createFillPointJob> | undefined, spent = 0, cancelled = false, finished: ContourBoxFillResult | undefined;
    const finish = (result: ContourBoxFillResult): ContourBoxFillResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid contour box fill slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Contour box fill cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Contour box fill work limit exhausted' });
                if (clear) {
                    const result = clear.step({ deadline: budget.deadline, maxWork: 1 });
                    if (result.status === 'pending') continue;
                    clear.cancel(); clear = undefined;
                    if (result.status === 'uncertain') return finish(result);
                    fill = createFillPointJob([path], point, options.fillRule ?? 'nonzero', { localToWorld: transform,
                        maxCommands: options.maxCommands, maxDepth: options.maxDepth, maxNodes: options.maxNodes, maxWork });
                    continue;
                }
                const result = fill!.step({ deadline: budget.deadline, maxWork: 1 });
                if (result.status !== 'pending') return finish(result);
            }
            return PENDING;
        },
        cancel() { cancelled = true; clear?.cancel(); clear = undefined; fill = undefined; },
    };
}
