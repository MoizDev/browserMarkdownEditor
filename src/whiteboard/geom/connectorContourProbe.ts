import { dyadic, dyadicSubtract, type Dyadic } from './numeric';
import { createFillPointJob } from './fillPoint';
import { createCubicBoundaryJob } from './cubicBoundaryJob';
import { connectorBody } from './connectors';
import { bodyCrossingSteps } from './connectorPath';
import type { AttachmentSurface } from './connectorTypes';
import type { ExactPoint } from './homogeneous';
import type { Vec2 } from './path';

export interface ConnectorInsideInterval { readonly from: number; readonly to: number }
function midpoint(a: number, b: number): Dyadic {
    const sum = dyadicSubtract(dyadic(a), { n: -dyadic(b).n, e: dyadic(b).e }); return { n: sum.n, e: sum.e - 1 };
}
function exactMiddle(a: Vec2, b: Vec2): ExactPoint { return { x: midpoint(a.x, b.x), y: midpoint(a.y, b.y), w: { n: 1n, e: 0 } }; }

export function* connectorSurfaceContains(surface: AttachmentSurface, point: Vec2, maxPieces: number,
    exact?: ExactPoint): Generator<void, boolean> {
    if (![point.x, point.y].every(Number.isFinite) || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid connector surface point');
    for (const contour of [surface, ...surface.clips]) {
        const fill = createFillPointJob([contour.outline], point, 'nonzero', { localToWorld: contour.localToWorld, exactPoint: exact, maxCommands: maxPieces });
        let status: 'inside' | 'outside' | 'uncertain';
        for (;;) {
            const result = fill.step({ deadline: performance.now() + 3, maxWork: 1 });
            if (result.status === 'pending') { yield; continue; }
            status = result.status; break;
        }
        if (status === 'outside') return false;
        if (status === 'uncertain') {
            if (exact) throw new RangeError('Connector midpoint lies on an uncertified contour boundary');
            const boundary = createCubicBoundaryJob([contour.outline], point, contour.localToWorld, { maxCommands: maxPieces });
            try {
                for (;;) {
                    const result = boundary.step({ deadline: performance.now() + 3, maxWork: 1 });
                    if (result.status === 'pending') { yield; continue; }
                    if (result.status !== 'hit') throw new RangeError('Connector point containment cannot be certified');
                    break;
                }
            } finally { boundary.cancel(); }
        }
        yield;
    }
    return true;
}

export function* connectorSurfaceIntervals(surface: AttachmentSurface, points: readonly Vec2[], error: number,
    maxPieces: number): Generator<void, { readonly parts: readonly ConnectorInsideInterval[]; readonly length: number }> {
    if (!points.length || !Number.isFinite(error) || error <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1)
        throw new RangeError('Invalid connector route containment');
    const parts: { from: number; to: number }[] = []; let offset = 0;
    const append = (from: number, to: number) => {
        if (!(from < to)) return;
        const previous = parts[parts.length - 1];
        if (previous && from <= previous.to) previous.to = Math.max(previous.to, to);
        else { if (parts.length >= maxPieces) throw new RangeError('Connector route interval budget exhausted'); parts.push({ from, to }); }
    };
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], body = connectorBody(a, b, 0, error), length = body.length;
        if (!Number.isFinite(length)) throw new RangeError('Connector route length overflows');
        if (!length) { yield; continue; }
        const crossings = yield* bodyCrossingSteps(body, surface, error, maxPieces);
        let inside: boolean;
        if (crossings.length) inside = !crossings[0].entering;
        else {
            const centre = exactMiddle(a, b), approximate = { x: a.x / 2 + b.x / 2, y: a.y / 2 + b.y / 2 };
            inside = yield* connectorSurfaceContains(surface, approximate, maxPieces, centre);
        }
        let start: number | undefined = inside ? offset : undefined, previous = 0;
        for (const crossing of crossings) {
            if (!(crossing.distance > previous && crossing.distance < length) || crossing.entering === inside)
                throw new RangeError('Connector route crossing sequence is ambiguous');
            if (crossing.entering) start = offset + crossing.distance;
            else { if (start === undefined) throw new RangeError('Connector route exit has no entry'); append(start, offset + crossing.distance); start = undefined; }
            inside = crossing.entering; previous = crossing.distance; yield;
        }
        if (inside && start !== undefined) append(start, offset + length);
        offset += length; if (!Number.isFinite(offset)) throw new RangeError('Connector route length overflows'); yield;
    }
    return { parts: Object.freeze(parts.map(part => Object.freeze(part))), length: offset };
}
