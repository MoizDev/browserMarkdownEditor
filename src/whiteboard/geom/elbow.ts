import type { Rect } from '../../platform/types';
import type { Vec2 } from './path';

// Provenance: geometry §8.5 RV-51 generic candidate and hard-admission rules;
// independently derived orthogonal routes, no third-party router/source.
export interface ElbowRequest {
    readonly start: Vec2;
    readonly end: Vec2;
    readonly mid: number;
    /** Already expanded union of terminal targets, including the caller's margin. */
    readonly escape: Readonly<Rect>;
    /** Both directions point outward from their terminal into the connector path. */
    readonly startDirection?: Vec2;
    readonly endDirection?: Vec2;
    validPort(points: readonly Vec2[], terminal: 'start' | 'end'): boolean;
    crossesForbidden(points: readonly Vec2[]): boolean;
}
export type ElbowRoute = { readonly status: 'ready'; readonly points: readonly Vec2[]; readonly length: number }
    | { readonly status: 'unroutable' };
function finitePoint(p: Vec2): boolean { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y); }
function simplify(input: readonly Vec2[]): Vec2[] {
    const result: Vec2[] = [];
    for (const p of input) {
        const last = result[result.length - 1];
        if (last && last.x === p.x && last.y === p.y) continue;
        while (result.length >= 2) {
            const a = result[result.length - 2], b = result[result.length - 1];
            const sameX = a.x === b.x && b.x === p.x && (b.y - a.y) * (p.y - b.y) > 0;
            const sameY = a.y === b.y && b.y === p.y && (b.x - a.x) * (p.x - b.x) > 0;
            if (!sameX && !sameY) break;
            result.pop();
        }
        result.push({ x: p.x, y: p.y });
    }
    return result;
}
function directionMatches(direction: Vec2 | undefined, from: Vec2, toward: Vec2 | undefined): boolean {
    if (!direction) return true;
    if (!toward) return false;
    const dx = toward.x - from.x, dy = toward.y - from.y;
    // No normalization: zero tangents cannot prove a valid exit.
    if ((direction.x === 0 && direction.y === 0) || (dx === 0 && dy === 0)) return false;
    const cross = direction.x * dy - direction.y * dx, dot = direction.x * dx + direction.y * dy;
    return Number.isFinite(cross) && Number.isFinite(dot) && dot > 0
        && Math.abs(cross) <= 1e-12 * Math.hypot(direction.x, direction.y) * Math.hypot(dx, dy);
}

/** No least-bad fallback: terminal and target checks admit before any ranking. */
export function routeElbow(request: ElbowRequest): ElbowRoute {
    const { start, end, mid, escape } = request;
    if (!finitePoint(start) || !finitePoint(end) || !Number.isFinite(mid) || mid < 0 || mid > 1
        || !escape || ![escape.x, escape.y, escape.width, escape.height].every(Number.isFinite)
        || escape.width <= 0 || escape.height <= 0 || !Number.isFinite(escape.x + escape.width)
        || !Number.isFinite(escape.y + escape.height)
        || (request.startDirection !== undefined && !finitePoint(request.startDirection))
        || (request.endDirection !== undefined && !finitePoint(request.endDirection))
        || typeof request.validPort !== 'function' || typeof request.crossesForbidden !== 'function') throw new RangeError('Invalid elbow request');
    const x = start.x * (1 - mid) + end.x * mid, y = start.y * (1 - mid) + end.y * mid;
    const left = escape.x, right = escape.x + escape.width, top = escape.y, bottom = escape.y + escape.height;
    const startSide = Math.abs(start.x - left) <= Math.abs(start.x - right) ? left : right;
    const endSide = startSide === left ? right : left;
    const escapeY = Math.abs(start.y - top) + Math.abs(end.y - top) <= Math.abs(start.y - bottom) + Math.abs(end.y - bottom) ? top : bottom;
    const candidates: readonly (readonly Vec2[])[] = [
        [start, { x, y: start.y }, { x, y: end.y }, end],
        [start, { x: start.x, y }, { x: end.x, y }, end],
        [start, { x: startSide, y: start.y }, { x: startSide, y: escapeY },
            { x: endSide, y: escapeY }, { x: endSide, y: end.y }, end],
    ];
    let best: { points: Vec2[]; bends: number; length: number; id: number } | undefined;
    for (let id = 0; id < candidates.length; id++) {
        const points = simplify(candidates[id]);
        if (!points.every(finitePoint) || !directionMatches(request.startDirection, points[0], points[1])
            || !directionMatches(request.endDirection, points[points.length - 1], points[points.length - 2])
            || !request.validPort(points, 'start') || !request.validPort(points, 'end') || request.crossesForbidden(points)) continue;
        let length = 0;
        for (let i = 1; i < points.length; i++) length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
        if (!Number.isFinite(length)) continue;
        const bends = Math.max(0, points.length - 2);
        if (!best || bends < best.bends || (bends === best.bends && (length < best.length || (length === best.length && id < best.id)))) {
            best = { points, bends, length, id };
        }
    }
    if (!best) return { status: 'unroutable' };
    return { status: 'ready', points: best.points, length: best.length };
}
