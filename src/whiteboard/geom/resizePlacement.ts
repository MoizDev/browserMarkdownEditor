import { pageOrigin, poseInParent } from '../change/coordinates';
import type { ChangeGeometry } from '../change/coordinates';
import type { Op } from '../change/ops';
import { childrenOf, hasOpaqueDescendant, isSheetParent } from '../model/doc';
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
            if (node.kind === 'frame') {
                let dx = pose.x - node.x, dy = pose.y - node.y;
                if (isSheetParent(services.doc, node.parent) && pose.page !== node.page) {
                    const before = pageOrigin(services.doc, node.page), after = pageOrigin(services.doc, pose.page);
                    dx += after.x - before.x; dy += after.y - before.y;
                }
                if (dx !== 0 || dy !== 0) {
                    if (hasOpaqueDescendant(services.doc, node.id)) throw new RangeError(`Cannot reposition opaque content in ${node.id}`);
                    const cos = Math.cos(node.rotation), sin = Math.sin(node.rotation);
                    const shiftX = cos * dx + sin * dy, shiftY = -sin * dx + cos * dy;
                    for (const child of childrenOf(services.doc, node.id)) {
                        if (shiftX !== 0) ops.push({ t: 'set', id: child.id, key: 'x', value: child.x - shiftX });
                        if (shiftY !== 0) ops.push({ t: 'set', id: child.id, key: 'y', value: child.y - shiftY });
                    }
                }
            }
            return ops;
        },
    };
}
