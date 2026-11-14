import { arcToCubics } from './path';
import type { PathOp, Vec2 } from './path';
import type { ConnectorBody } from './connectorTypes';

/** Bend is the signed sagitta, not a saved centre or a pixel-space offset. */
export function connectorBody(start: Vec2, end: Vec2, bend: number, straightTolerance: number): ConnectorBody {
    if (![start.x, start.y, end.x, end.y, bend, straightTolerance].every(Number.isFinite) || straightTolerance < 0) {
        throw new RangeError('Invalid connector body');
    }
    const dx = end.x - start.x, dy = end.y - start.y, chord = Math.hypot(dx, dy);
    if (!Number.isFinite(chord)) throw new RangeError('Connector chord overflows');
    if (chord === 0 || Math.abs(bend) <= straightTolerance) return { kind: 'line', start, end, length: chord };
    const nx = -dy / chord, ny = dx / chord;
    const offset = bend / 2 - chord * (chord / 8 / bend);
    const center = { x: start.x + dx / 2 + nx * offset, y: start.y + dy / 2 + ny * offset };
    const radius = Math.hypot(chord / 2, offset), startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const sweep = -Math.sign(bend) * 4 * Math.atan2(Math.abs(bend), chord / 2);
    const length = radius * Math.abs(sweep);
    if (![center.x, center.y, radius, startAngle, sweep, length].every(Number.isFinite)) throw new RangeError('Connector arc overflows');
    return { kind: 'arc', start, end, length, arc: { centre: center, radius, start: startAngle, sweep } };
}

export function connectorBodyPoint(body: ConnectorBody, parameter: number): Vec2 {
    if (!Number.isFinite(parameter) || parameter < 0 || parameter > 1) throw new RangeError('Invalid connector parameter');
    if (parameter === 0) return body.start;
    if (parameter === 1) return body.end;
    if (body.kind === 'line') return { x: body.start.x + (body.end.x - body.start.x) * parameter,
        y: body.start.y + (body.end.y - body.start.y) * parameter };
    const angle = body.arc.start + body.arc.sweep * parameter;
    return { x: body.arc.centre.x + body.arc.radius * Math.cos(angle), y: body.arc.centre.y + body.arc.radius * Math.sin(angle) };
}

export function connectorBodyTangent(body: ConnectorBody, parameter: number): Readonly<{ vector: Vec2; degenerate: boolean }> {
    if (!Number.isFinite(parameter) || parameter < 0 || parameter > 1) throw new RangeError('Invalid connector parameter');
    if (body.kind === 'line') {
        if (body.length === 0) return { vector: { x: 1, y: 0 }, degenerate: true };
        return { vector: { x: (body.end.x - body.start.x) / body.length, y: (body.end.y - body.start.y) / body.length }, degenerate: false };
    }
    const angle = body.arc.start + body.arc.sweep * parameter, direction = Math.sign(body.arc.sweep);
    return { vector: { x: -Math.sin(angle) * direction, y: Math.cos(angle) * direction }, degenerate: false };
}

export function connectorBodyPath(body: ConnectorBody, tolerance: number, maxPieces: number): readonly PathOp[] {
    if (!Number.isFinite(tolerance) || tolerance <= 0 || !Number.isSafeInteger(maxPieces) || maxPieces < 1) throw new RangeError('Invalid connector path budget');
    if (body.kind === 'line') return [{ op: 'M', p: body.start }, { op: 'L', p: body.end }];
    return arcToCubics(body.arc, tolerance, maxPieces);
}
