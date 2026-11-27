import type { Affine, Rect } from '../../platform/types';
import { exactAffinePoint } from './exactAffine';
import { exactLineBetween, exactPoint, exactSide } from './homogeneous';
import type { Vec2 } from './path';

export function pointInTransformedFrame(point: Vec2, box: Rect, localToWorld: Affine): boolean {
    if (![point.x, point.y, box.x, box.y, box.width, box.height, ...localToWorld].every(Number.isFinite)
        || box.width <= 0 || box.height <= 0 || !Number.isFinite(box.x + box.width) || !Number.isFinite(box.y + box.height))
        throw new RangeError('Invalid transformed frame');
    const corners = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }]
        .map(value => exactAffinePoint(localToWorld, value));
    const orientation = exactSide(exactLineBetween(corners[0], corners[1]), corners[2]);
    if (!orientation) throw new RangeError('Frame transform is singular');
    const query = exactPoint(point);
    for (let i = 0; i < corners.length; i++) {
        const side = exactSide(exactLineBetween(corners[i], corners[(i + 1) % corners.length]), query);
        if (side && side !== orientation) return false;
    }
    return true;
}
