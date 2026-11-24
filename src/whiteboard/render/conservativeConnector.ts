import type { Affine } from '../../platform/types';
import { worldPose } from '../change/coordinates';
import { inverse, transformPoint } from '../geom/affine';
import { arcBounds, transformBox } from '../geom/bounds';
import { elbowLeg } from '../geom/elbow';
import { connectorBody } from '../geom/connectors';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { ConnectorNode, Node } from '../model/nodes';
import type { LocalGeometryBounds, Box } from '../scene/bounds';
import type { BoardTextGeometry } from './textGeometry';
import { prepareBoardVectorGeometryNow } from './vectorGeometry';

function matrix(doc: BoardDoc, id: NodeId): Affine {
    const p = worldPose(doc, id), c = Math.cos(p.rotation), s = Math.sin(p.rotation);
    return [c, s, -s, c, p.x, p.y];
}
/** Cold native-record hint only, never exact Scene/pick/page-placement geometry.
 * The untrimmed path encloses every terminal-connected trim; head/gap and label
 * envelopes are added before the captured world-to-local projection. */
export function conservativeConnectorBounds(node: ConnectorNode, doc: BoardDoc, text: BoardTextGeometry,
    attachBox?: (target: Readonly<Node>) => Box | undefined): LocalGeometryBounds | undefined {
    const world = matrix(doc, node.id), local = inverse(world, 1e12);
    if (!local) return undefined;
    const boxes: Box[] = [];
    // The half-diagonal of a target box whose precise anchor is not known: every point of the box lies within it.
    let approximate = 0;
    const aim = (end: typeof node.start) => {
        if (!end.attach) return transformPoint(world, end);
        const target = doc.nodes.get(end.attach.target);
        if (!target || target.kind === 'opaque' || target.kind === 'connector') return null;
        if (target.kind === 'stroke' || target.kind === 'polyline' || target.kind === 'group') {
            // No vector anchor exists for these: the attach rule's midpoint is the point, and a precise anchor
            // is only known to lie somewhere in the box, so the envelope is widened to cover it.
            const box = attachBox?.(target);
            if (!box) return null;
            boxes.push(box);
            if (end.attach.precise || end.attach.exact) approximate = Math.max(approximate, Math.hypot(box[2] - box[0], box[3] - box[1]) / 2);
            return { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 };
        }
        const geometry = prepareBoardVectorGeometryNow(target, { text, revision: `hint:${target.id}`, zoom: 1 });
        const box = geometry.attachments?.logicalBox;
        if (!box) return null;
        const m = matrix(doc, target.id), data = new Float64Array(4);
        transformBox(data, 0, [box.x, box.y, box.x + box.width, box.y + box.height], 0, m);
        boxes.push([data[0], data[1], data[2], data[3]]);
        return transformPoint(m, { x: box.x + box.width * (end.attach.precise || end.attach.exact ? end.attach.anchor.x : .5),
            y: box.y + box.height * (end.attach.precise || end.attach.exact ? end.attach.anchor.y : .5) });
    };
    const a = aim(node.start), b = aim(node.end);
    if (!a || !b) return undefined;
    const body = connectorBody(a, b, node.bend, .01);
    let bounds: Box = body.kind === 'arc' ? arcBounds(body.arc)
        : [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
    if (node.route === 'elbow') {
        for (const box of boxes) bounds = [Math.min(bounds[0], box[0]), Math.min(bounds[1], box[1]), Math.max(bounds[2], box[2]), Math.max(bounds[3], box[3])];
        // The route's perpendicular legs reach elbowLeg past an edge end, so the envelope covers them too.
        const escape = Math.max(12, node.width * 6, elbowLeg(node.width));
        bounds = [bounds[0] - escape, bounds[1] - escape, bounds[2] + escape, bounds[3] + escape];
    }
    let xPad = node.width * 6 + approximate, yPad = xPad;
    if (node.label) {
        const length = body.length + (node.route === 'elbow' ? 2 * ((bounds[2] - bounds[0]) + (bounds[3] - bounds[1])) : 0);
        const label = text.prepareNow(node, { revision: `hint:${node.id}`, connectorLength: length, anchor: a });
        if (label) { xPad += label.paint.box.w / 2 + 4; yPad += label.paint.box.h / 2 + 4; }
    }
    const padded = [bounds[0] - xPad, bounds[1] - yPad, bounds[2] + xPad, bounds[3] + yPad], result = new Float64Array(4);
    transformBox(result, 0, padded, 0, local);
    return { ink: [result[0], result[1], result[2], result[3]] };
}
