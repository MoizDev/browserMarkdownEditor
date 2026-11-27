import type { AttachmentSurface, ConnectorBody } from './connectorTypes';
import { connectorBodyPoint, connectorBodyTangent } from './connectors';
import { arcToCubics, type PathOp, type Vec2 } from './path';
import { areSimpleConnectorPolygons, exactConnectorLineCrossings } from './connectorExactClip';
import { curvedConnectorLineCrossings } from './connectorCurveClip';
import { connectorCircleBoundaryDisjoint } from './connectorCirclePreflight';
import { certifiedConnectorArcCrossings } from './connectorArcClip';
import { yieldToHost } from '../../platform/yieldToHost';

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

export function* bodyCrossingSteps(body: ConnectorBody, surface: AttachmentSurface, error: number, maxPieces: number):
    Generator<void, readonly { distance: number; entering: boolean }[]> {
    const length = bodyLength(body);
    if (!Number.isFinite(error) || error <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid connector crossing budget');
    if (!length) return Object.freeze([]);
    if (body.kind === 'line') {
        const contours = [surface, ...surface.clips];
        if (yield* areSimpleConnectorPolygons(contours)) return yield* exactConnectorLineCrossings(body.start, body.end, length, contours, error, maxPieces);
        return yield* curvedConnectorLineCrossings(body.start, body.end, length, contours, error, maxPieces);
    }
    const radius = body.arc.radius, sweep = Math.abs(body.arc.sweep);
    if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(sweep) || !sweep) throw new RangeError('Invalid connector arc');
    if (yield* connectorCircleBoundaryDisjoint(body.arc.centre, radius, [surface, ...surface.clips], error, maxPieces)) return Object.freeze([]);
    return yield* certifiedConnectorArcCrossings(body.arc, length, [surface, ...surface.clips], error, maxPieces);
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
            await (cooperate?.() ?? yieldToHost());
            signal?.throwIfAborted(); count = 0; started = performance.now();
        }
    }
}
