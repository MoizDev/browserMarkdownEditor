import { exactAffinePoint } from './exactAffine';
import { exactPoint, exactPointIntervals, type ExactPoint } from './homogeneous';
import { createExactInverseDistance } from './exactInverseDistance';
import { createCurveCapsuleCertificate } from './curveCapsuleCertificate';
import { createFillPointJob } from './fillPoint';
import { classifyCertifiedClipBox, certifiedCurveBox, expandCertifiedClipBox, preparePointClip, type PointClipContour } from './clippedPointPathJob';
import { splitCertifiedCurve, type CertifiedCurve } from './pointPathJob';
import { splitExactCurve } from './exactCurve';
import { strokeRadiusBounds } from './strokeRadiusBounds';
import type { ExactCurve } from './exactCurve';
import type { PathOp, Vec2 } from './path';
import type { RegionQuery } from './types';
import type { VectorNarrowDescriptor } from './vectorNarrow';

export type NonconvexContainmentResult = Readonly<{ status: 'pending' | 'hit' | 'miss' | 'empty' }> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: NonconvexContainmentResult = Object.freeze({ status: 'pending' });
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

/** A connected stroke or fill component is contained in a simple lasso when
 * one boundary point is inside and its whole boundary misses the lasso edge.
 * Contacts and unsupported transforms stay uncertain, never guessed. */
export function createNonconvexContainmentJob(descriptor: VectorNarrowDescriptor, query: Extract<RegionQuery, { kind: 'polygon' }>, options: {
    readonly frames?: readonly PointClipContour[]; readonly maxCommands?: number; readonly maxEdges?: number; readonly maxWork?: number; readonly maxNodes?: number; readonly maxDepth?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): NonconvexContainmentResult; cancel(): void } {
    const maxCommands = options.maxCommands ?? 65_536, maxEdges = options.maxEdges ?? 8192, maxWork = options.maxWork ?? 4000000;
    const maxNodes = options.maxNodes ?? 262144, maxDepth = options.maxDepth ?? 64;
    if (!query.containment || query.points.length < 3 || query.points.length > maxEdges || !query.localToSurface.every(Number.isFinite)
        || !Number.isSafeInteger(maxCommands) || maxCommands < 1 || !Number.isSafeInteger(maxEdges) || maxEdges < 3
        || !Number.isSafeInteger(maxWork) || maxWork < 1 || !Number.isSafeInteger(maxNodes) || maxNodes < 1
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 128 || (options.frames?.length ?? 0) > 64) throw new RangeError('Invalid nonconvex containment query');
    const calculate = function* (): Generator<void, NonconvexContainmentResult> {
        const polygon: PathOp[] = [], vertices: ExactPoint[] = [];
        for (const point of query.points) {
            if (![point.x, point.y].every(Number.isFinite)) throw new RangeError('Invalid lasso point');
            vertices.push(exactPoint(point)); polygon.push({ op: polygon.length ? 'L' : 'M', p: point }); yield;
        }
        polygon.push({ op: 'Z' });
        const inverse = createExactInverseDistance(query.localToSurface), frames = (options.frames ?? []).map(preparePointClip);
        let seen = false, commands = 0, nodes = 0;
        const exactSegment = function* (curve: ExactCurve, radius: number): Generator<void, 'inside' | 'outside' | 'uncertain'> {
            seen = true;
            const witness = { ...curve[0], w: { n: 1n, e: 0 } };
            const fill = createFillPointJob([polygon], { x: 0, y: 0 }, 'nonzero', { exactPoint: witness, localToWorld: IDENTITY,
                maxCommands: maxEdges + 1, maxWork });
            for (;;) {
                const result = fill.step({ deadline: performance.now() + 3, maxWork: 1 });
                if (result.status === 'pending') { yield; continue; }
                if (result.status === 'outside') return 'outside';
                if (result.status === 'uncertain') return 'uncertain';
                break;
            }
            if (radius > 0 && !inverse) return 'uncertain';
            const mapped = radius > 0 ? curve.map(inverse!.map) as unknown as ExactCurve : curve;
            const strokeRadius = radius > 0 ? inverse!.radius(radius) : 0;
            for (let i = 0; i < vertices.length; i++) {
                const a = vertices[i], b = vertices[(i + 1) % vertices.length];
                const certificate = createCurveCapsuleCertificate(mapped, radius > 0 ? inverse!.map(a) : a,
                    radius > 0 ? inverse!.map(b) : b, strokeRadius);
                try {
                    for (;;) {
                        const result = certificate.step({ deadline: performance.now() + 3, maxWork: 1 });
                        if (result.status === 'pending') { yield; continue; }
                        if (result.status !== 'miss') return 'uncertain';
                        break;
                    }
                } finally { certificate.cancel(); }
                yield;
            }
            return 'inside';
        };
        const segment = function* (curve: ExactCurve, radius: number, fillBoundary: boolean): Generator<void, 'inside' | 'outside' | 'uncertain'> {
            if (!frames.length) return yield* exactSegment(curve, radius);
            const scale = strokeRadiusBounds(query.localToSurface, radius);
            if (!scale) return 'uncertain';
            const points = curve.map(point => exactPointIntervals({ ...point, w: { n: 1n, e: 0 } })) as unknown as CertifiedCurve['points'];
            const stack: { readonly curve: ExactCurve; readonly bounds: CertifiedCurve }[] = [{ curve, bounds: { points, depth: 0 } }];
            if (++nodes > maxNodes) return 'uncertain';
            while (stack.length) {
                const item = stack.pop()!, box = expandCertifiedClipBox(certifiedCurveBox(item.bounds.points), Math.max(0, scale.hi));
                let outside = false, overlap = false;
                for (const frame of frames) {
                    const relation = classifyCertifiedClipBox(box, frame);
                    if (relation === 'outside') { outside = true; break; }
                    if (relation === 'overlap') overlap = true;
                }
                if (outside) { if (fillBoundary) return 'uncertain'; yield; continue; }
                if (!overlap) {
                    const result = yield* exactSegment(item.curve, radius); if (result !== 'inside') return result;
                    yield; continue;
                }
                if (fillBoundary || item.bounds.depth >= maxDepth || nodes + 2 > maxNodes) return 'uncertain';
                const [left, right] = splitCertifiedCurve(item.bounds), [exactLeft, exactRight] = splitExactCurve(item.curve);
                stack.push({ curve: exactRight, bounds: right }, { curve: exactLeft, bounds: left }); nodes += 2; yield;
            }
            return 'inside';
        };
        const path = function* (ops: readonly PathOp[], radius: number, close: boolean): Generator<void, 'inside' | 'outside' | 'uncertain'> {
            if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Invalid vector stroke radius');
            let start: ExactPoint | undefined, previous: ExactPoint | undefined;
            const finishSubpath = function* (): Generator<void, 'inside' | 'outside' | 'uncertain'> {
                if (!close || !start || !previous) return 'inside';
                return yield* segment([previous, start], radius, close);
            };
            for (const op of ops) {
                if (++commands > maxCommands) return 'uncertain';
                if (op.op === 'M') {
                    const state = yield* finishSubpath(); if (state !== 'inside') return state;
                    start = previous = exactAffinePoint(query.localToSurface, op.p); yield; continue;
                }
                if (!start || !previous) throw new RangeError('Vector path must begin with a move');
                const end = op.op === 'Z' ? start : exactAffinePoint(query.localToSurface, op.p);
                const curve: ExactCurve = op.op === 'C'
                    ? [previous, exactAffinePoint(query.localToSurface, op.c1), exactAffinePoint(query.localToSurface, op.c2), end]
                    : [previous, end];
                const state = yield* segment(curve, radius, close); if (state !== 'inside') return state;
                previous = end; yield;
            }
            return yield* finishSubpath();
        };
        for (const part of descriptor.parts) {
            for (const ops of part.paths) {
                const result = yield* path(ops, part.options.strokeRadiusLocal, false);
                if (result === 'outside') return { status: 'miss' };
                if (result === 'uncertain') return { status: 'uncertain', reason: 'Stroke meets a nonconvex lasso boundary' };
                yield;
            }
            // A fill's subpaths can cancel by winding, so boundary containment
            // alone cannot prove either visibility or a missing exterior part.
            if (part.options.interiorPaths?.length)
                return { status: 'uncertain', reason: 'Nonconvex filled containment needs a winding visibility witness' };
        }
        return { status: seen ? 'hit' : 'empty' };
    };
    let iterator: Generator<void, NonconvexContainmentResult> | undefined, cancelled = false, spent = 0, finished: NonconvexContainmentResult | undefined;
    const finish = (result: NonconvexContainmentResult): NonconvexContainmentResult => { finished = Object.freeze(result); return finished; };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid nonconvex containment slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Nonconvex containment cancelled' });
            if (finished) return finished;
            iterator ??= calculate();
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Nonconvex containment work limit exhausted' });
                    const next = iterator.next(); if (next.done) return finish(next.value);
                }
                return PENDING;
            } catch (error) { if (!(error instanceof RangeError)) throw error; return finish({ status: 'uncertain', reason: error.message }); }
        },
        cancel() { cancelled = true; iterator?.return({ status: 'uncertain', reason: 'Nonconvex containment cancelled' }); iterator = undefined; },
    };
}
