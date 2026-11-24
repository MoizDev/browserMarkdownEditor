/** The keyboard and menu zoom ladder (camera.md F-CAM-005). Paged hosts scale every rung by their fit-width zoom.
 * A step leaves the rung nearest the current zoom, so a zoom between rungs still lands on a rung; the nearest
 * rung is the arithmetic one, which is what the measured midpoint bands (1.49→2, 1.51→4, 3.01→8) follow. */
export const ZOOM_RUNGS: readonly number[] = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]);

export function zoomStepTarget(zoom: number, direction: 1 | -1, base = 1): number {
    if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(base) || base <= 0) throw new RangeError('Invalid zoom step');
    const scaled = zoom / base;
    let nearest = 0;
    for (let i = 1; i < ZOOM_RUNGS.length; i++) {
        if (Math.abs(ZOOM_RUNGS[i] - scaled) < Math.abs(ZOOM_RUNGS[nearest] - scaled)) nearest = i;
    }
    // The ends clamp: zooming in at the largest rung, or out at the smallest, leaves the zoom where it is.
    return ZOOM_RUNGS[Math.min(ZOOM_RUNGS.length - 1, Math.max(0, nearest + direction))] * base;
}

/** Zoom to 100% on a paged host alternates between natural 1 and fit-width `base` (camera.md F-CAM-008): from the
 * fit-width zoom it returns to 1, and from anywhere else, including the minimum, it goes to fit-width. A whiteboard
 * has base 1, so it always returns to 1. */
export function resetZoomTarget(zoom: number, base = 1): number {
    if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(base) || base <= 0) throw new RangeError('Invalid zoom reset');
    return Math.abs(zoom - base) <= 1e-9 * base ? 1 : base;
}
