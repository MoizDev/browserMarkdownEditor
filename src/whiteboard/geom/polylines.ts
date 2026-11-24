import type { Point, PolylineNode } from '../model/nodes';
import type { PathOp, Vec2 } from './path';

function direction(a: Point, b: Point): Readonly<{ x: number; y: number; length: number }> {
    const x = b.x - a.x, y = b.y - a.y, length = Math.hypot(x, y);
    if (!Number.isFinite(length)) throw new RangeError('Polyline chord overflows');
    return length === 0 ? { x: 0, y: 0, length } : { x: x / length, y: y / length, length };
}
function tangent(points: readonly Point[], index: number): Vec2 {
    if (index === 0) {
        const d = direction(points[0], points[1]); return { x: d.x * d.length, y: d.y * d.length };
    }
    if (index === points.length - 1) {
        const d = direction(points[index - 1], points[index]); return { x: d.x * d.length, y: d.y * d.length };
    }
    const before = direction(points[index - 1], points[index]), after = direction(points[index], points[index + 1]);
    if (before.length === 0 || after.length === 0 || before.x * after.x + before.y * after.y <= -1 + 16 * Number.EPSILON) return { x: 0, y: 0 };
    const denominator = before.length + after.length;
    if (!Number.isFinite(denominator)) throw new RangeError('Polyline tangent overflows');
    const size = Math.min(before.length, after.length);
    const x = (before.x * (after.length / denominator) + after.x * (before.length / denominator)) * size;
    const y = (before.y * (after.length / denominator) + after.y * (before.length / denominator)) * size;
    return { x, y };
}

/** Geometry §9: ordered handles stay intact; duplicate points become explicit degenerate spans. */
export function polylinePath(node: Readonly<PolylineNode>): readonly PathOp[] {
    const { points, spline } = node;
    if (points.length < 2 || points.length > 5000 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        throw new RangeError('Invalid polyline handles');
    }
    const path: PathOp[] = [{ op: 'M', p: points[0] }];
    for (let i = 1; i < points.length; i++) {
        if (spline === 'line') path.push({ op: 'L', p: points[i] });
        else if (spline === 'cubic') {
            const a = points[i - 1], b = points[i], ta = tangent(points, i - 1), tb = tangent(points, i);
            path.push({ op: 'C', c1: { x: a.x + ta.x / 3, y: a.y + ta.y / 3 },
                c2: { x: b.x - tb.x / 3, y: b.y - tb.y / 3 }, p: b });
        } else throw new RangeError('Unsupported polyline spline');
    }
    return path;
}
