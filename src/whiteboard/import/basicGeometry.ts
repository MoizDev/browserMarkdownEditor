import type { Affine } from '../../platform/types';
import { cubicBounds, type Box } from '../geom/bounds';
import type { Vec2 } from '../geom/path';
import { polylineWorldSemanticBounds } from '../geom/providers';
import { curveClosure, curveParameters, writeCurveSpan } from '../ink/curve';
import type { SampleStore } from '../ink/samples';
import { realizeStrokePoints } from '../ink/width';
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
    const sequence = realizeStrokePoints(samples.sequence(node.samples), node.sx, node.sy);
    if (!sequence.count) throw new Error('Empty imported stroke');
    let box: Box | undefined, pressure = 0;
    for (let i = 0; i < sequence.count; i++) pressure = Math.max(pressure, sequence.pressure(i) ?? 0);
    if (sequence.count === 1) {
        const p = point(sequence.x(0), sequence.y(0), m);
        box = [p.x, p.y, p.x, p.y];
    } else {
        const data = new Float64Array(8), parameters = curveParameters(8, node.fairTol), closure = curveClosure(sequence, node.closed);
        for (let i = 0; i < sequence.count - 1; i++) {
            writeCurveSpan(sequence, i, parameters, data, 0, sequence.count, closure);
            const p = (j: number) => point(data[j], data[j + 1], m);
            box = union(box, cubicBounds({ p0: p(0), p1: p(2), p2: p(4), p3: p(6) }));
        }
    }
    const radius = node.widthModel.id === 'uniform' ? node.width / 2
        : node.widthModel.rMin + (node.widthModel.rMax - node.widthModel.rMin) * pressure;
    return expand(box!, radius);
}
export function basicLegacyGeometry(samples: SampleStore, remaining: LegacyGeometry): LegacyGeometry {
    let lastNode: Readonly<Node> | undefined, lastTransform: Affine | undefined, lastSupplied: Box | undefined;
    return { worldBounds(node: Readonly<Node>, transform: Affine): Box | undefined {
        const supplied = remaining.worldBounds(node, transform);
        lastNode = node; lastTransform = transform; lastSupplied = supplied;
        if (supplied !== undefined) return supplied;
        if (node.kind === 'stroke') return inkBounds(node, transform, samples);
        if (node.kind === 'polyline') {
            const r = polylineWorldSemanticBounds(node, transform);
            return [r.x, r.y, r.x + r.width, r.y + r.height];
        }
        return undefined;
    }, worldBoundsError(node: Readonly<Node>, transform: Affine): number {
        const supplied = node === lastNode && transform === lastTransform ? lastSupplied : remaining.worldBounds(node, transform);
        return supplied !== undefined ? remaining.worldBoundsError?.(node, transform) ?? 0 : 0;
    } };
}
