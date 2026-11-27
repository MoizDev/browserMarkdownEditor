import type { ConnectorNode } from '../model/nodes';
import { connectorBody } from './connectors';
import type { ConnectorBody, ConnectorGeometry } from './connectorTypes';
import type { Vec2 } from './path';
import { styleGeometryMetrics } from './styleMetrics';

export interface ConnectorLabelProjection {
    readonly fraction: number;
    readonly distance: number;
    readonly point: Vec2;
    readonly degenerate: boolean;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function finitePoint(point: Vec2): void { if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Invalid connector projection point'); }
function nearestSegment(point: Vec2, a: Vec2, b: Vec2): { t: number; distance: number; length: number; point: Vec2 } {
    finitePoint(a); finitePoint(b);
    const dx = b.x - a.x, dy = b.y - a.y, px = point.x - a.x, py = point.y - a.y;
    if (![dx, dy, px, py].every(Number.isFinite)) throw new RangeError('Connector projection overflows');
    const length = Math.hypot(dx, dy), scale = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(px), Math.abs(py));
    if (!Number.isFinite(length)) throw new RangeError('Connector segment length overflows');
    let t = 0;
    if (length && scale) {
        const x = dx / scale, y = dy / scale, u = px / scale, v = py / scale, denominator = x * x + y * y;
        if (!denominator) throw new RangeError('Connector segment projection underflows');
        t = clamp((u * x + v * y) / denominator);
    }
    const nearest = { x: a.x + dx * t, y: a.y + dy * t }, distance = Math.hypot(point.x - nearest.x, point.y - nearest.y);
    if (![t, nearest.x, nearest.y, distance].every(Number.isFinite)) throw new RangeError('Connector projection overflows');
    return { t, distance, length, point: nearest };
}
const tau = 2 * Math.PI;
function modulo(value: number): number { const remainder = value % tau; return remainder < 0 ? remainder + tau : remainder; }
function arcParameter(body: Extract<ConnectorBody, { kind: 'arc' }>, point: Vec2): { t: number; degenerate: boolean } {
    const { centre, start, sweep } = body.arc, x = point.x - centre.x, y = point.y - centre.y, magnitude = Math.abs(sweep);
    if (![x, y, start, sweep, magnitude].every(Number.isFinite) || magnitude > tau + 1e-12) throw new RangeError('Invalid connector arc projection');
    if (!magnitude || (!x && !y)) return { t: 0, degenerate: true };
    const angle = modulo(Math.atan2(y, x)), origin = modulo(start);
    const forward = sweep >= 0 ? modulo(angle - origin) : modulo(origin - angle);
    if (forward <= magnitude) return { t: clamp(forward / magnitude), degenerate: false };
    const first = Math.hypot(point.x - body.start.x, point.y - body.start.y), last = Math.hypot(point.x - body.end.x, point.y - body.end.y);
    if (!Number.isFinite(first) || !Number.isFinite(last)) throw new RangeError('Connector arc projection overflows');
    return { t: first <= last ? 0 : 1, degenerate: false };
}
function parameter(body: ConnectorBody, point: Vec2): { t: number; degenerate: boolean } {
    return body.kind === 'line' ? { t: nearestSegment(point, body.start, body.end).t, degenerate: !body.length } : arcParameter(body, point);
}
function pointOnBody(body: ConnectorBody, t: number): Vec2 {
    if (body.kind === 'line') return { x: body.start.x + (body.end.x - body.start.x) * t, y: body.start.y + (body.end.y - body.start.y) * t };
    const angle = body.arc.start + body.arc.sweep * t;
    return { x: body.arc.centre.x + body.arc.radius * Math.cos(angle), y: body.arc.centre.y + body.arc.radius * Math.sin(angle) };
}
function elbowProjection(geometry: ConnectorGeometry, point: Vec2, fallback: number): ConnectorLabelProjection {
    const points: Vec2[] = [geometry.start.tipWorld];
    for (const op of geometry.body) {
        if (op.op !== 'M' && op.op !== 'L') throw new RangeError('Elbow connector body is not a polyline');
        const previous = points[points.length - 1];
        if (previous.x !== op.p.x || previous.y !== op.p.y) points.push(op.p);
    }
    const end = geometry.end.tipWorld, previous = points[points.length - 1];
    if (previous.x !== end.x || previous.y !== end.y) points.push(end);
    let total = 0, bestDistance = Infinity, bestAlong = 0, bestPoint = points[0];
    for (let i = 1; i < points.length; i++) {
        const candidate = nearestSegment(point, points[i - 1], points[i]);
        if (candidate.distance < bestDistance) { bestDistance = candidate.distance; bestAlong = total + candidate.t * candidate.length; bestPoint = candidate.point; }
        total += candidate.length;
        if (!Number.isFinite(total) || !Number.isFinite(bestAlong)) throw new RangeError('Elbow connector length overflows');
    }
    if (!total) {
        const distance = Math.hypot(point.x - end.x, point.y - end.y);
        if (!Number.isFinite(distance)) throw new RangeError('Elbow connector projection overflows');
        return { fraction: fallback, distance, point: end, degenerate: true };
    }
    return { fraction: clamp(bestAlong / total), distance: bestDistance, point: bestPoint, degenerate: false };
}

export function projectConnectorLabel(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, point: Vec2, snapWorld?: number): ConnectorLabelProjection {
    finitePoint(point);
    const fallback = typeof node.labelAt === 'number' && Number.isFinite(node.labelAt) ? clamp(node.labelAt) : 0.5;
    if (node.route === 'elbow') return elbowProjection(geometry, point, fallback);
    const metric = styleGeometryMetrics.bendThreshold(node.size, node.width);
    const threshold = metric.status === 'bracket' ? metric.min : metric.status === 'provisional' ? metric.value : node.width * 3;
    if (!Number.isFinite(threshold)) throw new RangeError('Connector bend threshold overflows');
    const body = connectorBody(geometry.start.aimWorld, geometry.end.aimWorld, Math.abs(node.bend) <= threshold ? 0 : node.bend, 0.01);
    const a = parameter(body, geometry.start.tipWorld), b = parameter(body, geometry.end.tipWorld), sample = parameter(body, point);
    if (a.degenerate || b.degenerate || sample.degenerate || !(b.t > a.t)) {
        const at = pointOnBody(body, a.t + (b.t - a.t) * fallback), distance = Math.hypot(point.x - at.x, point.y - at.y);
        if (![at.x, at.y, distance].every(Number.isFinite)) throw new RangeError('Connector label projection overflows');
        return { fraction: fallback, point: at, distance, degenerate: true };
    }
    let fraction = clamp((sample.t - a.t) / (b.t - a.t)), at = pointOnBody(body, a.t + (b.t - a.t) * fraction);
    if (snapWorld !== undefined && Number.isFinite(snapWorld)) {
        const centre = pointOnBody(body, a.t + (b.t - a.t) / 2);
        if (Math.hypot(at.x - centre.x, at.y - centre.y) <= snapWorld) { fraction = 0.5; at = centre; }
    }
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (![at.x, at.y, distance, fraction].every(Number.isFinite)) throw new RangeError('Connector label projection overflows');
    return { fraction, point: at, distance, degenerate: false };
}
