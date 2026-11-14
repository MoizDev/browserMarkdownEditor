import { arcToCubics } from './path';
import type { PathOp, Vec2 } from './path';
import { styleGeometryMetrics } from './styleMetrics';
import type { HeadGeometry, HeadGeometryRequest } from './connectorTypes';

/** Limit combined reserved head length to 80% of the available body, without reversing ends. */
export function connectorHeadScale(startReserve: number, endReserve: number, available: number): number {
    if (![startReserve, endReserve, available].every(Number.isFinite) || startReserve < 0 || endReserve < 0 || available < 0) {
        throw new RangeError('Invalid connector head extent');
    }
    const total = startReserve + endReserve;
    if (!Number.isFinite(total)) throw new RangeError('Connector head extent overflows');
    return total === 0 ? 1 : Math.min(1, .8 * available / total);
}

/** Independent head primitives, positioned by the forward body-to-tip direction. */
export function headGeometry(request: HeadGeometryRequest): HeadGeometry {
    const { tip, tangent, width, scale, tolerance, maxPieces, kind } = request;
    if (![tip.x, tip.y, tangent.x, tangent.y, width, scale, tolerance].every(Number.isFinite) || width < 0 || scale < 0
        || scale > 1 || tolerance <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid connector head');
    const magnitude = Math.hypot(tangent.x, tangent.y);
    if (!Number.isFinite(magnitude)) throw new RangeError('Connector tangent overflows');
    const degenerateTangent = magnitude === 0;
    const ux = degenerateTangent ? 1 : tangent.x / magnitude, uy = degenerateTangent ? 0 : tangent.y / magnitude;
    const metric = styleGeometryMetrics.openArrow(width);
    const length = metric.length * scale, halfSpan = metric.halfSpan * scale;
    const point = (x: number, y: number): Vec2 => {
        const p = { x: tip.x + ux * x - uy * y, y: tip.y + uy * x + ux * y };
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError('Connector head coordinate overflows');
        return p;
    };
    const shape = (points: readonly Vec2[], closed: boolean): HeadGeometry => {
        const path: PathOp[] = [{ op: 'M', p: points[0] }, ...points.slice(1).map((p): PathOp => ({ op: 'L', p }))];
        if (closed) path.push({ op: 'Z' });
        return { paths: [path], closed, reserve: length, degenerateTangent };
    };
    switch (kind) {
        case 'none': return { paths: [], closed: false, reserve: 0, degenerateTangent };
        case 'arrow': return shape([point(-length, -halfSpan), tip, point(-length, halfSpan)], false);
        case 'triangle': return shape([tip, point(-length, halfSpan), point(-length, -halfSpan)], true);
        case 'inverted': return shape([point(0, -halfSpan), point(0, halfSpan), point(-length, 0)], true);
        case 'square': return shape([point(-length, -length / 2), point(0, -length / 2), point(0, length / 2), point(-length, length / 2)], true);
        case 'diamond': return shape([tip, point(-length / 2, halfSpan), point(-length, 0), point(-length / 2, -halfSpan)], true);
        case 'pipe': return shape([point(0, -halfSpan), point(0, halfSpan)], false);
        case 'bar': {
            const halfWidth = width * scale / 2;
            return shape([point(-halfWidth, -halfSpan), point(halfWidth, -halfSpan),
                point(halfWidth, halfSpan), point(-halfWidth, halfSpan)], true);
        }
        case 'dot': {
            const center = point(-length / 2, 0);
            const path = [...arcToCubics({ centre: center, radius: length / 2, start: 0, sweep: 2 * Math.PI }, tolerance, maxPieces), { op: 'Z' } as const];
            return { paths: [path], closed: true, reserve: length, degenerateTangent };
        }
        default: throw new RangeError('Unsupported connector head');
    }
}
