import type { Op } from '../change/ops';
import type { Node } from '../model/nodes';
import { flipPicture } from './crop';
import type { FlipServices } from './flip.types';
import type { Vec2 } from './path';

export function reflectNode(node: Readonly<Node>, centre: Vec2, axis: 'x' | 'y', services: FlipServices): readonly Op[] {
    if (node.kind === 'opaque' || node.locked || !services.isCurrent() || ![centre.x, centre.y].every(Number.isFinite)) throw new RangeError('Selection cannot be reflected');
    const snapshot = services.capture(node), horizontal = axis === 'x';
    let shape: readonly Op[];
    switch (node.kind) {
        case 'figure':
            shape = horizontal ? [{ t: 'set', id: node.id, key: 'flipX', value: !node.flipX }]
                : [{ t: 'set', id: node.id, key: 'flipY', value: !node.flipY }]; break;
        case 'picture': shape = flipPicture(node, axis); break;
        case 'stroke':
            shape = horizontal ? [{ t: 'set', id: node.id, key: 'sx', value: -node.sx }]
                : [{ t: 'set', id: node.id, key: 'sy', value: -node.sy }]; break;
        case 'polyline':
            shape = [{ t: 'set', id: node.id, key: 'points', value: node.points.map(point => ({ x: horizontal ? -point.x : point.x, y: horizontal ? point.y : -point.y })) }]; break;
        case 'connector': shape = services.reflectConnector(node, axis); break;
        case 'group': case 'frame': shape = services.reflectContainer(node, axis); break;
        case 'text': case 'sticky': shape = services.reflectReadable(node, axis); break;
        case 'clip': case 'linkcard': case 'embed': shape = services.reflectMedia(node, axis); break;
    }
    const old = snapshot.centreWorld;
    const target = { x: horizontal ? 2 * centre.x - old.x : old.x, y: horizontal ? old.y : 2 * centre.y - old.y };
    if (![target.x, target.y].every(Number.isFinite)) throw new RangeError('Reflected geometry overflows');
    return [...shape, ...services.place(snapshot, target, -snapshot.rotationWorld, shape)];
}
