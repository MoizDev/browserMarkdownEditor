import { exactLineBetween, exactSide, sameExactPoint, type ExactPoint } from './homogeneous';
import { compareExactCoordinate, exactPointOnSegment, exactSegmentIntersection } from './exactSegments';
import { dyadicMultiply, dyadicSubtract, type Dyadic } from './numeric';

export interface ExactClippedInterval { readonly from: ExactPoint; readonly to: ExactPoint }
export type ExactSegmentClipResult = Readonly<{ status: 'pending' }> | Readonly<{
    status: 'done'; intervals: readonly ExactClippedInterval[]; points: readonly ExactPoint[];
}> | Readonly<{ status: 'uncertain'; reason: string }>;
const PENDING: ExactSegmentClipResult = Object.freeze({ status: 'pending' });
function plus(a: Dyadic, b: Dyadic): Dyadic { return dyadicSubtract(a, { n: -b.n, e: b.e }); }
function middle(a: ExactPoint, b: ExactPoint): ExactPoint {
    const w = dyadicMultiply(a.w, b.w);
    return { x: plus(dyadicMultiply(a.x, b.w), dyadicMultiply(b.x, a.w)),
        y: plus(dyadicMultiply(a.y, b.w), dyadicMultiply(b.y, a.w)), w: { n: w.n, e: w.e + 1 } };
}
interface Classification { readonly point: ExactPoint; edge: number; winding: number; boundary: boolean }

/** Closed segment clipped to a polygon using exact homogeneous intersections.
 * Each edge comparison, merge-sort move, and winding edge is a separate unit. */
export function createExactSegmentClipJob(start: ExactPoint, end: ExactPoint, polygon: readonly ExactPoint[], options: {
    readonly maxEdges?: number; readonly maxIntersections?: number; readonly maxWork?: number;
} = {}): { step(budget: { readonly deadline: number; readonly maxWork: number }): ExactSegmentClipResult; cancel(): void } {
    const maxEdges = options.maxEdges ?? 8192, maxIntersections = options.maxIntersections ?? 16386, maxWork = options.maxWork ?? 2000000;
    if (!Number.isSafeInteger(maxEdges) || maxEdges < 1 || !Number.isSafeInteger(maxIntersections) || maxIntersections < 2
        || !Number.isSafeInteger(maxWork) || maxWork < 1) throw new RangeError('Invalid exact segment clipping limits');
    let finished: ExactSegmentClipResult | undefined, cancelled = false, spent = 0;
    if (polygon.length > maxEdges) finished = { status: 'uncertain', reason: 'Exact segment clipping edge limit exhausted' };
    const axis = compareExactCoordinate(start, end, 'x') ? 'x' : 'y', direction = compareExactCoordinate(start, end, axis) <= 0 ? 1 : -1;
    const compare = (a: ExactPoint, b: ExactPoint) => direction * compareExactCoordinate(a, b, axis);
    let values: ExactPoint[] = [start, end], buffer: ExactPoint[] = [], ordered: ExactPoint[] = [], edge = 0;
    let phase: 'collect' | 'sort' | 'dedupe' | 'classify' = 'collect', width = 1, block = 0, left = 0, right = 0, middleIndex = 0, endIndex = 0, output = 0, dedupe = 0;
    let index = 0, classifyPoint = true, classification: Classification | undefined;
    const intervals: ExactClippedInterval[] = [], points: ExactPoint[] = [];
    const finish = (value: ExactSegmentClipResult): ExactSegmentClipResult => { finished = Object.freeze(value); return finished; };
    const append = (point: ExactPoint) => {
        if (values.length >= maxIntersections) throw new RangeError('Exact segment clipping intersection limit exhausted');
        values.push(point);
    };
    const startMerge = () => {
        middleIndex = Math.min(block + width, values.length); endIndex = Math.min(block + 2 * width, values.length);
        left = block; right = middleIndex; output = block;
    };
    const completedClassification = (inside: boolean) => {
        if (classifyPoint) {
            if (inside) points.push(ordered[index]);
            if (index + 1 < ordered.length) classifyPoint = false;
            else index++;
        } else {
            if (inside) intervals.push(Object.freeze({ from: ordered[index], to: ordered[index + 1] }));
            classifyPoint = true; index++;
        }
        classification = undefined;
    };
    return {
        step(budget) {
            if (!Number.isFinite(budget.deadline) || !Number.isSafeInteger(budget.maxWork) || budget.maxWork < 1) throw new RangeError('Invalid exact clip slice');
            if (cancelled) return finish({ status: 'uncertain', reason: 'Exact segment clipping cancelled' });
            if (finished) return finished;
            try {
                for (let work = 0; work < budget.maxWork && performance.now() < budget.deadline; work++) {
                    if (++spent > maxWork) return finish({ status: 'uncertain', reason: 'Exact segment clipping work limit exhausted' });
                    if (phase === 'collect') {
                        if (edge < polygon.length) {
                            const crossing = exactSegmentIntersection(start, end, polygon[edge], polygon[(edge + 1) % polygon.length]); edge++;
                            if (crossing.kind === 'point') append(crossing.point);
                            else if (crossing.kind === 'overlap') { append(crossing.from); append(crossing.to); }
                            continue;
                        }
                        buffer = new Array<ExactPoint>(values.length); phase = 'sort'; startMerge(); continue;
                    }
                    if (phase === 'sort') {
                        if (width >= values.length) { phase = 'dedupe'; continue; }
                        if (output < endIndex) {
                            buffer[output++] = left < middleIndex && (right >= endIndex || compare(values[left], values[right]) <= 0) ? values[left++] : values[right++]; continue;
                        }
                        block += width * 2;
                        if (block >= values.length) { [values, buffer] = [buffer, values]; width *= 2; block = 0; }
                        startMerge(); continue;
                    }
                    if (phase === 'dedupe') {
                        if (dedupe < values.length) {
                            const point = values[dedupe++]; if (!ordered.length || !sameExactPoint(point, ordered[ordered.length - 1])) ordered.push(point);
                            continue;
                        }
                        values = []; buffer = []; phase = 'classify'; continue;
                    }
                    if (index >= ordered.length) return finish({ status: 'done', intervals: Object.freeze(intervals), points: Object.freeze(points) });
                    if (!classification) classification = { point: classifyPoint ? ordered[index] : middle(ordered[index], ordered[index + 1]), edge: 0, winding: 0, boundary: false };
                    const state = classification;
                    if (state.edge >= polygon.length || state.boundary) { completedClassification(state.boundary || state.winding !== 0); continue; }
                    const a = polygon[state.edge], b = polygon[(state.edge + 1) % polygon.length]; state.edge++;
                    if (exactPointOnSegment(state.point, a, b)) { state.boundary = true; continue; }
                    if (sameExactPoint(a, b)) continue;
                    const ay = compareExactCoordinate(a, state.point, 'y'), by = compareExactCoordinate(b, state.point, 'y');
                    if ((ay <= 0 && by > 0) || (by <= 0 && ay > 0)) {
                        const side = exactSide(exactLineBetween(a, b), state.point);
                        if (ay <= 0 && by > 0 && side > 0) state.winding++;
                        else if (by <= 0 && ay > 0 && side < 0) state.winding--;
                    }
                }
                return PENDING;
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                return finish({ status: 'uncertain', reason: error.message });
            }
        },
        cancel() { cancelled = true; values = []; buffer = []; ordered = []; classification = undefined; },
    };
}
