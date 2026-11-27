import type { BoardGeometryScope } from '../commands/geometryScope';
import type { NodeId } from '../model/ids';
import { inverse } from './affine';
import type { Vec2 } from './path';
import { commonResizeRotation } from './transforms';

export async function rotationCentre(scope: BoardGeometryScope, ids: readonly NodeId[]): Promise<Vec2> {
    if (!ids.length) throw new RangeError('Rotation centre needs a member');
    const common = commonResizeRotation(ids.map(id => scope.worldPose(id).rotation));
    if (common !== null) {
        const c = Math.cos(common), s = Math.sin(common), target = inverse([c, s, -s, c, 0, 0], 1e12);
        if (!target) throw new Error('Selection frame is not invertible');
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const id of ids) {
            const b = await scope.boundsInSpace(id, target);
            x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
        }
        const u = (x0 + x1) / 2, v = (y0 + y1) / 2;
        return { x: c * u - s * v, y: s * u + c * v };
    }
    let x = 0, y = 0;
    for (const id of ids) {
        const local = scope.localBounds(id), pose = scope.worldPose(id);
        const lx = (local[0] + local[2]) / 2, ly = (local[1] + local[3]) / 2, c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        x += pose.x + c * lx - s * ly; y += pose.y + s * lx + c * ly;
    }
    return { x: x / ids.length, y: y / ids.length };
}
