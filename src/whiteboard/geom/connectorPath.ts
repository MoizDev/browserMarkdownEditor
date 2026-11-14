import type { Affine } from '../../platform/types';
import { inverse, transformPoint } from './affine';
import { ContourClipper, type ClipInterval } from './clip';
import type { AttachmentSurface, ConnectorBody } from './connectorTypes';
import { connectorBodyPoint, connectorBodyTangent } from './connectors';
import { arcToCubics, type PathOp, type Vec2 } from './path';
import { areSimpleConnectorPolygons, exactConnectorLineCrossings } from './connectorExactClip';

export function bodyLength(body: ConnectorBody): number {
    if (!Number.isFinite(body.length) || body.length < 0) throw new RangeError('Invalid connector body length');
    return body.length;
}
function parameter(body: ConnectorBody, distance: number): number {
    const length = bodyLength(body);
    if (!Number.isFinite(distance) || distance < 0 || distance > length) throw new RangeError('Invalid connector body distance');
    return length ? distance / length : 0;
}
export function pointAtLength(body: ConnectorBody, distance: number): Vec2 {
    return connectorBodyPoint(body, parameter(body, distance));
}
export function tangentAtLength(body: ConnectorBody, distance: number, direction: 1 | -1): Readonly<{ vector: Vec2; degenerate: boolean }> {
    if (direction !== 1 && direction !== -1) throw new RangeError('Invalid tangent direction');
    const t = parameter(body, distance);
    if (!body.length) return { vector: { x: direction, y: 0 }, degenerate: true };
    const tangent = connectorBodyTangent(body, t);
    return { vector: { x: tangent.vector.x * direction, y: tangent.vector.y * direction }, degenerate: tangent.degenerate };
}
export function trimBodyPath(body: ConnectorBody, fromDistance: number, toDistance: number, error: number, maxPieces: number): readonly PathOp[] {
    const from = parameter(body, fromDistance), to = parameter(body, toDistance);
    if (from > to || !Number.isFinite(error) || error <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) {
        throw new RangeError('Invalid connector body trim');
    }
    const start = pointAtLength(body, fromDistance), end = pointAtLength(body, toDistance);
    if (body.kind === 'line' || from === to) return [{ op: 'M', p: start }, { op: 'L', p: end }];
    const path = [...arcToCubics({ ...body.arc, start: body.arc.start + body.arc.sweep * from,
        sweep: body.arc.sweep * (to - from) }, error, maxPieces)];
    path[0] = { op: 'M', p: start };
    const last = path[path.length - 1];
    if (last.op !== 'C') throw new Error('Invalid connector arc path');
    path[path.length - 1] = { ...last, p: end };
    return path;
}

type Surface = Readonly<{ clipper: ContourClipper; inverse: Affine }>;
function clipped(start: Vec2, end: Vec2, surfaces: readonly Surface[], maxPieces: number): ClipInterval[] {
    let intervals: ClipInterval[] = [{ from: 0, to: 1 }];
    for (const surface of surfaces) {
        const local = surface.clipper.clip(transformPoint(surface.inverse, start), transformPoint(surface.inverse, end));
        const next: ClipInterval[] = [];
        let a = 0, b = 0;
        while (a < intervals.length && b < local.length) {
            const from = Math.max(intervals[a].from, local[b].from), to = Math.min(intervals[a].to, local[b].to);
            if (from < to) {
                if (next.length >= maxPieces) throw new RangeError('Connector contour interval budget exhausted');
                next.push({ from, to });
            }
            if (intervals[a].to < local[b].to) a++; else b++;
        }
        intervals = next;
        if (!intervals.length) break;
    }
    return intervals;
}

/** Crossings are state changes, not synthetic entry/exit events at body endpoints. */
export function* bodyCrossingSteps(body: ConnectorBody, surface: AttachmentSurface, error: number, maxPieces: number):
    Generator<void, readonly { distance: number; entering: boolean }[]> {
    const length = bodyLength(body);
    if (!Number.isFinite(error) || error <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid connector crossing budget');
    const surfaces: Surface[] = [];
    for (const entry of [surface, ...surface.clips]) {
        const transform = inverse(entry.localToWorld, 1e12);
        if (!transform) throw new RangeError('Connector attachment transform is singular or ill-conditioned');
        surfaces.push({ clipper: new ContourClipper([entry.outline], maxPieces), inverse: transform });
        yield;
    }
    if (!length) return Object.freeze([]);
    const result: { distance: number; entering: boolean }[] = [];
    const add = (distance: number, entering: boolean) => {
        if (result.length >= maxPieces) throw new RangeError('Connector crossing budget exhausted');
        result.push({ distance, entering });
    };
    if (body.kind === 'line') {
        const contours = [surface, ...surface.clips];
        if (yield* areSimpleConnectorPolygons(contours)) return yield* exactConnectorLineCrossings(body.start, body.end, length, contours, error, maxPieces);
        const intervals = clipped(body.start, body.end, surfaces, maxPieces);
        for (let i = 0; i < intervals.length; i++) {
            const interval = intervals[i];
            if (interval.from > 0) add(interval.from * length, true);
            if (interval.to < 1) add(interval.to * length, false);
            yield;
        }
        return Object.freeze(result);
    }
    const radius = body.arc.radius, sweep = Math.abs(body.arc.sweep);
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(sweep) || !sweep) throw new RangeError('Invalid connector arc');
    // 2r sin²(theta/4) bounds sagitta without subtracting nearly equal values.
    const angle = Math.min(Math.PI / 2, 4 * Math.asin(Math.sqrt(Math.min(1, error / radius / 2))));
    const pieces = Math.ceil(sweep / angle);
    if (!Number.isSafeInteger(pieces) || pieces < 1 || pieces > maxPieces) throw new RangeError('Connector arc crossing budget exhausted');
    const inside = (distance: number): boolean => {
        const point = pointAtLength(body, distance);
        for (const entry of surfaces) if (!entry.clipper.contains(transformPoint(entry.inverse, point))) return false;
        return true;
    };
    let previousDistance = 0, previousInside = inside(0);
    const probe = function* (distance: number): Generator<void, void> {
        yield;
        const nextInside = inside(distance);
        if (nextInside !== previousInside) {
            let low = previousDistance, high = distance;
            while (high - low > error) {
                yield;
                const middle = low + (high - low) / 2;
                if (middle === low || middle === high) break;
                if (inside(middle) === previousInside) low = middle; else high = middle;
            }
            const crossing = low + (high - low) / 2;
            if (crossing > 0 && crossing < length) add(crossing, nextInside);
        }
        previousDistance = distance; previousInside = nextInside;
    };
    for (let i = 0; i < pieces; i++) {
        yield;
        const a = length * (i / pieces), b = length * ((i + 1) / pieces);
        const intervals = clipped(pointAtLength(body, a), pointAtLength(body, b), surfaces, maxPieces);
        let previous = 0;
        for (const interval of intervals) {
            if (interval.from > previous) yield* probe(a + (b - a) * ((previous + interval.from) / 2));
            yield* probe(a + (b - a) * ((interval.from + interval.to) / 2));
            previous = interval.to;
        }
        if (previous < 1) yield* probe(a + (b - a) * ((previous + 1) / 2));
        yield* probe(b);
    }
    // Two observed state changes remain distinct even when their separation is
    // below the crossing tolerance; short real interior runs are not tangencies.
    const frozen: { readonly distance: number; readonly entering: boolean }[] = [];
    for (const item of result) { frozen.push(Object.freeze(item)); yield; }
    return Object.freeze(frozen);
}

export async function bodyCrossings(body: ConnectorBody, surface: AttachmentSurface, error: number, maxPieces: number,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<readonly { distance: number; entering: boolean }[]> {
    const steps = bodyCrossingSteps(body, surface, error, maxPieces);
    let count = 0, started = performance.now();
    signal?.throwIfAborted();
    for (;;) {
        const next = steps.next();
        if (next.done) { signal?.throwIfAborted(); return next.value; }
        if (++count >= 256 || performance.now() - started >= 3) {
            signal?.throwIfAborted();
            await (cooperate?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0)));
            signal?.throwIfAborted(); count = 0; started = performance.now();
        }
    }
}
