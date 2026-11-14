import { poseInParent } from '../change/coordinates';
import type { ChangeGeometry } from '../change/coordinates';
import type { Op } from '../change/ops';
import type { ResizePlanServices, ResizeTargetSnapshot } from './resizePlan.types';
import type { ResizePlacementServices } from './resizePlacement.types';
import type { Vec2 } from './path';

export function resizePlacement(services: ResizePlacementServices): ResizePlanServices {
    return {
        kinds: services.kinds,
        capture: node => services.capture(node),
        isCurrent: () => services.isCurrent(),
        place(snapshot: ResizeTargetSnapshot, centre: Vec2, kindOps: readonly Op[]): readonly Op[] {
            const local = services.projectedLocalCentre(snapshot, kindOps), angle = snapshot.worldRotation;
            if (![local.x, local.y, centre.x, centre.y, angle].every(Number.isFinite)) throw new RangeError('Invalid resized placement');
            const c = Math.cos(angle), s = Math.sin(angle);
            const world = { x: centre.x - c * local.x + s * local.y, y: centre.y - s * local.x - c * local.y, rotation: angle };
            const geometry: ChangeGeometry = {
                resolvedTip: (doc, connector, terminal) => services.geometry.resolvedTip(doc, connector, terminal),
                worldBoundsCenter: () => centre,
            };
            const node = snapshot.node, pose = poseInParent(services.doc, node, node.parent, world, geometry), ops: Op[] = [];
            if (pose.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: pose.page });
            if (pose.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
            if (pose.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
            return ops;
        },
    };
}
