/** A window on the original picture, 0..1 on each axis. */
export interface CropWindow { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
export type CropAspect = 'original' | 'square' | 'circle' | 'landscape' | 'portrait' | 'wide';
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Pixel ratio (width over height) each aspect preset holds. Circle is a square window drawn round. */
export const CROP_RATIOS: Readonly<Record<Exclude<CropAspect, 'original'>, number>> = Object.freeze({
    square: 1, circle: 1, landscape: 4 / 3, portrait: 3 / 4, wide: 16 / 9,
});
export const WHOLE_PICTURE: CropWindow = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 });
/** The smallest side a crop may leave, as a fraction of the original picture. */
export const CROP_MIN_SIDE = 0.02;
/** Zoom is the magnification of the source: 1 shows the whole picture, 3 shows a third of its longer side. */
export const CROP_ZOOM_MAX = 3;
export const HANDLES: readonly { readonly name: CropHandle; readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 }[] = [
    { name: 'nw', dx: -1, dy: -1 }, { name: 'n', dx: 0, dy: -1 }, { name: 'ne', dx: 1, dy: -1 }, { name: 'e', dx: 1, dy: 0 },
    { name: 'se', dx: 1, dy: 1 }, { name: 's', dx: 0, dy: 1 }, { name: 'sw', dx: -1, dy: 1 }, { name: 'w', dx: -1, dy: 0 },
];

export function clamp(value: number, low: number, high: number): number { return Math.min(high, Math.max(low, value)); }

/** Moves a window inside the picture, keeping its size. */
export function within(win: CropWindow): CropWindow {
    const width = win.x1 - win.x0, height = win.y1 - win.y0;
    const x0 = clamp(win.x0, 0, 1 - width), y0 = clamp(win.y0, 0, 1 - height);
    return { x0, y0, x1: x0 + width, y1: y0 + height };
}

/** The largest window of `ratio` (in pixels) that fits the current one and keeps its centre. */
export function fit(win: CropWindow, ratio: number, width: number, height: number): CropWindow {
    const cx = (win.x0 + win.x1) / 2, cy = (win.y0 + win.y1) / 2;
    let w = (win.x1 - win.x0) * width, h = (win.y1 - win.y0) * height;
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
    const hw = w / width / 2, hh = h / height / 2;
    return within({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh });
}

/** Magnification of the source for a window: the reciprocal of its longer side as a fraction of the picture. */
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
    /** Shift: a handle keeps the window's starting aspect; a body drag moves along one axis. */
    readonly shift: boolean;
    /** Alt: a handle resizes from the centre. */
    readonly fromCentre: boolean;
}

/**
 * The window a drag produces. `ddx`/`ddy` are the pointer's total movement in picture fractions, measured in the picture's
 * own (unflipped, unrotated) frame. A body drag moves the content with the pointer, so the window moves the other way.
 * `pixelRatio` is the picture's width over height in pixels, which the aspect lock needs; `width`/`height` are its pixels.
 */
export function dragged(drag: CropDrag, ddx: number, ddy: number, modifiers: CropDragModifiers, width: number, height: number): CropWindow {
    const origin = drag.origin;
    if (drag.mode === 'move') {
        const mx = modifiers.shift ? (Math.abs(ddx) > Math.abs(ddy) ? ddx : 0) : ddx;
        const my = modifiers.shift ? (Math.abs(ddx) > Math.abs(ddy) ? 0 : ddy) : ddy;
        return within({ x0: origin.x0 - mx, y0: origin.y0 - my, x1: origin.x1 - mx, y1: origin.y1 - my });
    }
    let { x0, y0, x1, y1 } = origin;
    const moveX = drag.dx * ddx, moveY = drag.dy * ddy;
    // From the centre, each side moves by the pointer's amount and the opposite side mirrors it.
    if (drag.dx < 0) { x0 = origin.x0 + ddx; if (modifiers.fromCentre) x1 = origin.x1 - ddx; }
    if (drag.dx > 0) { x1 = origin.x1 + ddx; if (modifiers.fromCentre) x0 = origin.x0 - ddx; }
    if (drag.dy < 0) { y0 = origin.y0 + ddy; if (modifiers.fromCentre) y1 = origin.y1 - ddy; }
    if (drag.dy > 0) { y1 = origin.y1 + ddy; if (modifiers.fromCentre) y0 = origin.y0 - ddy; }
    if (modifiers.shift) {
        const ratio = ((origin.x1 - origin.x0) * width) / ((origin.y1 - origin.y0) * height);
        const cx = (origin.x0 + origin.x1) / 2, cy = (origin.y0 + origin.y1) / 2;
        // Work in pixels, size the window from the axis the pointer moved more on, then anchor it to the side it did not move.
        let w = (x1 - x0) * width, h = (y1 - y0) * height;
        const corner = drag.dx !== 0 && drag.dy !== 0;
        if (corner ? Math.abs(moveX * width) >= Math.abs(moveY * height) : drag.dx !== 0) h = w / ratio; else w = h * ratio;
        const fw = w / width, fh = h / height;
        if (modifiers.fromCentre) { x0 = cx - fw / 2; x1 = cx + fw / 2; y0 = cy - fh / 2; y1 = cy + fh / 2; }
        else {
            // Keep the side opposite the handle where it was; with no movement on an axis, keep that axis centred.
            if (drag.dx < 0) { x0 = origin.x1 - fw; x1 = origin.x1; } else if (drag.dx > 0) { x0 = origin.x0; x1 = origin.x0 + fw; }
            else { x0 = cx - fw / 2; x1 = cx + fw / 2; }
            if (drag.dy < 0) { y0 = origin.y1 - fh; y1 = origin.y1; } else if (drag.dy > 0) { y0 = origin.y0; y1 = origin.y0 + fh; }
            else { y0 = cy - fh / 2; y1 = cy + fh / 2; }
        }
    }
    // A side never crosses its opposite side or leaves the picture.
    if (x1 - x0 < CROP_MIN_SIDE) { if (drag.dx < 0) x0 = x1 - CROP_MIN_SIDE; else x1 = x0 + CROP_MIN_SIDE; }
    if (y1 - y0 < CROP_MIN_SIDE) { if (drag.dy < 0) y0 = y1 - CROP_MIN_SIDE; else y1 = y0 + CROP_MIN_SIDE; }
    return within({ x0: clamp(x0, 0, 1), y0: clamp(y0, 0, 1), x1: clamp(x1, 0, 1), y1: clamp(y1, 0, 1) });
}

/** The window an aspect preset gives, from the current window: whole picture for "original", else the largest fit. */
export function windowForAspect(win: CropWindow, aspect: CropAspect, width: number, height: number): CropWindow {
    if (aspect === 'original') return WHOLE_PICTURE;
    return fit(win, CROP_RATIOS[aspect], width, height);
}

/** The window that shows the whole picture at one preset's aspect, the Fit button's result. */
export function fitWhole(aspect: CropAspect, width: number, height: number): CropWindow {
    return windowForAspect(WHOLE_PICTURE, aspect, width, height);
}
