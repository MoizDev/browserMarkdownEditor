import type { Node, ConnectorEnd, Point } from '../model/nodes';

function point(p: Point, scale: number): Point { return { x: p.x * scale, y: p.y * scale }; }
function end(p: ConnectorEnd, scale: number): ConnectorEnd { return { ...point(p, scale), attach: p.attach }; }

// C2.3: uniformly transform the entire root subtree into the PDF display-box coordinates.
export function scaleImportedNode(node: Node, scale: number): Node {
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid legacy page scale');
    const base = { ...node, x: node.x * scale, y: node.y * scale };
    switch (base.kind) {
        case 'stroke': return { ...base, sx: base.sx * scale, sy: base.sy * scale, width: base.width * scale,
            widthModel: base.widthModel.id === 'uniform' ? base.widthModel : { ...base.widthModel,
                rMin: base.widthModel.rMin * scale, rMax: base.widthModel.rMax * scale } };
        case 'figure': return { ...base, w: base.w * scale, h: base.h * scale, growY: base.growY * scale,
            width: base.width * scale, labelScale: base.labelScale * scale };
        case 'text': return { ...base, scale: base.scale * scale };
        case 'sticky': return { ...base, scale: base.scale * scale };
        case 'connector': return { ...base, start: end(base.start, scale), end: end(base.end, scale),
            bend: base.bend * scale, width: base.width * scale, labelScale: base.labelScale * scale };
        case 'polyline': return { ...base, points: base.points.map(p => point(p, scale)), width: base.width * scale };
        case 'frame': case 'picture': case 'clip': case 'linkcard': case 'embed':
            return { ...base, w: base.w * scale, h: base.h * scale };
        case 'group': return base;
        case 'opaque': throw new Error('Unknown node cannot be scaled safely');
    }
}
