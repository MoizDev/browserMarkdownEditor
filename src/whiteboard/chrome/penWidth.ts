import { styleGeometryMetrics, type OutlineKind } from '../geom/styleMetrics';

export const MIN_PEN_SCALE = 0.12;
export const MAX_PEN_SCALE = 3.5;
export const DEFAULT_PEN_SCALE = 1;

export function clampPenScale(scale: number): number {
    return Number.isFinite(scale) ? Math.min(MAX_PEN_SCALE, Math.max(MIN_PEN_SCALE, scale)) : DEFAULT_PEN_SCALE;
}

export function penScaleFromSlider(position: number): number {
    const p = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : penSliderFromScale(DEFAULT_PEN_SCALE);
    return MIN_PEN_SCALE * (MAX_PEN_SCALE / MIN_PEN_SCALE) ** p;
}

export function penSliderFromScale(scale: number): number {
    return Math.log(clampPenScale(scale) / MIN_PEN_SCALE) / Math.log(MAX_PEN_SCALE / MIN_PEN_SCALE);
}

export function penOutlineWidth(kind: OutlineKind, scale: number): number {
    return styleGeometryMetrics.actualWidth(kind, 's', clampPenScale(scale));
}
