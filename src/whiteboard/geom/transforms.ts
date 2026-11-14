import type { Vec2 } from './path';

export interface OrientedBox { readonly origin: Vec2; readonly width: number; readonly height: number; readonly rotation: number }
export interface ResizeHandle { readonly x: -1 | 0 | 1; readonly y: -1 | 0 | 1 }
export interface ResizeModifiers { readonly shift: boolean; readonly alt: boolean }
export interface ResizePreview {
    readonly box: OrientedBox;
    readonly scaleX: number;
    readonly scaleY: number;
    /** Signed extents retain the crossing direction even at a collapsed preview. */
    readonly signedWidth: number;
    readonly signedHeight: number;
    readonly anchor: Vec2;
}
function world(box: OrientedBox, x: number, y: number): Vec2 {
    const c = Math.cos(box.rotation), s = Math.sin(box.rotation);
    return { x: box.origin.x + c * x - s * y, y: box.origin.y + s * x + c * y };
}
export function resizeBox(start: OrientedBox, handle: ResizeHandle, down: Vec2, pointer: Vec2,
    modifiers: ResizeModifiers, forceAspect = false): ResizePreview {
    if (![start.origin.x, start.origin.y, start.width, start.height, start.rotation, down.x, down.y, pointer.x, pointer.y].every(Number.isFinite)
        || start.width <= 0 || start.height <= 0 || (!handle.x && !handle.y)) throw new RangeError('Invalid resize snapshot');
    const c = Math.cos(start.rotation), s = Math.sin(start.rotation), dx = pointer.x - down.x, dy = pointer.y - down.y;
    const localX = c * dx + s * dy, localY = -s * dx + c * dy, factor = modifiers.alt ? 2 : 1;
    let width = handle.x ? start.width + factor * handle.x * localX : start.width;
    let height = handle.y ? start.height + factor * handle.y * localY : start.height;
    if (modifiers.shift || forceAspect) {
        const sx = width / start.width, sy = height / start.height;
        const scale = handle.x && handle.y ? Math.max(Math.abs(sx), Math.abs(sy)) : handle.x ? Math.abs(sx) : Math.abs(sy);
        width = start.width * scale * (handle.x && sx < 0 ? -1 : 1);
        height = start.height * scale * (handle.y && sy < 0 ? -1 : 1);
    }
    const axis = (extent: number, original: number, h: number): readonly [number, number, number] => {
        if (modifiers.alt || h === 0) return [(original - extent) / 2, (original + extent) / 2, original / 2];
        return h > 0 ? [0, extent, 0] : [original - extent, original, original];
    };
    const [x0, x1, ax] = axis(width, start.width, handle.x), [y0, y1, ay] = axis(height, start.height, handle.y);
    const origin = world(start, Math.min(x0, x1), Math.min(y0, y1));
    if (![width, height, x0, x1, y0, y1, origin.x, origin.y].every(Number.isFinite)) throw new RangeError('Resize geometry overflows');
    return { box: { origin, width: Math.abs(width), height: Math.abs(height), rotation: start.rotation },
        scaleX: width / start.width, scaleY: height / start.height, signedWidth: width, signedHeight: height, anchor: world(start, ax, ay) };
}
export function parentLocalDelta(worldDelta: Vec2, parentRotation: number): Vec2 {
    if (![worldDelta.x, worldDelta.y, parentRotation].every(Number.isFinite)) throw new RangeError('Invalid translation');
    const c = Math.cos(parentRotation), s = Math.sin(parentRotation);
    return { x: c * worldDelta.x + s * worldDelta.y, y: -s * worldDelta.x + c * worldDelta.y };
}
export function constrainedTranslation(delta: Vec2, shift: boolean): Vec2 {
    if (![delta.x, delta.y].every(Number.isFinite)) throw new RangeError('Invalid translation');
    if (!shift) return delta;
    return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
}
export function rotatePoint(point: Vec2, centre: Vec2, angle: number): Vec2 {
    if (![point.x, point.y, centre.x, centre.y, angle].every(Number.isFinite)) throw new RangeError('Invalid rotation');
    const c = Math.cos(angle), s = Math.sin(angle), x = point.x - centre.x, y = point.y - centre.y;
    return { x: centre.x + c * x - s * y, y: centre.y + s * x + c * y };
}
export function unwrapRotation(previous: number, previousPointerAngle: number, pointerAngle: number): number {
    if (![previous, previousPointerAngle, pointerAngle].every(Number.isFinite)) throw new RangeError('Invalid rotation angle');
    let delta = (pointerAngle - previousPointerAngle) % (2 * Math.PI);
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    return previous + delta;
}
export function snapRotation(orientation: number, shift: boolean): number {
    if (!Number.isFinite(orientation)) throw new RangeError('Invalid rotation');
    const step = Math.PI / 12;
    return shift ? Math.round(orientation / step) * step : orientation;
}
export function commonResizeRotation(rotations: readonly number[]): number | null {
    if (!rotations.length || !rotations.every(Number.isFinite)) return null;
    const reference = rotations[0], quarter = Math.PI / 2;
    for (const angle of rotations) {
        const turns = Math.round((angle - reference) / quarter), residual = angle - reference - turns * quarter;
        const uncertainty = 8 * Number.EPSILON * Math.max(1, Math.abs(angle), Math.abs(reference), Math.abs(turns * quarter));
        if (Math.abs(residual) > uncertainty) return null;
    }
    return reference;
}
