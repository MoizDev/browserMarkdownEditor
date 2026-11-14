import type { Arrowhead, Size } from '../model/styles';

// geometry.md §3.2: stored widths are world-unit outlines, not label scales.
export type OutlineKind = 'stroke:pen' | 'stroke:highlighter' | 'figure' | 'connector' | 'polyline';
export type CalibratedLength =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'bracket'; min: number; max: number }>
    | Readonly<{ status: 'provisional'; value: number }>;

export interface StyleGeometryMetrics {
    readonly version: 1;
    actualWidth(kind: OutlineKind, size: Size, legacyScale: number): number;
    fromPen(kind: OutlineKind, penWidth: number): number;
    legacyEquivalent(kind: OutlineKind, size: Size, actualWidth: number): number;
    openArrow(actualWidth: number): Readonly<{ length: number; halfSpan: number }>;
    bendThreshold(size: Size, actualWidth: number): CalibratedLength;
    attachedGap(size: Size, actualWidth: number, head: Arrowhead): CalibratedLength;
}

const BASE: Readonly<Record<OutlineKind, Readonly<Record<Size, number>>>> = {
    'stroke:pen': { s: 3, m: 4.5, l: 6, xl: 11 },
    'stroke:highlighter': { s: 20.16, m: 26.88, l: 40.32, xl: 49.28 },
    figure: { s: 2, m: 3.5, l: 5, xl: 10 },
    connector: { s: 2, m: 3.5, l: 5, xl: 10 },
    polyline: { s: 2, m: 3.5, l: 5, xl: 10 },
};
// Only the small pen/outline widths have observed paint coverage; all others remain provisional.
export function widthCalibration(kind: OutlineKind, size: Size): 'measured' | 'provisional' {
    return size === 's' && kind !== 'stroke:highlighter' ? 'measured' : 'provisional';
}
const PENDING: CalibratedLength = Object.freeze({ status: 'pending' });

function nonnegative(value: number): number {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Expected a finite nonnegative width or scale');
    return value;
}

export const styleGeometryMetrics: StyleGeometryMetrics = Object.freeze({
    version: 1 as const,
    actualWidth(kind: OutlineKind, size: Size, legacyScale: number): number {
        return BASE[kind][size] * nonnegative(legacyScale);
    },
    fromPen(kind: OutlineKind, penWidth: number): number {
        return BASE[kind].s * nonnegative(penWidth) / 3;
    },
    legacyEquivalent(kind: OutlineKind, size: Size, actualWidth: number): number {
        return nonnegative(actualWidth) / BASE[kind][size];
    },
    openArrow(actualWidth: number): Readonly<{ length: number; halfSpan: number }> {
        const width = nonnegative(actualWidth);
        return { length: 3 * Math.sqrt(3) * width / 2, halfSpan: 3 * width / 2 };
    },
    bendThreshold(size: Size, actualWidth: number): CalibratedLength {
        nonnegative(actualWidth);
        return size === 's' && actualWidth === 2 ? { status: 'bracket', min: 6, max: 8 } : PENDING;
    },
    attachedGap(size: Size, actualWidth: number, head: Arrowhead): CalibratedLength {
        nonnegative(actualWidth);
        // The observed horizontal gap does not establish a universal head-specific gap.
        void size; void head;
        return PENDING;
    },
});
