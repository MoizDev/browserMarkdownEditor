import type { PathCommand } from '../../platform/types';
import { PATH_COVERAGE_STENCIL_MAX_EDGES } from '../../platform/render/pathCoverage';
import { flattenCubic } from '../geom/flatten';
import type { Vec2 } from '../geom/path';

/** Work bound for one path tile; beyond it the whole path takes the reference route. */
export const PATH_FILL_MAX_EDGES = 65_536;
export { PATH_COVERAGE_STENCIL_MAX_EDGES as PATH_FILL_STENCIL_MAX_EDGES };

export interface PathFillOptions {
    /** Maximum deviation of flattened curves, in the same units as the commands (device px / scale). */
    readonly tolerance: number;
    /** Subtracted from every coordinate in double precision before any value is stored. */
    readonly origin: readonly [x: number, y: number];
    readonly maxEdges?: number;
}

/** Origin-relative triangles, six values per triangle (x0,y0,x1,y1,x2,y2).
 * `positive` triangles have counter-clockwise orientation and add +1 to the winding of the points
 * they cover; `negative` triangles subtract 1. Their signed sum equals the winding number everywhere
 * except on boundaries, so the stencil can count it directly for nonzero and parity-test it for even-odd. */
export interface PathFillTriangles {
    readonly positive: Float64Array;
    readonly negative: Float64Array;
    /** Flattened edges that contribute to the winding (degenerate closing pairs are dropped). */
    readonly edges: number;
    /** Origin-relative bounds of every flattened vertex. */
    readonly bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
}

export function flattenContours(commands: readonly PathCommand[], tolerance: number, maxEdges: number): Vec2[][] | null {
    if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new RangeError('Invalid path flattening tolerance');
    const contours: Vec2[][] = [];
    // The open contour, if any. After a closepath there is none, and the next segment opens a contour at the subpath's start,
    // as canvas does: the closed triangle is not joined to what follows it (a stroke twin, pathStrokeTriangles, does the same).
    let current: Vec2[] | null = null, subpathStart: Vec2 | null = null;
    let edges = 0;
    const open = (): Vec2[] => {
        if (current) return current;
        if (!subpathStart) throw new RangeError('Path segment before move');
        current = [subpathStart];
        contours.push(current);
        return current;
    };
    const push = (points: readonly Vec2[]) => {
        const target = open();
        for (const point of points) {
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Non-finite path vertex');
            target.push(point);
        }
        edges += points.length;
    };
    for (const command of commands) {
        switch (command[0]) {
            case 'M': {
                const start = { x: command[1], y: command[2] };
                current = [start];
                contours.push(current);
                subpathStart = start;
                break;
            }
            case 'L': {
                push([{ x: command[1], y: command[2] }]);
                break;
            }
            case 'C': {
                const last = current ? current[current.length - 1] : subpathStart;
                if (!last) throw new RangeError('Path segment before move');
                const pieces = flattenCubic({
                    p0: last,
                    p1: { x: command[1], y: command[2] },
                    p2: { x: command[3], y: command[4] },
                    p3: { x: command[5], y: command[6] },
                }, tolerance);
                // The first flattened point is the curve start, already the current point.
                push(pieces.slice(1));
                break;
            }
            case 'Z':
                // Closes the open contour; the subpath's start is kept for the segments that follow.
                current = null;
                break;
        }
        if (edges > maxEdges) return null;
    }
    return contours;
}

/** Signed fan triangulation: every polygon edge (a, b) contributes triangle (pivot, a, b) with the
 * sign of its orientation. Pivots are a contour vertex, so triangles stay near the path and share
 * the same origin-relative coordinates the paint tile already uses. */
export function pathFillTriangles(commands: readonly PathCommand[], options: PathFillOptions): PathFillTriangles | null {
    const maxEdges = options.maxEdges ?? PATH_FILL_MAX_EDGES;
    if (!Number.isSafeInteger(maxEdges) || maxEdges <= 0) throw new RangeError('Invalid path edge bound');
    const [ox, oy] = options.origin;
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) throw new RangeError('Path origin must be finite');
    const contours = flattenContours(commands, options.tolerance, maxEdges);
    if (!contours) return null;

    let total = 0;
    for (const contour of contours) total += contour.length;
    const positive = new Float64Array(total * 6), negative = new Float64Array(total * 6);
    let positiveCount = 0, negativeCount = 0, edges = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

    for (const raw of contours) {
        // Drop consecutive duplicates and an explicit closing duplicate of the first vertex.
        const points: Vec2[] = [];
        for (const point of raw) {
            const previous = points[points.length - 1];
            if (!previous || previous.x !== point.x || previous.y !== point.y) points.push(point);
        }
        if (points.length > 1 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y) points.pop();
        for (const point of points) {
            const x = point.x - ox, y = point.y - oy;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        if (points.length < 3) continue;
        // Pivot = first vertex. Edges touching the pivot give zero-area triangles, so only the edges
        // (points[i], points[i+1]) for i = 1 .. n-2 emit triangles.
        const px = points[0].x - ox, py = points[0].y - oy;
        edges += points.length;
        for (let i = 1; i + 1 < points.length; i++) {
            const ax = points[i].x - ox - px, ay = points[i].y - oy - py;
            const bx = points[i + 1].x - ox - px, by = points[i + 1].y - oy - py;
            const cross = ax * by - ay * bx;
            if (cross === 0 || !Number.isFinite(cross)) continue;
            const isPositive = cross > 0;
            const target = isPositive ? positive : negative;
            const offset = (isPositive ? positiveCount : negativeCount) * 6;
            target[offset] = px; target[offset + 1] = py;
            target[offset + 2] = points[i].x - ox; target[offset + 3] = points[i].y - oy;
            target[offset + 4] = points[i + 1].x - ox; target[offset + 5] = points[i + 1].y - oy;
            if (isPositive) positiveCount++;
            else negativeCount++;
        }
    }
    if (edges > maxEdges) return null;
    if (!Number.isFinite(x0)) {
        x0 = y0 = x1 = y1 = 0;
    }
    return {
        positive: positive.slice(0, positiveCount * 6),
        negative: negative.slice(0, negativeCount * 6),
        edges,
        bounds: { x0, y0, x1, y1 },
    };
}
