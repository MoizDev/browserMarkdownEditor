import type { Affine, Rect } from '../../platform/types';
import type { Node } from '../model/nodes';
import { DOT_METRIC_PROVISIONAL } from '../ink/width';
import type { DotMetric } from '../ink/width';

import { validBox, writeBox, unionBox } from '../geom/bounds';
export { validBox, writeBox, unionBox, intersects, transformBox, multiplyAffine, inverseAffine } from '../geom/bounds';
export type { Box } from '../geom/bounds';
import type { Box } from '../geom/bounds';

export interface StrokeSummary {
    readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number;
    readonly curve: readonly [minX: number, minY: number, maxX: number, maxY: number];
    readonly maxReach: number;
    readonly maxPressure: number | null;
}
export interface LocalGeometryBounds {
    readonly ink: Box;
    readonly hit?: Box;
}
export interface BoundsProvider {
    local(node: Readonly<Node>): LocalGeometryBounds | undefined;
    stroke(node: Extract<Node, { kind: 'stroke' }>): StrokeSummary | undefined;
}
export const enum BoundsQuality { Pending = 0, Conservative = 1, Exact = 2, ColdLayout = 3 }

export function placement(out: Float64Array, offset: number, node: Readonly<Node>, pageX = 0, pageY = 0): void {
    const c = Math.cos(node.rotation), s = Math.sin(node.rotation);
    out[offset] = c; out[offset + 1] = s; out[offset + 2] = -s; out[offset + 3] = c;
    out[offset + 4] = node.x + pageX; out[offset + 5] = node.y + pageY;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(out[offset + i])) throw new RangeError('Non-finite scene placement');
}
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
            const [cx0, cy0, cx1, cy1] = s.curve;
            if (![cx0, cy0, cx1, cy1, s.maxReach].every(Number.isFinite) || cx0 > s.minX || cy0 > s.minY
                || cx1 < s.maxX || cy1 < s.maxY || s.maxReach < 0) throw new RangeError('Invalid inspected stroke curve bounds');
            const k = Math.max(Math.abs(node.sx), Math.abs(node.sy));
            const extraX = (k - Math.abs(node.sx)) * s.maxReach, extraY = (k - Math.abs(node.sy)) * s.maxReach;
            const ax = node.sx * cx0, bx = node.sx * cx1, ay = node.sy * cy0, by = node.sy * cy1;
            const dot = s.minX === s.maxX && s.minY === s.maxY;
            let radius = node.width / 2;
            if (node.widthModel.id === 'pressure-linear-v1') {
                const pressure = s.maxPressure ?? 16;
                if (!Number.isFinite(pressure) || pressure < 0 || pressure > 16) throw new RangeError('Invalid inspected pressure maximum');
                const atMaximum = node.widthModel.rMin + (node.widthModel.rMax - node.widthModel.rMin) * pressure;
                radius = Math.max(node.widthModel.rMin, atMaximum);
            }
            if (dot) radius = dotMetric.radius(node.width, radius, node.widthModel);
            const outsetX = radius + extraX, outsetY = radius + extraY;
            if (!Number.isFinite(outsetX) || !Number.isFinite(outsetY) || outsetX < 0 || outsetY < 0) throw new RangeError('Stroke bound radius overflows');
            writeBox(out, 0, Math.min(ax, bx) - outsetX, Math.min(ay, by) - outsetY, Math.max(ax, bx) + outsetX, Math.max(ay, by) + outsetY);
            return BoundsQuality.Conservative;
        }
        case 'figure': {
            if (node.label) return BoundsQuality.ColdLayout;
            const r = node.width / 2;
            writeBox(out, 0, -r, -r, node.w + r, node.h + node.growY + r);
            return BoundsQuality.Conservative;
        }
        case 'frame': return BoundsQuality.ColdLayout;
        case 'picture': case 'clip': case 'linkcard': case 'embed':
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
        case 'group': return BoundsQuality.Pending;
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
