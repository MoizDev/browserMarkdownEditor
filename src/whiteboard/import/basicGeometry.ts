import type { Affine } from '../../platform/types';
import { cubicBounds, type Box } from '../geom/bounds';
import type { Vec2 } from '../geom/path';
import { curveParameters, writeCurveSpan } from '../ink/curve';
import type { SampleStore } from '../ink/samples';
import type { Node, StrokeNode } from '../model/nodes';
import type { LegacyGeometry } from './worldBounds';

function point(x: number, y: number, m: Affine): Vec2 {
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}
function union(a: Box | undefined, b: Box): Box {
    return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}
function expand(box: Box, radius: number): Box {
    return [box[0] - radius, box[1] - radius, box[2] + radius, box[3] + radius];
}
function inkBounds(node: StrokeNode, m: Affine, samples: SampleStore): Box {
    const sequence = samples.sequence(node.samples);
    if (!sequence.count) throw new Error('Empty imported stroke');
    let box: Box | undefined, pressure = 0;
    for (let i = 0; i < sequence.count; i++) pressure = Math.max(pressure, sequence.pressure(i) ?? 0);
    if (sequence.count === 1) {
        const p = point(sequence.x(0) * node.sx, sequence.y(0) * node.sy, m);
        box = [p.x, p.y, p.x, p.y];
    } else {
        const data = new Float64Array(8), parameters = curveParameters(8, node.fairTol);
        for (let i = 0; i < sequence.count - 1; i++) {
            writeCurveSpan(sequence, i, parameters, data);
            const p = (j: number) => point(data[j] * node.sx, data[j + 1] * node.sy, m);
            box = union(box, cubicBounds({ p0: p(0), p1: p(2), p2: p(4), p3: p(6) }));
        }
    }
    const radius = node.widthModel.id === 'uniform' ? node.width / 2
        : node.widthModel.rMin + (node.widthModel.rMax - node.widthModel.rMin) * pressure;
    return expand(box!, radius);
}
function lineBounds(node: Extract<Node, { kind: 'polyline' }>, m: Affine): Box {
    let box: Box | undefined;
    for (const p of node.points) {
        const q = point(p.x, p.y, m);
        box = union(box, [q.x, q.y, q.x, q.y]);
    }
    if (!box) throw new Error('Empty imported line');
    return expand(box, node.width / 2);
}

// Connectors and cubic polylines use their owning geometry provider, never a straight-line fallback.
export function basicLegacyGeometry(samples: SampleStore, remaining: LegacyGeometry): LegacyGeometry {
    return { worldBounds(node: Readonly<Node>, transform: Affine): Box | undefined {
        if (node.kind === 'stroke') return inkBounds(node, transform, samples);
        if (node.kind === 'polyline' && node.spline === 'line') return lineBounds(node, transform);
        return remaining.worldBounds(node, transform);
    } };
}
