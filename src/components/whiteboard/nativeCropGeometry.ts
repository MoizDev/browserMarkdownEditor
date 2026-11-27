export interface CropWindow { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
export type CropAspect = 'original' | 'square' | 'circle' | 'landscape' | 'portrait' | 'wide';
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const CROP_RATIOS: Readonly<Record<Exclude<CropAspect, 'original'>, number>> = Object.freeze({
    square: 1, circle: 1, landscape: 4 / 3, portrait: 3 / 4, wide: 16 / 9,
});
export const WHOLE_PICTURE: CropWindow = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 });
export const CROP_MIN_SIDE = 0.02;
export const CROP_ZOOM_MAX = 3;
export const HANDLES: readonly { readonly name: CropHandle; readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 }[] = [
    { name: 'nw', dx: -1, dy: -1 }, { name: 'n', dx: 0, dy: -1 }, { name: 'ne', dx: 1, dy: -1 }, { name: 'e', dx: 1, dy: 0 },
    { name: 'se', dx: 1, dy: 1 }, { name: 's', dx: 0, dy: 1 }, { name: 'sw', dx: -1, dy: 1 }, { name: 'w', dx: -1, dy: 0 },
];

export function clamp(value: number, low: number, high: number): number { return Math.min(high, Math.max(low, value)); }

export function within(win: CropWindow): CropWindow {
    const width = win.x1 - win.x0, height = win.y1 - win.y0;
    const x0 = clamp(win.x0, 0, 1 - width), y0 = clamp(win.y0, 0, 1 - height);
    return { x0, y0, x1: x0 + width, y1: y0 + height };
}

export function fit(win: CropWindow, ratio: number, width: number, height: number): CropWindow {
    const cx = (win.x0 + win.x1) / 2, cy = (win.y0 + win.y1) / 2;
    let w = (win.x1 - win.x0) * width, h = (win.y1 - win.y0) * height;
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
    const hw = w / width / 2, hh = h / height / 2;
    return within({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh });
}

export function zoomOf(win: CropWindow): number { return 1 / Math.max(win.x1 - win.x0, win.y1 - win.y0); }

export function withZoom(win: CropWindow, zoom: number): CropWindow {
    const cx = (win.x0 + win.x1) / 2, cy = (win.y0 + win.y1) / 2;
    const k = (1 / zoom) / Math.max(win.x1 - win.x0, win.y1 - win.y0);
    const hw = (win.x1 - win.x0) * k / 2, hh = (win.y1 - win.y0) * k / 2;
    return within({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh });
}

export interface CropDrag {
    readonly mode: 'move' | 'edge';
    readonly dx: -1 | 0 | 1;
    readonly dy: -1 | 0 | 1;
    readonly origin: CropWindow;
}
export interface CropDragModifiers {
    readonly shift: boolean;
    readonly fromCentre: boolean;
}

export function dragged(drag: CropDrag, ddx: number, ddy: number, modifiers: CropDragModifiers, width: number, height: number): CropWindow {
    const origin = drag.origin;
    if (drag.mode === 'move') {
        const mx = modifiers.shift ? (Math.abs(ddx) > Math.abs(ddy) ? ddx : 0) : ddx;
        const my = modifiers.shift ? (Math.abs(ddx) > Math.abs(ddy) ? 0 : ddy) : ddy;
        return within({ x0: origin.x0 - mx, y0: origin.y0 - my, x1: origin.x1 - mx, y1: origin.y1 - my });
    }
    let { x0, y0, x1, y1 } = origin;
    const moveX = drag.dx * ddx, moveY = drag.dy * ddy;
    if (drag.dx < 0) { x0 = origin.x0 + ddx; if (modifiers.fromCentre) x1 = origin.x1 - ddx; }
    if (drag.dx > 0) { x1 = origin.x1 + ddx; if (modifiers.fromCentre) x0 = origin.x0 - ddx; }
    if (drag.dy < 0) { y0 = origin.y0 + ddy; if (modifiers.fromCentre) y1 = origin.y1 - ddy; }
    if (drag.dy > 0) { y1 = origin.y1 + ddy; if (modifiers.fromCentre) y0 = origin.y0 - ddy; }
    if (modifiers.shift) {
        const ratio = ((origin.x1 - origin.x0) * width) / ((origin.y1 - origin.y0) * height);
        const cx = (origin.x0 + origin.x1) / 2, cy = (origin.y0 + origin.y1) / 2;
        let w = (x1 - x0) * width, h = (y1 - y0) * height;
        const corner = drag.dx !== 0 && drag.dy !== 0;
        if (corner ? Math.abs(moveX * width) >= Math.abs(moveY * height) : drag.dx !== 0) h = w / ratio; else w = h * ratio;
        const fw = w / width, fh = h / height;
        if (modifiers.fromCentre) { x0 = cx - fw / 2; x1 = cx + fw / 2; y0 = cy - fh / 2; y1 = cy + fh / 2; }
        else {
            if (drag.dx < 0) { x0 = origin.x1 - fw; x1 = origin.x1; } else if (drag.dx > 0) { x0 = origin.x0; x1 = origin.x0 + fw; }
            else { x0 = cx - fw / 2; x1 = cx + fw / 2; }
            if (drag.dy < 0) { y0 = origin.y1 - fh; y1 = origin.y1; } else if (drag.dy > 0) { y0 = origin.y0; y1 = origin.y0 + fh; }
            else { y0 = cy - fh / 2; y1 = cy + fh / 2; }
        }
    }
    if (x1 - x0 < CROP_MIN_SIDE) { if (drag.dx < 0) x0 = x1 - CROP_MIN_SIDE; else x1 = x0 + CROP_MIN_SIDE; }
    if (y1 - y0 < CROP_MIN_SIDE) { if (drag.dy < 0) y0 = y1 - CROP_MIN_SIDE; else y1 = y0 + CROP_MIN_SIDE; }
    return within({ x0: clamp(x0, 0, 1), y0: clamp(y0, 0, 1), x1: clamp(x1, 0, 1), y1: clamp(y1, 0, 1) });
}

export function windowForAspect(win: CropWindow, aspect: CropAspect, width: number, height: number): CropWindow {
    if (aspect === 'original') return WHOLE_PICTURE;
    return fit(win, CROP_RATIOS[aspect], width, height);
}

export function fitWhole(aspect: CropAspect, width: number, height: number): CropWindow {
    return windowForAspect(WHOLE_PICTURE, aspect, width, height);
}
