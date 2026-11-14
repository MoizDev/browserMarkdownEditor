import { splitCubic } from './flatten';
import { nextDown, nextUp } from './numeric';
import type { Cubic, Vec2 } from './path';

export interface LengthSpan {
    readonly t0: number; readonly t1: number;
    readonly lower: number; readonly upper: number;
    readonly curve: Cubic;
}
interface WorkSpan extends LengthSpan { readonly depth: number; readonly roundoff: number }
function distance(a: Vec2, b: Vec2): number { return Math.hypot(b.x - a.x, b.y - a.y); }
function span(curve: Cubic, t0: number, t1: number, depth: number, inherited: number): WorkSpan {
    const points = [curve.p0, curve.p1, curve.p2, curve.p3];
    if (!points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) throw new RangeError('Non-finite cubic');
    const identical = points.every(p => p.x === curve.p0.x && p.y === curve.p0.y);
    const magnitude = Math.max(1, ...points.flatMap(p => [Math.abs(p.x), Math.abs(p.y)]));
    const roundoff = inherited + (identical ? 0 : 64 * Number.EPSILON * magnitude);
    const chord = distance(curve.p0, curve.p3);
    const polygon = distance(curve.p0, curve.p1) + distance(curve.p1, curve.p2) + distance(curve.p2, curve.p3);
    const lower = Math.max(0, nextDown(chord - 4 * roundoff));
    const upper = nextUp(polygon + 16 * roundoff);
    if (!Number.isFinite(upper)) throw new RangeError('Curve length overflows');
    return { curve, t0, t1, lower, upper, depth, roundoff };
}
// Greatest-uncertainty refinement; a binary heap keeps long paths out of quadratic scans.
export function cubicLengthTable(curve: Cubic, error: number, maxSpan = Infinity): readonly LengthSpan[] {
    if (!(error > 0) || !Number.isFinite(error) || !(maxSpan > 0)) throw new RangeError('Invalid length budget');
    const heap: WorkSpan[] = [];
    const priority = (s: WorkSpan) => Math.max((s.upper - s.lower) / error, s.upper / maxSpan);
    const push = (s: WorkSpan) => {
        let i = heap.length; heap.push(s);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (priority(heap[parent]) >= priority(s)) break;
            heap[i] = heap[parent]; i = parent;
        }
        heap[i] = s;
    };
    const pop = (): WorkSpan => {
        const first = heap[0], last = heap.pop()!;
        if (heap.length) {
            let i = 0;
            while (2 * i + 1 < heap.length) {
                let child = 2 * i + 1;
                if (child + 1 < heap.length && priority(heap[child + 1]) > priority(heap[child])) child++;
                if (priority(last) >= priority(heap[child])) break;
                heap[i] = heap[child]; i = child;
            }
            heap[i] = last;
        }
        return first;
    };
    const initial = span(curve, 0, 1, 0, 0);
    push(initial);
    let uncertainty = nextUp(initial.upper - initial.lower);
    for (;;) {
        // Every leaf's span and gap are bounded once the maximum heap priority is <= 1.
        if (uncertainty <= error && priority(heap[0]) <= 1) break;
        const old = pop(), t = (old.t0 + old.t1) / 2;
        if (old.depth >= 32 || t === old.t0 || t === old.t1 || heap.length >= 262143) throw new RangeError('Length refinement cannot certify this budget');
        const [a, b] = splitCubic(old.curve);
        const left = span(a, old.t0, t, old.depth + 1, old.roundoff), right = span(b, t, old.t1, old.depth + 1, old.roundoff);
        uncertainty = nextUp(Math.max(0, uncertainty - (old.upper - old.lower)) + (left.upper - left.lower) + (right.upper - right.lower));
        push(left); push(right);
    }
    return heap.sort((a, b) => a.t0 - b.t0);
}
export interface LengthBreakpoint { readonly t: number; readonly lower: number; readonly upper: number }
export function cumulativeLengthTable(spans: readonly LengthSpan[]): readonly LengthBreakpoint[] {
    const result: LengthBreakpoint[] = [{ t: 0, lower: 0, upper: 0 }];
    let lower = 0, upper = 0;
    for (const s of spans) {
        lower = Math.max(0, nextDown(lower + s.lower));
        upper = nextUp(upper + s.upper);
        result.push({ t: s.t1, lower, upper });
    }
    return result;
}
export interface LengthParameter { readonly lower: number; readonly upper: number }
export function invertCubicLength(curve: Cubic, target: number, error: number): LengthParameter {
    if (!Number.isFinite(target) || target < 0 || !(error > 0) || !Number.isFinite(error)) throw new RangeError('Invalid length query');
    if (target === 0) return { lower: 0, upper: 0 };
    let budget = error / 4;
    for (;;) {
        const table = cubicLengthTable(curve, budget, error / 4);
        let lowerLength = 0, upperLength = 0, first = -1, last = -1;
        for (let i = 0; i < table.length; i++) {
            const s = table[i];
            if (lowerLength <= target && nextUp(upperLength + s.upper) >= target) {
                if (first < 0) first = i;
                last = i;
            }
            lowerLength = Math.max(0, nextDown(lowerLength + s.lower));
            upperLength = nextUp(upperLength + s.upper);
        }
        if (target >= upperLength) return { lower: 1, upper: 1 };
        if (first >= 0) {
            let extent = 0;
            for (let i = first; i <= last; i++) extent = nextUp(extent + table[i].upper);
            if (extent <= error) return { lower: table[first].t0, upper: table[last].t1 };
        }
        const next = budget / 2;
        if (next === 0 || next === budget) throw new RangeError('Length inversion cannot be refined at this precision');
        budget = next;
    }
}
export function cubicPoint(c: Cubic, t: number): Vec2 {
    const u = 1 - t;
    return { x: u ** 3 * c.p0.x + 3 * u * u * t * c.p1.x + 3 * u * t * t * c.p2.x + t ** 3 * c.p3.x,
        y: u ** 3 * c.p0.y + 3 * u * u * t * c.p1.y + 3 * u * t * t * c.p2.y + t ** 3 * c.p3.y };
}
