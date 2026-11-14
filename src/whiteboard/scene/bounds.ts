import type { Affine, Rect } from '../../platform/types';
import type { Node } from '../model/nodes';
import { DOT_METRIC_PROVISIONAL } from '../ink/width';
import type { DotMetric } from '../ink/width';

// Packed scene/index boxes use [minX,minY,maxX,maxY], never Float32 absolute positions.
export type Box = readonly [number, number, number, number];
export interface StrokeSummary {
    readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number;
    readonly maxPressure: number | null;
}
export interface LocalGeometryBounds {
    readonly ink: Box;
    readonly hit?: Box;
}
export interface BoundsProvider {
    // Cached exact geometry/layout, already realizing stroke sx/sy and text/card scale, not placement.
    local(node: Readonly<Node>): LocalGeometryBounds | undefined;
    // R-W39: collected during the reader's required varint inspection, no sample arrays/decoding.
    stroke(node: Extract<Node, { kind: 'stroke' }>): StrokeSummary | undefined;
}
export const enum BoundsQuality { Pending = 0, Conservative = 1, Exact = 2, ColdLayout = 3 }

export function validBox(a: ArrayLike<number>, offset = 0): boolean {
    return Number.isFinite(a[offset]) && Number.isFinite(a[offset + 1]) && Number.isFinite(a[offset + 2])
        && Number.isFinite(a[offset + 3]) && a[offset] <= a[offset + 2] && a[offset + 1] <= a[offset + 3];
}
export function writeBox(out: Float64Array, offset: number, x0: number, y0: number, x1: number, y1: number): void {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || x1 < x0 || y1 < y0) {
        throw new RangeError('Scene bounds must be finite and ordered');
    }
    out[offset] = x0; out[offset + 1] = y0; out[offset + 2] = x1; out[offset + 3] = y1;
}
export function unionBox(out: Float64Array, offset: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
    out[offset] = Math.min(a[ai], b[bi]); out[offset + 1] = Math.min(a[ai + 1], b[bi + 1]);
    out[offset + 2] = Math.max(a[ai + 2], b[bi + 2]); out[offset + 3] = Math.max(a[ai + 3], b[bi + 3]);
}
export function intersects(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): boolean {
    return a[ai] <= b[bi + 2] && b[bi] <= a[ai + 2] && a[ai + 1] <= b[bi + 3] && b[bi + 1] <= a[ai + 3];
}
export function transformBox(out: Float64Array, offset: number, box: ArrayLike<number>, start: number, matrix: ArrayLike<number>, mi = 0): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const x = box[start + (i & 1 ? 2 : 0)], y = box[start + (i & 2 ? 3 : 1)];
        const wx = matrix[mi] * x + matrix[mi + 2] * y + matrix[mi + 4];
        const wy = matrix[mi + 1] * x + matrix[mi + 3] * y + matrix[mi + 5];
        minX = Math.min(minX, wx); minY = Math.min(minY, wy); maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy);
    }
    const numeric = 64 * Number.EPSILON * Math.max(1, Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY));
    writeBox(out, offset, minX - numeric, minY - numeric, maxX + numeric, maxY + numeric);
}
export function multiplyAffine(out: Float64Array, oi: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
    const x0 = a[ai] * b[bi] + a[ai + 2] * b[bi + 1], y0 = a[ai + 1] * b[bi] + a[ai + 3] * b[bi + 1];
    const x1 = a[ai] * b[bi + 2] + a[ai + 2] * b[bi + 3], y1 = a[ai + 1] * b[bi + 2] + a[ai + 3] * b[bi + 3];
    const x = a[ai] * b[bi + 4] + a[ai + 2] * b[bi + 5] + a[ai + 4], y = a[ai + 1] * b[bi + 4] + a[ai + 3] * b[bi + 5] + a[ai + 5];
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Scene transform overflows');
    out[oi] = x0; out[oi + 1] = y0; out[oi + 2] = x1; out[oi + 3] = y1; out[oi + 4] = x; out[oi + 5] = y;
}
export function placement(out: Float64Array, offset: number, node: Readonly<Node>, pageX = 0, pageY = 0): void {
    const c = Math.cos(node.rotation), s = Math.sin(node.rotation);
    out[offset] = c; out[offset + 1] = s; out[offset + 2] = -s; out[offset + 3] = c;
    out[offset + 4] = node.x + pageX; out[offset + 5] = node.y + pageY;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(out[offset + i])) throw new RangeError('Non-finite scene placement');
}
export function inverseAffine(out: Float64Array, oi: number, source: ArrayLike<number>, si = 0): boolean {
    const a = source[si], b = source[si + 1], c = source[si + 2], d = source[si + 3], e = source[si + 4], f = source[si + 5];
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || determinant === 0) return false;
    out[oi] = d / determinant; out[oi + 1] = -b / determinant; out[oi + 2] = -c / determinant; out[oi + 3] = a / determinant;
    out[oi + 4] = (c * f - d * e) / determinant; out[oi + 5] = (b * e - a * f) / determinant;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(out[oi + i])) return false;
    return true;
}

// R-W38/39: cold b is WORLD space (PAGE-LOCAL for a paged root AND descendants), never
// transformed by the node chain twice. Only layout-dependent kinds use that temporary cache;
// an offscreen-capable idle layout pass must replace it, so a stale finite b cannot hide a node.
// Strokes NEVER trust b: min/max + pressure from full reader inspection bound the surviving
// samples and all bounded local controls without decoding. New strokes supply their geometry.
export function localBounds(node: Readonly<Node>, provider: BoundsProvider, out: Float64Array,
    dotMetric: DotMetric = DOT_METRIC_PROVISIONAL): BoundsQuality {
    const exact = provider.local(node);
    if (exact) {
        const hit = exact.hit ?? exact.ink;
        if (!validBox(exact.ink) || !validBox(hit)) throw new RangeError('Invalid geometry-provider bounds');
        unionBox(out, 0, exact.ink, 0, hit, 0);
        return BoundsQuality.Exact;
    }
    switch (node.kind) {
        case 'stroke': {
            const s = provider.stroke(node);
            if (!s) return BoundsQuality.Pending;
            if (!Number.isFinite(s.minX) || !Number.isFinite(s.minY) || !Number.isFinite(s.maxX) || !Number.isFinite(s.maxY)
                || s.maxX < s.minX || s.maxY < s.minY) throw new RangeError('Invalid inspected stroke bounds');
            const ax = node.sx * s.minX, bx = node.sx * s.maxX, ay = node.sy * s.minY, by = node.sy * s.maxY;
            let radius = node.width / 2;
            if (node.widthModel.id === 'pressure-linear-v1') {
                const pressure = s.maxPressure ?? 16; // Domain enclosure, never a guessed pen signal.
                if (!Number.isFinite(pressure) || pressure < 0 || pressure > 16) throw new RangeError('Invalid inspected pressure maximum');
                radius = node.widthModel.rMin + (node.widthModel.rMax - node.widthModel.rMin) * pressure;
            }
            if (ax === bx && ay === by) radius = dotMetric.radius(node.width, radius, node.widthModel);
            const outset = radius + node.fairTol;
            if (!Number.isFinite(outset) || outset < 0) throw new RangeError('Stroke bound radius overflows');
            writeBox(out, 0, Math.min(ax, bx) - outset, Math.min(ay, by) - outset, Math.max(ax, bx) + outset, Math.max(ay, by) + outset);
            return BoundsQuality.Conservative;
        }
        case 'figure': {
            const r = node.width / 2;
            writeBox(out, 0, -r, -r, node.w + r, node.h + node.growY + r);
            return BoundsQuality.Conservative;
        }
        case 'frame': case 'picture': case 'clip': case 'linkcard': case 'embed':
            writeBox(out, 0, 0, 0, node.w, node.h);
            return BoundsQuality.Conservative;
        case 'polyline': {
            if (node.spline !== 'line') return BoundsQuality.ColdLayout;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of node.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
            if (!node.points.length) return BoundsQuality.Pending;
            const r = node.width / 2;
            writeBox(out, 0, x0 - r, y0 - r, x1 + r, y1 + r);
            return BoundsQuality.Conservative;
        }
        case 'group': return BoundsQuality.Pending; // Aggregate children; never a guessed group size.
        case 'text': case 'sticky': case 'connector': case 'opaque': return BoundsQuality.ColdLayout;
    }
}

export function coldWorldBounds(cold: readonly [number, number, number, number], out: Float64Array,
    page: Rect | undefined): void {
    const [x, y, w, h] = cold;
    if (w < 0 || h < 0) throw new RangeError('Invalid cold cache extent');
    writeBox(out, 0, x + (page?.x ?? 0), y + (page?.y ?? 0), x + w + (page?.x ?? 0), y + h + (page?.y ?? 0));
}
export function copyAffine(source: Float64Array, offset: number, target: [number, number, number, number, number, number]): Affine {
    for (let i = 0; i < 6; i++) target[i] = source[offset + i];
    return target;
}
