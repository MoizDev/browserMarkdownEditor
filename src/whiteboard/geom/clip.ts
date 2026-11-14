import type { Rect } from '../../platform/types';
import { cubicPoint } from './metrics';
import type { Cubic, PathOp, Vec2 } from './path';
import { orient2d } from './predicates';

export interface ClipInterval { readonly from: number; readonly to: number }

type ScalarCubic = readonly [number, number, number, number];
function scalar(c: ScalarCubic, t: number): number {
    const a = c[0] + (c[1] - c[0]) * t, b = c[1] + (c[2] - c[1]) * t, d = c[2] + (c[3] - c[2]) * t;
    return (a + (b - a) * t) * (1 - t) + (b + (d - b) * t) * t;
}
function breaks(c: ScalarCubic): number[] {
    const scale = Math.max(...c.map(Math.abs));
    if (!Number.isFinite(scale)) throw new RangeError('Clip coordinates overflow');
    if (scale === 0) return [0, 1];
    const [p, q, r, s] = c.map(x => x / scale);
    const a = -p + 3 * q - 3 * r + s, b = 2 * (p - 2 * q + r), d = q - p;
    const roots: number[] = [];
    if (a === 0) {
        if (b !== 0) roots.push(-d / b);
    } else {
        const discriminant = b * b - 4 * a * d;
        if (discriminant >= 0) {
            const root = Math.sqrt(discriminant), stable = -.5 * (b + (b < 0 ? -root : root));
            roots.push(stable / a);
            if (stable !== 0) roots.push(d / stable);
        }
    }
    return [0, ...roots.filter(t => Number.isFinite(t) && t > 0 && t < 1).sort((x, y) => x - y), 1];
}
function root(c: ScalarCubic, a: number, b: number): number {
    let low = a, high = b, fl = scalar(c, low);
    for (let i = 0; i < 60; i++) {
        const mid = (low + high) / 2, fm = scalar(c, mid);
        if (mid === low || mid === high || fm === 0) return mid;
        if ((fl < 0) === (fm < 0)) { low = mid; fl = fm; } else high = mid;
    }
    return (low + high) / 2;
}
function roots(c: ScalarCubic): number[] {
    const knots = breaks(c), result: number[] = [];
    const tolerance = 32 * Number.EPSILON * Math.max(...c.map(Math.abs));
    for (let i = 0; i + 1 < knots.length; i++) {
        const a = knots[i], b = knots[i + 1], fa = scalar(c, a), fb = scalar(c, b);
        if (Math.abs(fa) <= tolerance) result.push(a);
        if (fa !== 0 && fb !== 0 && (fa < 0) !== (fb < 0)) result.push(root(c, a, b));
        if (i + 2 === knots.length && Math.abs(fb) <= tolerance) result.push(b);
    }
    return result;
}
function controls(c: Cubic, project: (p: Vec2) => number): ScalarCubic {
    return [project(c.p0), project(c.p1), project(c.p2), project(c.p3)];
}
function line(a: Vec2, b: Vec2): Cubic {
    return { p0: a, p1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
        p2: { x: b.x - (b.x - a.x) / 3, y: b.y - (b.y - a.y) / 3 }, p3: b };
}
interface ContourSegment { readonly curve: Cubic; readonly straight: boolean }
function parse(paths: readonly (readonly PathOp[])[], maxSegments: number): readonly ContourSegment[] {
    if (!Number.isSafeInteger(maxSegments) || maxSegments < 1) throw new RangeError('Invalid clipping budget');
    const curves: ContourSegment[] = [];
    const add = (curve: Cubic, straight: boolean): void => {
        if (curves.length >= maxSegments) throw new RangeError('Clipping path exceeds its segment budget');
        if ([curve.p0, curve.p1, curve.p2, curve.p3].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new RangeError('Invalid clipping path');
        curves.push({ curve, straight });
    };
    for (const path of paths) {
        let start: Vec2 | undefined, current: Vec2 | undefined;
        for (const op of path) {
            if (op.op === 'M') {
                if (start && current && (start.x !== current.x || start.y !== current.y)) throw new RangeError('Clipping path must be closed');
                start = current = op.p; continue;
            }
            if (!current || !start) throw new RangeError('Clipping path must start with M');
            if (op.op === 'Z') { if (current.x !== start.x || current.y !== start.y) add(line(current, start), true); current = start; continue; }
            if (op.op === 'C') add({ p0: current, p1: op.c1, p2: op.c2, p3: op.p }, false);
            else add(line(current, op.p), true);
            current = op.p;
        }
        if (start && current && (start.x !== current.x || start.y !== current.y)) throw new RangeError('Clipping path must be closed');
    }
    return curves;
}

/** Nonzero-rule clipping against canonical closed cubic paths; no shape AABB substitute. */
export class ContourClipper {
    private readonly curves: readonly ContourSegment[];
    constructor(paths: readonly (readonly PathOp[])[], maxSegments: number) { this.curves = parse(paths, maxSegments); }
    contains(point: Vec2): boolean {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
        let winding = 0;
        for (const { curve } of this.curves) {
            const ys = controls(curve, p => p.y - point.y), knots = breaks(ys);
            for (let i = 0; i + 1 < knots.length; i++) {
                const a = knots[i], b = knots[i + 1], ya = scalar(ys, a), yb = scalar(ys, b);
                if (!((ya <= 0 && yb > 0) || (yb <= 0 && ya > 0))) continue;
                const t = ya === 0 ? a : yb === 0 ? b : root(ys, a, b);
                if (cubicPoint(curve, t).x > point.x) winding += yb > ya ? 1 : -1;
            }
        }
        return winding !== 0;
    }
    clip(start: Vec2, end: Vec2): readonly ClipInterval[] {
        if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) throw new RangeError('Invalid clipping line');
        const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
        if (!Number.isFinite(length)) throw new RangeError('Clipping line overflows');
        if (length === 0) return this.contains(start) ? [{ from: 0, to: 1 }] : [];
        const ux = dx / length, uy = dy / length;
        const intersections = [0, 1];
        const boundary: ClipInterval[] = [];
        for (const { curve, straight } of this.curves) {
            const candidates = straight ? [curve.p0, curve.p3] : [curve.p0, curve.p1, curve.p2, curve.p3];
            if (candidates.every(p => orient2d(start, end, p) === 0)) {
                const positions = controls(curve, p => ((p.x - start.x) * ux + (p.y - start.y) * uy) / length);
                const extrema = breaks(positions).map(t => scalar(positions, t));
                const from = Math.max(0, Math.min(...extrema)), to = Math.min(1, Math.max(...extrema));
                if (from < to) { boundary.push({ from, to }); intersections.push(from, to); }
                continue;
            }
            const distances = controls(curve, p => -uy * (p.x - start.x) + ux * (p.y - start.y));
            for (const t of roots(distances)) {
                const p = cubicPoint(curve, t), along = ((p.x - start.x) * ux + (p.y - start.y) * uy) / length;
                if (Number.isFinite(along) && along >= 0 && along <= 1) intersections.push(along);
            }
        }
        intersections.sort((a, b) => a - b);
        const result: ClipInterval[] = [];
        for (let i = 0; i + 1 < intersections.length; i++) {
            const from = intersections[i], to = intersections[i + 1];
            if (to <= from) continue;
            const t = (from + to) / 2;
            if (boundary.some(interval => interval.from <= t && t <= interval.to)
                || this.contains({ x: start.x + dx * t, y: start.y + dy * t })) {
                const last = result[result.length - 1];
                if (last && last.to === from) result[result.length - 1] = { from: last.from, to };
                else result.push({ from, to });
            }
        }
        return result;
    }
}

export interface HatchLine { readonly start: Vec2; readonly end: Vec2 }

/** The phase is local to the node, so camera motion and flips do not re-seed the pattern. */
export function* hatchLines(clipper: ContourClipper, bounds: Rect, angle: number, spacing: number,
    phase: number, maxLines: number): Generator<HatchLine> {
    const { x, y, width, height } = bounds;
    if (![x, y, width, height, angle, spacing, phase].every(Number.isFinite) || width < 0 || height < 0
        || spacing <= 0 || !Number.isSafeInteger(maxLines) || maxLines < 1) throw new RangeError('Invalid hatch request');
    const ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux;
    const corners = [{ x, y }, { x: x + width, y }, { x, y: y + height }, { x: x + width, y: y + height }];
    const along = corners.map(p => p.x * ux + p.y * uy), across = corners.map(p => p.x * nx + p.y * ny);
    if (![...along, ...across].every(Number.isFinite)) throw new RangeError('Hatch coordinates overflow');
    const first = Math.ceil((Math.min(...across) - phase) / spacing), last = Math.floor((Math.max(...across) - phase) / spacing);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first + 1 > maxLines) throw new RangeError('Hatch line budget exhausted');
    const lo = Math.min(...along), hi = Math.max(...along);
    for (let index = first; index <= last; index++) {
        const offset = phase + index * spacing;
        const start = { x: ux * lo + nx * offset, y: uy * lo + ny * offset };
        const end = { x: ux * hi + nx * offset, y: uy * hi + ny * offset };
        for (const interval of clipper.clip(start, end)) {
            yield { start: { x: start.x + (end.x - start.x) * interval.from, y: start.y + (end.y - start.y) * interval.from },
                end: { x: start.x + (end.x - start.x) * interval.to, y: start.y + (end.y - start.y) * interval.to } };
        }
    }
}
