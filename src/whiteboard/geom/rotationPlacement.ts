import { poseInParent } from '../change/coordinates';
import type { ChangeGeometry } from '../change/coordinates';
import type { Op } from '../change/ops';
import type { RotationPlanServices } from './rotationPlan.types';
import type { RotationPlacementServices } from './rotationPlacement.types';

export function rotationPlacement(services: RotationPlacementServices): RotationPlanServices {
    return {
        capture: node => services.capture(node),
        isCurrent: () => services.isCurrent(),
        place(snapshot, centre, rotation): readonly Op[] {
            const local = services.localCentre(snapshot);
            if (![local.x, local.y, centre.x, centre.y, rotation].every(Number.isFinite)) throw new RangeError('Invalid rotated placement');
            const c = Math.cos(rotation), s = Math.sin(rotation);
            const world = { x: centre.x - c * local.x + s * local.y, y: centre.y - s * local.x - c * local.y, rotation };
            const geometry: ChangeGeometry = {
                resolvedTip: (doc, connector, terminal) => services.geometry.resolvedTip(doc, connector, terminal),
                worldBoundsCenter: () => centre,
            };
            const node = snapshot.node, pose = poseInParent(services.doc, node, node.parent, world, geometry), ops: Op[] = [];
            if (pose.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: pose.page });
            if (pose.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
            if (pose.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
            if (pose.rotation !== node.rotation) ops.push({ t: 'set', id: node.id, key: 'rotation', value: pose.rotation });
            return ops;
        },
    };
}
