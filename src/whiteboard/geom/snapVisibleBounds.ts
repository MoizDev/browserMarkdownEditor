import type { Rect } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { boardFrameAncestors } from './ancestorFrames';
import { createExactConvexIntersectionJob, type ExactConvexOperand } from './exactConvexIntersection';
import { compareExactCoordinate } from './exactSegments';
import { exactPointIntervals } from './homogeneous';
import { dyadic, dyadicSubtract, type Dyadic } from './numeric';
import { dyadicRatioInterval } from './dyadicRatio';
import type { Vec2 } from './path';

const ONE: Dyadic = Object.freeze({ n: 1n, e: 0 });
function exactly(value: Dyadic): number {
    const result = dyadicRatioInterval(value, ONE);
    if (!Number.isFinite(result.lo) || result.lo !== result.hi) throw new RangeError('Visible snap bound is not exactly representable');
    return result.lo;
}
function sum(a: number, b: number): number { const value = dyadic(b); return exactly(dyadicSubtract(dyadic(a), { n: -value.n, e: value.e })); }
function difference(a: number, b: number): number { return exactly(dyadicSubtract(dyadic(a), dyadic(b))); }
function rectangle(x0: number, y0: number, x1: number, y1: number): readonly Vec2[] {
    return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/** Exact visible logical AABB for unrotated rectangular semantics clipped by
 * convex ancestor frames. Other partial geometry is refused, never approximated. */
export async function prepareVisibleSnapBounds(doc: BoardDoc, id: NodeId, bounds: Readonly<Rect>, options: {
    readonly signal: AbortSignal; readonly current: () => boolean; readonly cooperate?: () => Promise<void>;
}): Promise<Rect | null> {
    const revision = doc.rev, host = doc.host, cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const check = () => { options.signal.throwIfAborted(); if (!options.current() || doc.rev !== revision || doc.host !== host) throw new DOMException('Visible snap bounds became stale', 'AbortError'); };
    check(); const node = doc.nodes.get(id); if (!node) throw new Error('Snap target disappeared');
    if (!['figure', 'text', 'sticky', 'clip', 'linkcard', 'embed', 'picture', 'frame'].includes(node.kind) || worldPose(doc, id).rotation !== 0)
        throw new Error('Frame-clipped snap target requires exact visible geometry');
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0)
        throw new RangeError('Visible snap rectangle is degenerate');
    const operands: ExactConvexOperand[] = [{ points: rectangle(bounds.x, bounds.y, sum(bounds.x, bounds.width), sum(bounds.y, bounds.height)) }];
    for (const frame of boardFrameAncestors(doc, node)) {
        const pose = worldPose(doc, frame.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        operands.push({ points: rectangle(0, 0, frame.w, frame.h), transform: [c, s, -s, c, pose.x, pose.y] });
    }
    const job = createExactConvexIntersectionJob(operands);
    try {
        for (;;) {
            check(); const result = job.step({ deadline: performance.now() + 3, maxWork: 128 });
            if (result.status === 'pending') { await cooperate(); continue; }
            if (result.status === 'empty') return null;
            if (result.status !== 'bounded') throw new Error(result.status === 'uncertain' ? result.reason : 'Visible snap intersection is degenerate');
            let minX = result.vertices[0], minY = minX, maxX = minX, maxY = minX;
            for (const point of result.vertices) {
                if (compareExactCoordinate(point, minX, 'x') < 0) minX = point;
                if (compareExactCoordinate(point, maxX, 'x') > 0) maxX = point;
                if (compareExactCoordinate(point, minY, 'y') < 0) minY = point;
                if (compareExactCoordinate(point, maxY, 'y') > 0) maxY = point;
            }
            const left = exactPointIntervals(minX).x, right = exactPointIntervals(maxX).x, top = exactPointIntervals(minY).y, bottom = exactPointIntervals(maxY).y;
            if ([left, right, top, bottom].some(value => !Number.isFinite(value.lo) || value.lo !== value.hi))
                throw new RangeError('Visible snap extrema are not exactly representable');
            check(); return { x: left.lo, y: top.lo, width: difference(right.lo, left.lo), height: difference(bottom.lo, top.lo) };
        }
    } finally { job.cancel(); }
}
