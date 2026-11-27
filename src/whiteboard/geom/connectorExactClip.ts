import { exactAffinePoint } from './exactAffine';
import { exactPoint, sameExactPoint, type ExactPoint } from './homogeneous';
import { createExactSegmentClipJob, type ExactClippedInterval } from './exactSegmentClipJob';
import { dyadicRatioInterval } from './dyadicRatio';
import { dyadic, dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';
import type { Affine } from '../../platform/types';
import type { PathOp, Vec2 } from './path';

export interface ExactConnectorContour { readonly outline: readonly PathOp[]; readonly localToWorld: Affine }
export function* areSimpleConnectorPolygons(contours: readonly ExactConnectorContour[]): Generator<void, boolean> {
    for (const { outline } of contours) {
        if (outline.length < 4 || outline[0].op !== 'M' || outline[outline.length - 1].op !== 'Z') return false;
        for (let i = 1; i + 1 < outline.length; i++) { if (outline[i].op !== 'L') return false; yield; }
    }
    return true;
}
export interface ExactConnectorCrossing { readonly distance: number; readonly entering: boolean }
function opposite(value: Dyadic): Dyadic { return { n: -value.n, e: value.e }; }
function parameter(point: ExactPoint, start: Vec2, end: Vec2): { readonly lo: number; readonly hi: number } {
    const axis = start.x !== end.x ? 'x' : 'y', origin = dyadic(start[axis]);
    const numerator = dyadicSubtract(point[axis], dyadicMultiply(origin, point.w));
    let denominator = dyadicMultiply(dyadicSubtract(dyadic(end[axis]), origin), point.w), n = numerator;
    if (!denominator.n) throw new RangeError('Degenerate connector parameter');
    if (denominator.n < 0n) { denominator = opposite(denominator); n = opposite(n); }
    return dyadicRatioInterval(n, denominator);
}
function distance(point: ExactPoint, start: Vec2, end: Vec2, length: number, error: number): number {
    const t = parameter(point, start, end);
    if (!Number.isFinite(t.lo) || !Number.isFinite(t.hi) || t.lo > t.hi || t.lo < 0 || t.hi > 1
        || (t.hi - t.lo) * length > error) throw new RangeError('Connector crossing parameter cannot be certified');
    const result = (t.lo / 2 + t.hi / 2) * length;
    if (!Number.isFinite(result)) throw new RangeError('Connector crossing distance overflows');
    return result;
}

export function* exactConnectorLineCrossings(start: Vec2, end: Vec2, length: number, contours: readonly ExactConnectorContour[],
    error: number, maxPieces: number): Generator<void, readonly ExactConnectorCrossing[]> {
    if (![start.x, start.y, end.x, end.y, length, error].every(Number.isFinite) || length <= 0 || error <= 0
        || !Number.isSafeInteger(maxPieces) || maxPieces < 1 || contours.length > 65) throw new RangeError('Invalid exact connector clipping');
    const first = exactPoint(start), last = exactPoint(end);
    if (sameExactPoint(first, last)) throw new RangeError('Nonzero connector has coincident ends');
    let intervals: readonly ExactClippedInterval[] = [{ from: first, to: last }];
    for (const contour of contours) {
        if (contour.outline.length > maxPieces) throw new RangeError('Connector contour budget exhausted');
        if (!(yield* areSimpleConnectorPolygons([contour]))) throw new RangeError('Unsupported exact connector contour');
        const polygon: ExactPoint[] = [];
        for (const op of contour.outline) { if (op.op === 'M' || op.op === 'L') polygon.push(exactAffinePoint(contour.localToWorld, op.p)); yield; }
        const next: ExactClippedInterval[] = [];
        for (const source of intervals) {
            const job = createExactSegmentClipJob(source.from, source.to, polygon, { maxEdges: maxPieces, maxIntersections: Math.max(2, 2 * maxPieces + 2) });
            try {
                for (;;) {
                    const result = job.step({ deadline: performance.now() + 3, maxWork: 1 });
                    if (result.status === 'pending') { yield; continue; }
                    if (result.status === 'uncertain') throw new RangeError(result.reason);
                    for (const interval of result.intervals) {
                        if (sameExactPoint(interval.from, interval.to)) continue;
                        const previous = next[next.length - 1];
                        if (previous && sameExactPoint(previous.to, interval.from)) next[next.length - 1] = { from: previous.from, to: interval.to };
                        else { if (next.length >= maxPieces) throw new RangeError('Connector contour interval budget exhausted'); next.push(interval); }
                        yield;
                    }
                    break;
                }
            } finally { job.cancel(); }
        }
        intervals = next;
        if (!intervals.length) return Object.freeze([]);
    }
    const crossings: ExactConnectorCrossing[] = [];
    for (const interval of intervals) {
        const from = distance(interval.from, start, end, length, error), to = distance(interval.to, start, end, length, error);
        if (!(from < to)) throw new RangeError('Connector interior interval is below representable precision');
        if (!sameExactPoint(interval.from, first)) {
            if (from <= 0 || from >= length) throw new RangeError('Connector entry is below representable precision');
            if (crossings.length >= maxPieces) throw new RangeError('Connector crossing budget exhausted');
            crossings.push(Object.freeze({ distance: from, entering: true }));
        }
        if (!sameExactPoint(interval.to, last)) {
            if (to <= 0 || to >= length) throw new RangeError('Connector exit is below representable precision');
            if (crossings.length >= maxPieces) throw new RangeError('Connector crossing budget exhausted');
            crossings.push(Object.freeze({ distance: to, entering: false }));
        }
        yield;
    }
    return Object.freeze(crossings);
}
