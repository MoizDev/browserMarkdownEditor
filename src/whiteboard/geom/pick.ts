import type { Affine } from '../../platform/types';
import { ConvexDistance } from '../ink/pick';
import { singularValues, transformPoint } from './affine';
import { ContourClipper } from './clip';
import { flattenCubic } from './flatten';
import type { Cubic, PathOp, Vec2 } from './path';
import { segmentIntersection, winding } from './predicates';
import type { NarrowResult, PointQuery, RegionQuery } from './types';

export interface PathPickOptions {
    /** Canonical closed semantic contours, including a hollow figure's interior. */
    readonly interiorPaths?: readonly (readonly PathOp[])[];
    /** Radius of the actual realised outline in node-local world units. */
    readonly strokeRadiusLocal: number;
    /** Input-specific exterior margin in CSS pixels, separate from stroke width. */
    readonly marginCss: number;
    readonly errorCss: number;
    readonly maxSegments: number;
}
export class PathPickUncertain extends Error {
    constructor() { super('Path picking needs a finer numerical budget'); this.name = 'PathPickUncertain'; }
}
function transformPath(path: readonly PathOp[], matrix: Affine): PathOp[] {
    return path.map(op => {
        if (op.op === 'Z') return op;
        if (op.op === 'C') return { op: 'C', c1: transformPoint(matrix, op.c1), c2: transformPoint(matrix, op.c2), p: transformPoint(matrix, op.p) };
        return { op: op.op, p: transformPoint(matrix, op.p) };
    });
}
interface Segment { readonly a: Vec2; readonly b: Vec2; readonly exact?: boolean }
function segments(paths: readonly (readonly PathOp[])[], tolerance: number, maxSegments: number, collapsed: boolean): Segment[] {
    const result: Segment[] = [];
    const add = (a: Vec2, b: Vec2, exact = true) => {
        if (result.length >= maxSegments) throw new RangeError('Path picking exceeds its segment budget');
        result.push({ a, b, exact });
    };
    for (const path of paths) {
        let current: Vec2 | undefined, start: Vec2 | undefined;
        for (const op of path) {
            if (op.op === 'M') { current = start = op.p; continue; }
            if (!current || !start) throw new RangeError('Path must begin with M');
            if (op.op === 'Z') { add(current, start); current = start; continue; }
            if (op.op === 'C') {
                const curve: Cubic = { p0: current, p1: op.c1, p2: op.c2, p3: op.p };
                const points = collapsed ? [current, op.p] : flattenCubic(curve, tolerance);
                for (let i = 1; i < points.length; i++) add(points[i - 1], points[i], collapsed);
            } else add(current, op.p);
            current = op.p;
        }
    }
    return result;
}
const result = (hit: boolean, distanceCss: number): NarrowResult => ({ hit, distanceCss, part: hit ? 'body' : 'none' });
export function pointPath(paths: readonly (readonly PathOp[])[], query: PointQuery, options: PathPickOptions): NarrowResult {
    const { strokeRadiusLocal: radius, marginCss: margin, errorCss, maxSegments } = options;
    if (![radius, margin, errorCss, query.point.x, query.point.y, ...query.localToSurface].every(Number.isFinite)
        || radius < 0 || margin < 0 || errorCss <= 0 || !Number.isSafeInteger(maxSegments) || maxSegments < 1) throw new RangeError('Invalid path pick query');
    if (options.interiorPaths?.length) {
        const clip = new ContourClipper(options.interiorPaths.map(p => transformPath(p, query.localToSurface)), maxSegments);
        if (clip.contains(query.point)) return result(true, 0);
    }
    const [scale] = singularValues(query.localToSurface);
    if (!Number.isFinite(scale)) throw new RangeError('Path pick transform overflows');
    let tolerance = errorCss;
    for (let refinement = 0; refinement < 24; refinement++, tolerance /= 2) {
        const lines = segments(paths, scale ? tolerance / scale : tolerance, maxSegments, scale === 0);
        const distance = new ConvexDistance(query.localToSurface, query.point.x, query.point.y, tolerance / 8);
        let best = Infinity, uncertain = false;
        for (const line of lines) {
            if (line.exact && radius === 0 && margin === 0 && segmentIntersection(transformPoint(query.localToSurface, line.a), transformPoint(query.localToSurface, line.b), query.point, query.point).kind !== 'none') return result(true, 0);
            distance.run(line.a.x, line.a.y, radius, line.b.x, line.b.y, radius, 0, 0);
            best = Math.min(best, distance.upper);
            if ((line.exact && distance.inside) || distance.upper + tolerance <= margin) return result(true, distance.upper);
            if (distance.lower - tolerance <= margin) uncertain = true;
        }
        if (!uncertain) return result(false, best);
    }
    throw new PathPickUncertain();
}

export function regionPath(paths: readonly (readonly PathOp[])[], query: RegionQuery, options: PathPickOptions): NarrowResult {
    const { strokeRadiusLocal: radius, errorCss, maxSegments } = options;
    if (![radius, errorCss, ...query.localToSurface].every(Number.isFinite) || radius < 0 || errorCss <= 0
        || !Number.isSafeInteger(maxSegments) || maxSegments < 1 || query.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new RangeError('Invalid path region');
    const polygon = query.kind === 'polygon';
    if ((polygon && query.points.length < 3) || (!polygon && (!Number.isFinite(query.radiusCss) || query.radiusCss < 0 || !query.points.length))) throw new RangeError('Invalid path region');
    const margin = query.kind === 'swept' ? query.radiusCss : 0;
    const [scale] = singularValues(query.localToSurface);
    if (!Number.isFinite(scale)) throw new RangeError('Path region transform overflows');
    const closed = options.interiorPaths?.map(p => transformPath(p, query.localToSurface));
    const interior = closed?.length ? new ContourClipper(closed, maxSegments) : null;
    const count = polygon ? query.points.length : Math.max(1, query.points.length - 1);
    const edges: Segment[] = [];
    for (let i = 0; i < count; i++) edges.push({ a: query.points[i], b: query.points[polygon ? (i + 1) % query.points.length : Math.min(i + 1, query.points.length - 1)] });
    if (interior && (!polygon || !query.containment)) {
        for (const edge of edges) if (interior.contains(edge.a) || interior.contains(edge.b) || interior.clip(edge.a, edge.b).length) return result(true, 0);
    }
    let tolerance = errorCss;
    for (let refinement = 0; refinement < 24; refinement++, tolerance /= 2) {
        const strokeLines = segments(paths, scale ? tolerance / scale : tolerance, maxSegments, scale === 0);
        const interiorLines = segments(options.interiorPaths ?? [], scale ? tolerance / scale : tolerance, maxSegments, scale === 0);
        const lines = [...strokeLines.map(line => ({ ...line, radius })), ...interiorLines.map(line => ({ ...line, radius: 0 }))];
        if (lines.length > maxSegments) throw new RangeError('Path picking exceeds its segment budget');
        let uncertain = false, intersectsBoundary = false, anyInside = false, allInside = lines.length > 0;
        for (const line of lines) {
            if (polygon) {
                const a = winding(transformPoint(query.localToSurface, line.a), query.points);
                const b = winding(transformPoint(query.localToSurface, line.b), query.points);
                anyInside ||= a !== 0 || b !== 0;
                allInside &&= a !== 0 && b !== 0;
            }
            for (const edge of edges) {
                if (line.exact && line.radius === 0 && margin === 0 && segmentIntersection(transformPoint(query.localToSurface, line.a), transformPoint(query.localToSurface, line.b), edge.a, edge.b).kind !== 'none') {
                    intersectsBoundary = true;
                    continue;
                }
                const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y, length = Math.hypot(dx, dy);
                if (!Number.isFinite(length)) throw new RangeError('Path region edge overflows');
                const ux = length ? dx / length : 1, uy = length ? dy / length : 0;
                const m = query.localToSurface;
                const rotated: Affine = [ux * m[0] + uy * m[1], -uy * m[0] + ux * m[1], ux * m[2] + uy * m[3], -uy * m[2] + ux * m[3], ux * m[4] + uy * m[5], -uy * m[4] + ux * m[5]];
                const midX = edge.a.x / 2 + edge.b.x / 2, midY = edge.a.y / 2 + edge.b.y / 2;
                const distance = new ConvexDistance(rotated, ux * midX + uy * midY, -uy * midX + ux * midY, tolerance / 8);
                distance.run(line.a.x, line.a.y, line.radius, line.b.x, line.b.y, line.radius, length / 2, 0);
                if ((line.exact && distance.inside) || distance.upper + tolerance <= margin) intersectsBoundary = true;
                else if (distance.lower - tolerance <= margin) uncertain = true;
            }
        }
        if (polygon && query.containment) {
            if (!allInside || intersectsBoundary) return result(false, Infinity);
            if (!uncertain) return result(true, 0);
        } else {
            if (intersectsBoundary || anyInside) return result(true, 0);
            if (!uncertain) return result(false, Infinity);
        }
    }
    throw new PathPickUncertain();
}
