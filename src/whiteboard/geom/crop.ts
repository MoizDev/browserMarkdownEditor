import type { Op } from '../change/ops';
import type { Crop, PictureNode } from '../model/nodes';
import type { ResizeHandle } from './transforms';
import type { Vec2 } from './path';

const FULL_CROP: Crop = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1, circle: false });
function clamp(value: number, low: number, high: number): number { return Math.min(high, Math.max(low, value)); }

// Delta is measured in the picture's displayed local axes, from the start snapshot.
export function cropPicture(node: Readonly<PictureNode>, handle: ResizeHandle, delta: Vec2): readonly Op[] {
    if (node.locked || ![node.x, node.y, node.w, node.h, node.rotation, delta.x, delta.y].every(Number.isFinite)
        || node.w < 1 || node.h < 1 || (!handle.x && !handle.y)) throw new RangeError('Invalid picture crop');
    const source = node.crop ?? FULL_CROP, sx = source.x1 - source.x0, sy = source.y1 - source.y0;
    if (!(sx > 0) || !(sy > 0)) throw new RangeError('Invalid source crop');
    let x0 = source.x0, y0 = source.y0, x1 = source.x1, y1 = source.y1;
    let left = 0, top = 0, width = node.w, height = node.h;
    if (handle.x < 0) { left = clamp(delta.x, Math.max(-source.x0 * node.w / sx, node.w - 1_000_000), node.w - 1); width -= left; x0 += left / node.w * sx; }
    if (handle.x > 0) { const right = clamp(delta.x, 1 - node.w, Math.min((1 - source.x1) * node.w / sx, 1_000_000 - node.w)); width += right; x1 += right / node.w * sx; }
    if (handle.y < 0) { top = clamp(delta.y, Math.max(-source.y0 * node.h / sy, node.h - 1_000_000), node.h - 1); height -= top; y0 += top / node.h * sy; }
    if (handle.y > 0) { const bottom = clamp(delta.y, 1 - node.h, Math.min((1 - source.y1) * node.h / sy, 1_000_000 - node.h)); height += bottom; y1 += bottom / node.h * sy; }
    const c = Math.cos(node.rotation), s = Math.sin(node.rotation), x = node.x + c * left - s * top, y = node.y + s * left + c * top;
    const crop: Crop = { x0: clamp(x0, 0, 1), y0: clamp(y0, 0, 1), x1: clamp(x1, 0, 1), y1: clamp(y1, 0, 1), circle: source.circle };
    if (![x, y, width, height, crop.x0, crop.y0, crop.x1, crop.y1].every(Number.isFinite)
        || !(crop.x0 < crop.x1 && crop.y0 < crop.y1)) throw new RangeError('Picture crop cannot be represented');
    const ops: Op[] = [];
    if (x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: x });
    if (y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: y });
    if (width !== node.w) ops.push({ t: 'set', id: node.id, key: 'w', value: width });
    if (height !== node.h) ops.push({ t: 'set', id: node.id, key: 'h', value: height });
    if (crop.x0 !== source.x0 || crop.y0 !== source.y0 || crop.x1 !== source.x1 || crop.y1 !== source.y1) ops.push({ t: 'set', id: node.id, key: 'crop', value: crop });
    return ops;
}
export function flipPicture(node: Readonly<PictureNode>, axis: 'x' | 'y'): readonly Op[] {
    if (node.locked) throw new RangeError('Locked picture cannot be flipped');
    const ops: Op[] = axis === 'x' ? [{ t: 'set', id: node.id, key: 'flipX', value: !node.flipX }]
        : [{ t: 'set', id: node.id, key: 'flipY', value: !node.flipY }];
    if (node.crop) {
        const c = node.crop, crop = axis === 'x' ? { ...c, x0: 1 - c.x1, x1: 1 - c.x0 } : { ...c, y0: 1 - c.y1, y1: 1 - c.y0 };
        ops.push({ t: 'set', id: node.id, key: 'crop', value: crop });
    }
    return ops;
}
