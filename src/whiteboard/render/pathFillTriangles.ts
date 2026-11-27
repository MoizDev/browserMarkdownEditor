import type { PathCommand } from '../../platform/types';
import { PATH_COVERAGE_STENCIL_MAX_EDGES } from '../../platform/render/pathCoverage';
import { flattenCubic } from '../geom/flatten';
import type { Vec2 } from '../geom/path';

export const PATH_FILL_MAX_EDGES = 65_536;
export { PATH_COVERAGE_STENCIL_MAX_EDGES as PATH_FILL_STENCIL_MAX_EDGES };

export interface PathFillOptions {
    readonly tolerance: number;
    readonly origin: readonly [x: number, y: number];
    readonly maxEdges?: number;
}

export interface PathFillTriangles {
    readonly positive: Float64Array;
    readonly negative: Float64Array;
    readonly edges: number;
    readonly bounds: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
}

export function flattenContours(commands: readonly PathCommand[], tolerance: number, maxEdges: number): Vec2[][] | null {
    if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new RangeError('Invalid path flattening tolerance');
    const contours: Vec2[][] = [];
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
                push(pieces.slice(1));
                break;
            }
            case 'Z':
                current = null;
                break;
        }
        if (edges > maxEdges) return null;
    }
    return contours;
}

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
