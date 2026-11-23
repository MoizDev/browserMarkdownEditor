import type { Rect } from '../../platform/types';
import type { Vec2 } from './path';
import { styleGeometryMetrics } from './styleMetrics';

// Provenance: geometry §8.5 RV-51 generic candidate and hard-admission rules;
// independently derived orthogonal routes, no third-party router/source.

/** The straight leg an elbow leaves a bound edge along: the tip gap a bound end keeps (6 × width), the arrowhead, and a shaft as
 * long as that gap, so the head does not sit on the turn. Measured at width 2: a leg of 6 × width plus the head put the head's base
 * on the corner. */
export function elbowLeg(width: number): number {
    return 12 * width + styleGeometryMetrics.openArrow(width).length;
}

export interface ElbowRequest {
    readonly start: Vec2;
    readonly end: Vec2;
    readonly mid: number;
    /** Already expanded union of terminal targets, including the caller's margin. */
    readonly escape: Readonly<Rect>;
    /** Both directions point outward from their terminal into the connector path, along a world axis. A terminal on a bound
     * edge is reached perpendicular to that edge: the route leaves or arrives along the direction for `leg` units. */
    readonly startDirection?: Vec2;
    readonly endDirection?: Vec2;
    readonly leg?: number;
    validPort(points: readonly Vec2[], terminal: 'start' | 'end'): boolean;
    crossesForbidden(points: readonly Vec2[]): boolean;
}
export type ElbowRoute = { readonly status: 'ready'; readonly points: readonly Vec2[]; readonly length: number }
    | { readonly status: 'unroutable' };
export interface ElbowStepRequest extends Omit<ElbowRequest, 'validPort' | 'crossesForbidden'> {
    validPort(points: readonly Vec2[], terminal: 'start' | 'end'): Generator<void, boolean>;
    crossesForbidden(points: readonly Vec2[]): Generator<void, boolean>;
}
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
function stepFrom(from: Vec2, direction: Vec2, distance: number): Vec2 {
    const length = Math.hypot(direction.x, direction.y);
    return { x: from.x + direction.x / length * distance, y: from.y + direction.y / length * distance };
}
/** A perpendicular leg must be a full leg long: a shorter last segment puts the arrowhead on the corner, where it points along the
 * turn instead of into the edge. Measured: a 12-unit leg at width 2 drew the head pointing down beside a left edge it was meant to enter. */
function legMatches(direction: Vec2 | undefined, from: Vec2, toward: Vec2 | undefined, leg: number | undefined): boolean {
    if (!direction) return true;
    return directionMatches(direction, from, toward) && Math.hypot(toward!.x - from.x, toward!.y - from.y) >= leg! - 1e-9;
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
export function* routeElbowSteps(request: ElbowStepRequest): Generator<void, ElbowRoute> {
    const { start, end, mid, escape } = request;
    if (!finitePoint(start) || !finitePoint(end) || !Number.isFinite(mid) || mid < 0 || mid > 1
        || !escape || ![escape.x, escape.y, escape.width, escape.height].every(Number.isFinite)
        || escape.width <= 0 || escape.height <= 0 || !Number.isFinite(escape.x + escape.width)
        || !Number.isFinite(escape.y + escape.height)
        || (request.startDirection !== undefined && !finitePoint(request.startDirection))
        || (request.endDirection !== undefined && !finitePoint(request.endDirection))
        || ((request.startDirection !== undefined || request.endDirection !== undefined) && !(request.leg !== undefined && Number.isFinite(request.leg) && request.leg > 0))
        || typeof request.validPort !== 'function' || typeof request.crossesForbidden !== 'function') throw new RangeError('Invalid elbow request');
    const x = start.x * (1 - mid) + end.x * mid, y = start.y * (1 - mid) + end.y * mid;
    const left = escape.x, right = escape.x + escape.width, top = escape.y, bottom = escape.y + escape.height;
    const startSide = Math.abs(start.x - left) <= Math.abs(start.x - right) ? left : right;
    const endSide = startSide === left ? right : left;
    const escapeY = Math.abs(start.y - top) + Math.abs(end.y - top) <= Math.abs(start.y - bottom) + Math.abs(end.y - bottom) ? top : bottom;
    const candidates: Vec2[][] = [
        [start, { x, y: start.y }, { x, y: end.y }, end],
        [start, { x: start.x, y }, { x: end.x, y }, end],
        [start, { x: startSide, y: start.y }, { x: startSide, y: escapeY },
            { x: endSide, y: escapeY }, { x: endSide, y: end.y }, end],
    ];
    // Both ways around the terminal union must be admitted before ranking;
    // the geometrically shorter side can be forbidden by a port or target.
    for (const a of [left, right]) for (const b of [left, right]) for (const outside of [top, bottom])
        candidates.push([start, { x: a, y: start.y }, { x: a, y: outside },
            { x: b, y: outside }, { x: b, y: end.y }, end]);
    for (const a of [top, bottom]) for (const b of [top, bottom]) for (const outside of [left, right])
        candidates.push([start, { x: start.x, y: a }, { x: outside, y: a },
            { x: outside, y: b }, { x: end.x, y: b }, end]);
    // A perpendicular leg is only reachable through the ports `leg` units out from each bound edge, so the routes that
    // approach a bound edge from outside are built from those ports and the lines of their union with the escape.
    if (request.startDirection !== undefined || request.endDirection !== undefined) {
        const leg = request.leg!;
        const exits = request.startDirection ? [start, stepFrom(start, request.startDirection, leg)] : [start];
        const arrivals = request.endDirection ? [end, stepFrom(end, request.endDirection, leg)] : [end];
        const ports = [...exits, ...arrivals];
        const x0 = Math.min(left, ...ports.map(p => p.x)), x1 = Math.max(right, ...ports.map(p => p.x));
        const y0 = Math.min(top, ...ports.map(p => p.y)), y1 = Math.max(bottom, ...ports.map(p => p.y));
        for (const q of exits) for (const p of arrivals) {
            const bends: Vec2[][] = [
                [{ x: p.x, y: q.y }], [{ x: q.x, y: p.y }],
                [{ x: x0, y: q.y }, { x: x0, y: p.y }], [{ x: x1, y: q.y }, { x: x1, y: p.y }],
                [{ x: q.x, y: y0 }, { x: p.x, y: y0 }], [{ x: q.x, y: y1 }, { x: p.x, y: y1 }],
            ];
            for (const bend of bends) candidates.push([start, q, ...bend, p, end]);
        }
    }
    let best: { points: Vec2[]; bends: number; length: number; id: number } | undefined;
    for (let id = 0; id < candidates.length; id++) {
        const points = simplify(candidates[id]);
        if (!points.every(finitePoint) || !legMatches(request.startDirection, points[0], points[1], request.leg)
            || !legMatches(request.endDirection, points[points.length - 1], points[points.length - 2], request.leg)) continue;
        if (!(yield* request.validPort(points, 'start')) || !(yield* request.validPort(points, 'end')) || (yield* request.crossesForbidden(points))) continue;
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

// A synchronous validator is one step of the generator-shaped request routeElbowSteps takes.
function* completed<T>(value: T): Generator<void, T> { yield; return value; }

export function routeElbow(request: ElbowRequest): ElbowRoute {
    const steps = routeElbowSteps({ ...request,
        validPort: (points, terminal) => completed(request.validPort(points, terminal)),
        crossesForbidden: points => completed(request.crossesForbidden(points)) });
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
