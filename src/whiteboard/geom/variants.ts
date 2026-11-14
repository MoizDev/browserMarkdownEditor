import { splitCubicAt } from './flatten';
import { cubicLengthTable, invertCubicLength } from './metrics';
import type { Cubic, PathOp, Vec2 } from './path';

// geometry.md §3.1: node identity and segment identity, never revision or camera, seed draw variation.
function hash(text: string): number {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15; value = Math.imul(value, 0x846ca68b);
    return (value ^ value >>> 16) >>> 0;
}

export interface DrawVariant {
    readonly nodeId: string;
    readonly kernelVersion: number;
    readonly width: number;
    readonly referenceWidth: number;
    readonly boxWidth: number;
    readonly boxHeight: number;
}

export interface DashInterval { readonly from: number; readonly to: number; readonly painted: boolean }

/** A cursor carries world-space phase between independently leased path chunks. */
export class DashWalker {
    private readonly lengths: readonly number[];
    private index = 0;
    private remaining: number;
    constructor(lengths: readonly number[], phase = 0) {
        if (!lengths.length || lengths.length % 2 || lengths.some(n => !Number.isFinite(n) || n <= 0) || !Number.isFinite(phase)) {
            throw new RangeError('Invalid dash pattern');
        }
        this.lengths = [...lengths];
        const period = this.lengths.reduce((a, b) => a + b, 0);
        if (!Number.isFinite(period) || period <= 0) throw new RangeError('Invalid dash period');
        let offset = ((phase % period) + period) % period;
        while (this.index < this.lengths.length - 1 && offset >= this.lengths[this.index]) offset -= this.lengths[this.index++];
        this.remaining = this.lengths[this.index] - offset;
    }
    *consume(length: number): Generator<DashInterval> {
        if (!Number.isFinite(length) || length < 0) throw new RangeError('Invalid path length');
        let from = 0;
        while (from < length) {
            const step = Math.min(this.remaining, length - from);
            const to = from + step;
            if (!(to > from)) throw new RangeError('Dash step is below numeric resolution');
            const interval = { from, to, painted: this.index % 2 === 0 };
            from = to;
            this.remaining -= step;
            if (this.remaining <= 0) {
                this.index = (this.index + 1) % this.lengths.length;
                this.remaining = this.lengths[this.index];
            }
            yield interval;
        }
    }
}

/** Bounded-memory realization of a straight semantic segment. */
export function* drawSegment(start: Vec2, end: Vec2, segment: number, style: DrawVariant): Generator<PathOp> {
    const { width, referenceWidth, boxWidth, boxHeight } = style;
    if (![start.x, start.y, end.x, end.y, width, referenceWidth, boxWidth, boxHeight].every(Number.isFinite)
        || width < 0 || referenceWidth <= 0 || boxWidth < 0 || boxHeight < 0) throw new RangeError('Invalid draw geometry');
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy), u = width / referenceWidth;
    if (length === 0 || u === 0) { yield { op: 'L', p: end }; return; }
    const amplitude = Math.min(.35 * u, .01 * Math.min(boxWidth, boxHeight));
    const count = Math.max(1, Math.ceil(length / (24 * u)));
    if (!Number.isSafeInteger(count)) throw new RangeError('Draw geometry exceeds representable segment count');
    const nx = -dy / length, ny = dx / length;
    const at = (i: number): Vec2 => {
        const t = i / count;
        const offset = i === 0 || i === count ? 0 : amplitude * (hash(`${style.nodeId}:${style.kernelVersion}:${segment}:${i}`) / 0xffffffff * 2 - 1);
        return { x: start.x + dx * t + nx * offset, y: start.y + dy * t + ny * offset };
    };
    let a = start;
    for (let i = 1; i <= count; i++) {
        const b = at(i), tx = dx / count / 3, ty = dy / count / 3;
        yield { op: 'C', c1: { x: a.x + tx, y: a.y + ty }, c2: { x: b.x - tx, y: b.y - ty }, p: b };
        a = b;
    }
}

function tangent(curve: Cubic, t: number): Vec2 {
    const u = 1 - t;
    return { x: 3 * (u * u * (curve.p1.x - curve.p0.x) + 2 * u * t * (curve.p2.x - curve.p1.x) + t * t * (curve.p3.x - curve.p2.x)),
        y: 3 * (u * u * (curve.p1.y - curve.p0.y) + 2 * u * t * (curve.p2.y - curve.p1.y) + t * t * (curve.p3.y - curve.p2.y)) };
}
function add(p: Vec2, offset: Vec2): Vec2 { return { x: p.x + offset.x, y: p.y + offset.y }; }

/** Realize curves by offsetting exact cubic slices; consumers share the yielded path. */
export function* drawCubic(curve: Cubic, segment: number, style: DrawVariant, lengthError: number,
    maxPieces: number): Generator<PathOp> {
    const { width, referenceWidth, boxWidth, boxHeight } = style;
    if (![width, referenceWidth, boxWidth, boxHeight, lengthError].every(Number.isFinite) || width < 0 || referenceWidth <= 0
        || boxWidth < 0 || boxHeight < 0 || lengthError <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) {
        throw new RangeError('Invalid draw curve budget');
    }
    if ([curve.p0, curve.p1, curve.p2, curve.p3].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new RangeError('Invalid draw curve');
    const u = width / referenceWidth;
    if (!Number.isFinite(u)) throw new RangeError('Draw scale overflows');
    if (u === 0) { yield { op: 'C', c1: curve.p1, c2: curve.p2, p: curve.p3 }; return; }
    const spans = cubicLengthTable(curve, lengthError);
    let lower = 0, upper = 0;
    for (const span of spans) { lower += span.lower; upper += span.upper; }
    const length = lower + (upper - lower) / 2;
    if (!Number.isFinite(length)) throw new RangeError('Draw curve length overflows');
    const count = Math.max(1, Math.ceil(length / (24 * u)));
    if (!Number.isSafeInteger(count) || count > maxPieces) throw new RangeError('Draw curve budget exhausted');
    const amplitude = Math.min(.35 * u, .01 * Math.min(boxWidth, boxHeight));
    const offset = (t: number, i: number): Vec2 => {
        if (i === 0 || i === count) return { x: 0, y: 0 };
        let d = tangent(curve, t), n = Math.hypot(d.x, d.y);
        if (n === 0) { d = { x: curve.p3.x - curve.p0.x, y: curve.p3.y - curve.p0.y }; n = Math.hypot(d.x, d.y); }
        if (!Number.isFinite(n)) throw new RangeError('Draw tangent overflows');
        if (n === 0) return { x: 0, y: 0 };
        const amount = amplitude * (hash(`${style.nodeId}:${style.kernelVersion}:${segment}:${i}`) / 0xffffffff * 2 - 1);
        return { x: -d.y / n * amount, y: d.x / n * amount };
    };
    let t0 = 0, delta0: Vec2 = { x: 0, y: 0 };
    for (let i = 1; i <= count; i++) {
        const bracket = i === count ? { lower: 1, upper: 1 } : invertCubicLength(curve, length * i / count, lengthError);
        const t1 = Math.max(t0, (bracket.lower + bracket.upper) / 2), delta1 = offset(t1, i);
        const prefix = splitCubicAt(curve, t1)[0];
        const slice = t1 === 0 ? prefix : splitCubicAt(prefix, t0 / t1)[1];
        yield { op: 'C', c1: add(slice.p1, delta0), c2: add(slice.p2, delta1), p: add(slice.p3, delta1) };
        t0 = t1; delta0 = delta1;
    }
}

/** Emit one deterministic path; a budget failure must discard the unpublished partial result. */
export function* drawPath(ops: readonly PathOp[], style: DrawVariant, lengthError: number,
    maxPieces: number): Generator<PathOp> {
    if (!Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid draw path budget');
    let start: Vec2 | undefined, current: Vec2 | undefined, segment = 0, emitted = 0;
    for (const op of ops) {
        if (op.op === 'M') {
            if (!Number.isFinite(op.p.x) || !Number.isFinite(op.p.y)) throw new RangeError('Invalid draw path');
            start = current = op.p; yield op; continue;
        }
        if (!start || !current) throw new RangeError('Draw path must start with M');
        if (op.op === 'Z') {
            if (current.x !== start.x || current.y !== start.y) {
                for (const piece of drawSegment(current, start, segment++, style)) {
                    if (++emitted > maxPieces) throw new RangeError('Draw path budget exhausted');
                    yield piece;
                }
            }
            current = start; yield op; continue;
        }
        const pieces = op.op === 'C'
            ? drawCubic({ p0: current, p1: op.c1, p2: op.c2, p3: op.p }, segment++, style, lengthError, Math.max(1, maxPieces - emitted))
            : drawSegment(current, op.p, segment++, style);
        for (const piece of pieces) {
            if (++emitted > maxPieces) throw new RangeError('Draw path budget exhausted');
            yield piece;
        }
        current = op.p;
    }
}
