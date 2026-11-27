export const ZOOM_RUNGS: readonly number[] = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]);

export function zoomStepTarget(zoom: number, direction: 1 | -1, base = 1): number {
    if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(base) || base <= 0) throw new RangeError('Invalid zoom step');
    const scaled = zoom / base;
    let nearest = 0;
    for (let i = 1; i < ZOOM_RUNGS.length; i++) {
        if (Math.abs(ZOOM_RUNGS[i] - scaled) < Math.abs(ZOOM_RUNGS[nearest] - scaled)) nearest = i;
    }
    return ZOOM_RUNGS[Math.min(ZOOM_RUNGS.length - 1, Math.max(0, nearest + direction))] * base;
}

export function resetZoomTarget(zoom: number, base = 1): number {
    if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(base) || base <= 0) throw new RangeError('Invalid zoom reset');
    return Math.abs(zoom - base) <= 1e-9 * base ? 1 : base;
}
