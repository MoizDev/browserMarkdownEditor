import type { PathOp, Vec2 } from './path';

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
