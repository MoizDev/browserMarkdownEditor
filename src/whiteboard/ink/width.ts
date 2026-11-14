import type { WidthModel } from '../model/nodes';
import type { CurveGeometry } from './curve';
import type { SampleSequence } from './samples';
import type { CubicArcMap } from './flatten';

export interface InkWidth {
    readonly width: number; // Actual stored world width, already converted by StyleGeometryMetrics.
    readonly model: WidthModel;
    readonly pressure: 'real' | 'none';
}
export interface DotMetric {
    readonly id: string;
    readonly status: string;
    radius(actualWidth: number, modelRadius: number, model: WidthModel): number;
}
export interface InkDot { readonly x: number; readonly y: number; readonly radius: number; }

// Lead ruling for W-E2: a tap must paint while M-INK-DOT is open. These are provisional PRODUCT
// choices using DOT-M1 z1/DPR1 coverage-equivalent diameters, NOT recovered continuous radii or a
// parity claim. The other zoom/DPR raster rows must not make saved geometry camera-dependent.
const DOT_KNOTS = Object.freeze([
    Object.freeze({ width: 0.36, diameter: 1.459307 }),
    Object.freeze({ width: 3, diameter: 3.907379 }),
    Object.freeze({ width: 10.5, diameter: 11.360917 }),
]);
export const DOT_METRIC_PROVISIONAL: DotMetric = Object.freeze({
    id: 'dot-provisional-v1',
    status: 'continuous radius and paper hosts unmeasured (M-INK-DOT)',
    radius(actualWidth: number, modelRadius: number, model: WidthModel): number {
        if (model.id === 'pressure-linear-v1') return modelRadius;
        const a = actualWidth <= DOT_KNOTS[1].width ? DOT_KNOTS[0] : DOT_KNOTS[1];
        const b = actualWidth <= DOT_KNOTS[1].width ? DOT_KNOTS[1] : DOT_KNOTS[2];
        return (a.diameter + (actualWidth - a.width) * (b.diameter - a.diameter) / (b.width - a.width)) / 2;
    },
});

export function validateInkWidth(style: InkWidth): void {
    if (!Number.isFinite(style.width) || style.width <= 0) throw new RangeError('Ink needs a positive actual stored width');
    const model = style.model;
    if (model.id === 'pressure-linear-v1' && (style.pressure !== 'real'
        || !Number.isFinite(model.rMin) || model.rMin < 0 || !Number.isFinite(model.rMax) || model.rMax < model.rMin)) {
        throw new RangeError('Invalid pressure width model or pressure-none source');
    }
}
export function radiusAtSample(samples: SampleSequence, index: number, style: InkWidth): number {
    validateInkWidth(style);
    if (style.model.id === 'uniform') return style.width / 2;
    const pressure = samples.pressure(index);
    if (pressure === undefined || !Number.isFinite(pressure) || pressure < 0 || pressure > 16) {
        throw new RangeError('Pressure width requires the admitted stored pressure, without normalization');
    }
    const radius = style.model.rMin + (style.model.rMax - style.model.rMin) * pressure;
    if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Ink radius overflow');
    return radius;
}
export function curveRadii(samples: SampleSequence, geometry: CurveGeometry, style: InkWidth): Float64Array {
    validateInkWidth(style);
    const radii = new Float64Array(2 * geometry.spanCount);
    for (let i = 0; i < geometry.spanCount; i++) {
        radii[2 * i] = radiusAtSample(samples, geometry.firstSpan + i, style);
        radii[2 * i + 1] = radiusAtSample(samples, geometry.firstSpan + i + 1, style);
    }
    return radii;
}
export function strokeDot(samples: SampleSequence, style: InkWidth, metric: DotMetric): InkDot | null {
    validateInkWidth(style);
    if (!samples.count) throw new RangeError('Empty ink is not a dot');
    const x = samples.x(0), y = samples.y(0);
    let maximum = radiusAtSample(samples, 0, style);
    for (let i = 1; i < samples.count; i++) {
        if (samples.x(i) !== x || samples.y(i) !== y) return null;
        maximum = Math.max(maximum, radiusAtSample(samples, i, style));
    }
    const radius = metric.radius(style.width, maximum, style.model);
    if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Invalid dot metric');
    return Object.freeze({ x, y, radius });
}

// R-13/T-GEO-WIDTH: realize resize/reflection in POINTS before materializing the local curve.
// The same actual stored width/profile then makes circular caps; never scale an existing outline.
export function realizeStrokePoints(samples: SampleSequence, sx: number, sy: number): SampleSequence {
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) throw new RangeError('Invalid stroke point factors');
    const coordinate = (value: number, factor: number) => {
        const result = value * factor;
        if (!Number.isFinite(result)) throw new RangeError('Stroke point realization overflow');
        return result;
    };
    return Object.freeze({
        count: samples.count,
        x: (i: number) => coordinate(samples.x(i), sx), y: (i: number) => coordinate(samples.y(i), sy),
        pressure: (i: number) => samples.pressure(i), segmentKind: (i: number) => samples.segmentKind(i),
    });
}

export function interpolateRadius(r0: number, r1: number, fraction: number): number {
    // rMax is the radius at p=1, not an upper clamp. Zero is a genuine taper.
    return (1 - fraction) * r0 + fraction * r1;
}
export function radiusAtCurveParameter(map: CubicArcMap, r0: number, r1: number, t: number): number {
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('Invalid curve parameter');
    if (t === 0) return r0;
    if (t === 1) return r1;
    if (!map.length) return Math.max(r0, r1);
    const rows = map.pieces;
    let low = 0, high = rows.length / 9 - 1;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (rows[9 * middle + 1] < t) low = middle + 1;
        else high = middle;
    }
    const offset = 9 * low, c = map.cubic, s = 1 - t;
    const x = s * s * s * c[0] + 3 * s * s * t * c[2] + 3 * s * t * t * c[4] + t * t * t * c[6];
    const y = s * s * s * c[1] + 3 * s * s * t * c[3] + 3 * s * t * t * c[5] + t * t * t * c[7];
    const dx = rows[offset + 4] - rows[offset + 2], dy = rows[offset + 5] - rows[offset + 3];
    const square = dx * dx + dy * dy;
    const fraction = square ? Math.max(0, Math.min(1, ((x - rows[offset + 2]) * dx + (y - rows[offset + 3]) * dy) / square)) : 0;
    // Partial true arc exceeds its chord projection by at most the leaf's arc/chord gap.
    // Prefix and total length enclosures bound the resulting radius error (flatten.ts); this
    // projection is NOT linear interpolation in t, which would distort pressure at unequal speed.
    return interpolateRadius(r0, r1, (rows[offset + 6] + fraction * rows[offset + 7]) / map.length);
}
