import { createPointPathJob } from './pointPathJob';
import { createCubicBoundaryJob } from './cubicBoundaryJob';
import { createPolygonPathJob } from './polygonPathJob';
import { createSweptPathJob } from './sweptPathJob';
import type { PathOp } from './path';
import type { PathPickOptions } from './pick';
import type { NarrowResult, PointQuery, RegionQuery } from './types';

export interface VectorNarrowPart {
    readonly part: NarrowResult['part'];
    readonly paths: readonly (readonly PathOp[])[];
    readonly options: PathPickOptions;
}
export interface VectorNarrowDescriptor { readonly parts: readonly VectorNarrowPart[] }
export type VectorNarrowResult =
    | Readonly<{ status: 'pending' | 'miss' }>
    | Readonly<{ status: 'hit'; result: NarrowResult }>
    | Readonly<{ status: 'uncertain'; reason: string; part: NarrowResult['part'] }>;
const descriptors = new WeakMap<object, VectorNarrowDescriptor>();
const PENDING: VectorNarrowResult = Object.freeze({ status: 'pending' });

/** Registration is keyed by the exact immutable provider, never by a node id or live cache slot. */
export function registerVectorNarrow(owner: object, descriptor: VectorNarrowDescriptor): void {
    if (!descriptors.has(owner)) descriptors.set(owner, descriptor);
}
export function vectorNarrowDescriptor(owner: object): VectorNarrowDescriptor | undefined { return descriptors.get(owner); }

/** Higher-priority label/title parts precede body parts; an uncertain higher
 * part cannot be demoted to a lower-priority confirmed hit. */
export function createVectorPointJob(descriptor: VectorNarrowDescriptor, query: PointQuery): {
    step(budget: { readonly deadline: number; readonly maxWork: number }): VectorNarrowResult; cancel(): void;
} {
    let index = 0, cancelled = false, finished: VectorNarrowResult | undefined;
    let active: ReturnType<typeof createPointPathJob> | undefined, boundary: ReturnType<typeof createCubicBoundaryJob> | undefined;
    let boundaryReason = '';
    const finish = (result: VectorNarrowResult): VectorNarrowResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid vector point slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Vector point job cancelled', part: 'body' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (index >= descriptor.parts.length) return finish({ status: 'miss' });
                const part = descriptor.parts[index];
                if (boundary) {
                    const value = boundary.step({ deadline: budget.deadline, maxWork: 1 });
                    if (value.status === 'pending') continue;
                    boundary.cancel(); boundary = undefined;
                    return value.status === 'hit' ? finish({ status: 'hit', result: { hit: true, distanceCss: 0, part: part.part } })
                        : finish({ status: 'uncertain', reason: boundaryReason, part: part.part });
                }
                active ??= createPointPathJob(part.paths, query, part.options);
                const state = active.step({ deadline: budget.deadline, maxWork: 1 });
                if (state.status === 'pending') continue;
                active.cancel(); active = undefined;
                if (state.status === 'hit') return finish({ status: 'hit', result: { hit: true, distanceCss: state.distanceCss, part: part.part } });
                if (state.status === 'uncertain') {
                    if (part.options.interiorPaths?.length) {
                        boundaryReason = state.reason;
                        boundary = createCubicBoundaryJob(part.options.interiorPaths, query.point, query.localToSurface, { maxCommands: part.options.maxSegments });
                        continue;
                    }
                    return finish({ status: 'uncertain', reason: state.reason, part: part.part });
                }
                index++;
            }
            return PENDING;
        },
        cancel() { cancelled = true; active?.cancel(); boundary?.cancel(); active = undefined; boundary = undefined; },
    };
}

/** Each constituent must be contained; any constituent can establish overlap. */
export function createVectorRegionJob(descriptor: VectorNarrowDescriptor, query: RegionQuery): {
    step(budget: { readonly deadline: number; readonly maxWork: number }): VectorNarrowResult; cancel(): void;
} {
    let index = 0, cancelled = false, uncertain: { reason: string; part: NarrowResult['part'] } | undefined, finished: VectorNarrowResult | undefined;
    let active: ReturnType<typeof createPolygonPathJob> | ReturnType<typeof createSweptPathJob> | undefined;
    const containment = query.kind === 'polygon' && query.containment;
    const finish = (result: VectorNarrowResult): VectorNarrowResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid vector region slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Vector region job cancelled', part: 'body' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (index >= descriptor.parts.length) {
                    if (uncertain) return finish({ status: 'uncertain', ...uncertain });
                    return containment && descriptor.parts.length ? finish({ status: 'hit', result: { hit: true, distanceCss: 0, part: 'body' } })
                        : finish({ status: 'miss' });
                }
                const part = descriptor.parts[index];
                active ??= query.kind === 'polygon' ? createPolygonPathJob(part.paths, query, part.options) : createSweptPathJob(part.paths, query, part.options);
                const state = active.step({ deadline: budget.deadline, maxWork: 1 });
                if (state.status === 'pending') continue;
                active.cancel(); active = undefined; index++;
                if (state.status === 'uncertain') { uncertain ??= { reason: state.reason, part: part.part }; continue; }
                if (containment && state.status === 'miss') return finish({ status: 'miss' });
                if (!containment && state.status === 'hit') return finish({ status: 'hit', result: { hit: true, distanceCss: 0, part: part.part } });
            }
            return PENDING;
        },
        cancel() { cancelled = true; active?.cancel(); active = undefined; },
    };
}
