import type { Affine } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactPoint, exactPointIntervals, type ExactPoint } from './homogeneous';
import { createFillPointJob } from './fillPoint';
import { classifyCertifiedClipBox, clipBoxStrictlyInside, certifiedIntervalPointBox, preparePointClip,
    type CertifiedClipRegion, type PointClipContour } from './clippedPointPathJob';
import { createClippedPolygonPathJob, type ClippedPolygonResult } from './clippedPolygonPathJob';
import type { PathOp } from './path';
import type { RegionQuery } from './types';

type Polygon = Extract<RegionQuery, { kind: 'polygon' }>;
type Sample = Readonly<{ point: ExactPoint; polygon: 'inside' | 'outside' | 'overlap'; visible: boolean; queryVertex: boolean; strict: boolean }>;
const PENDING: ClippedPolygonResult = Object.freeze({ status: 'pending' });
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** Convex polygon queries against a clipped filled contour and optional stroke.
 * Certified witnesses decide overlap; containment needs a whole-shape or frame certificate. */
export function createClippedFilledPolygonJob(path: readonly PathOp[], query: Polygon, options: {
    readonly frames: readonly PointClipContour[];
    readonly fill: boolean;
    readonly strokeRadiusLocal: number;
    readonly maxCommands?: number;
    readonly maxWork?: number;
}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ClippedPolygonResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 8192, maxWork = options.maxWork ?? 2000000;
    if (query.points.length < 3 || query.points.length > 64 || options.frames.length > 64 || !Number.isSafeInteger(maxCommands) || maxCommands < 1
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid clipped filled polygon');
    const polygonPath: PathOp[] = query.points.map((point, index) => ({ op: index ? 'L' : 'M', p: { x: point.x, y: point.y } }));
    polygonPath.push({ op: 'Z' });
    let polygon: CertifiedClipRegion | undefined, finished: ClippedPolygonResult | undefined;
    try { polygon = preparePointClip({ outline: polygonPath, localToSurface: IDENTITY }); }
    catch { finished = { status: 'uncertain', reason: 'Polygon is not a certified convex region' }; }
    const frames = options.frames.map(preparePointClip);
    const boundary = createClippedPolygonPathJob([path], query, { strokeRadiusLocal: options.strokeRadiusLocal, frames: options.frames, exclusions: [], maxCommands });
    const fullBoundary = query.containment && options.fill && options.frames.length
        ? createClippedPolygonPathJob([path], query, { strokeRadiusLocal: options.strokeRadiusLocal, frames: [], exclusions: [], maxCommands }) : undefined;
    let phase: 'boundary' | 'samples' | 'full' = 'boundary', cancelled = false, spent = 0, uncertain = false, visible = false;
    let boundaryResult: ClippedPolygonResult | undefined, index = 0, frameIndex = 0, opIndex = 0, frameInside = true, anyFrameInside = false;
    let fill: ReturnType<typeof createFillPointJob> | undefined, currentSample: Sample | undefined;
    const finish = (value: ClippedPolygonResult): ClippedPolygonResult => { finished = Object.freeze(value); return finished; };
    const sample = (point: ExactPoint, queryVertex: boolean): Sample => {
        const box = certifiedIntervalPointBox(exactPointIntervals(point));
        return { point, polygon: classifyCertifiedClipBox(box, polygon!), queryVertex, strict: clipBoxStrictlyInside(box, polygon!),
            visible: frames.every(frame => classifyCertifiedClipBox(box, frame) === 'inside') };
    };
    const nextSample = (): Sample | undefined => {
        if (index < query.points.length) return sample(exactPoint(query.points[index++]), true);
        while (frameIndex < options.frames.length) {
            const frame = options.frames[frameIndex];
            while (opIndex < frame.outline.length) {
                const op = frame.outline[opIndex++];
                if (op.op === 'Z') continue;
                if (op.op !== 'M' && op.op !== 'L') throw new Error('Frame clip must be polygonal');
                const point = exactAffinePoint(frame.localToSurface, op.p), box = certifiedIntervalPointBox(exactPointIntervals(point));
                if (!clipBoxStrictlyInside(box, polygon!)) frameInside = false;
                return sample(point, false);
            }
            anyFrameInside ||= frameInside; frameInside = true; frameIndex++; opIndex = 0;
        }
        return undefined;
    };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid clipped filled polygon slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Clipped filled polygon cancelled' });
            if (finished) return finished;
            for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Clipped filled polygon work limit exhausted' });
                if (phase === 'boundary') {
                    const state = boundary.step({ deadline: budget.deadline, maxWork: 1 });
                    if (state.status === 'pending') continue;
                    boundaryResult = state;
                    if (state.status === 'uncertain') uncertain = true;
                    else if (query.containment && state.status === 'miss') return finish({ status: 'miss' });
                    else if (!query.containment && state.status === 'hit') return finish({ status: 'hit' });
                    else if (state.status === 'hit') visible = true;
                    if (!options.fill) return finish(state);
                    phase = 'samples'; continue;
                }
                if (phase === 'samples') {
                    if (fill) {
                        const state = fill.step({ deadline: budget.deadline, maxWork: 1 });
                        if (state.status === 'pending') continue;
                        fill = undefined;
                        if (state.status === 'uncertain') uncertain = true;
                        else if (state.status === 'inside') {
                            visible = true;
                            if (!query.containment && currentSample!.polygon === 'inside') return finish({ status: 'hit' });
                            if (query.containment && (currentSample!.polygon === 'outside' || currentSample!.queryVertex)) return finish({ status: 'miss' });
                            if (currentSample!.polygon === 'overlap' || (query.containment && !currentSample!.strict)) uncertain = true;
                        }
                        currentSample = undefined; continue;
                    }
                    const candidate = nextSample();
                    if (candidate) {
                        if (!candidate.visible) continue;
                        currentSample = candidate;
                        fill = createFillPointJob([path], { x: 0, y: 0 }, 'nonzero',
                            { exactPoint: candidate.point, localToWorld: query.localToSurface, maxCommands });
                        continue;
                    }
                    if (!query.containment) return finish(options.frames.length || uncertain
                        ? { status: 'uncertain', reason: 'Clipped fill overlap cannot be certified' } : { status: 'miss' });
                    if (visible && anyFrameInside) return finish({ status: 'hit' });
                    if (!fullBoundary) return finish(boundaryResult?.status === 'hit' && visible && !uncertain
                        ? { status: 'hit' } : { status: 'uncertain', reason: 'Clipped fill containment cannot be certified' });
                    phase = 'full'; continue;
                }
                const state = fullBoundary!.step({ deadline: budget.deadline, maxWork: 1 });
                if (state.status === 'pending') continue;
                if (state.status === 'hit' && visible) return finish({ status: 'hit' });
                return finish({ status: 'uncertain', reason: 'Clipped fill containment cannot be certified' });
            }
            return PENDING;
        },
        cancel() { cancelled = true; boundary.cancel(); fullBoundary?.cancel(); },
    };
}
