import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { ConnectorNode } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import { connectorBody } from './connectors';
import type { ConnectorBody, ConnectorGeometry } from './connectorTypes';
import type { Vec2 } from './path';
import { styleGeometryMetrics } from './styleMetrics';

export type ConnectorControl = 'bend' | 'elbow' | 'label';
export interface ConnectorControlOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly control: ConnectorControl;
    readonly point: Vec2;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface ConnectorControlPreview {
    readonly ops: readonly NodeSetOp[];
    readonly doc: BoardRuntime['session']['doc'];
    commit(): void;
    release(): void;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function nearestSegment(point: Vec2, a: Vec2, b: Vec2): { t: number; distance: number; length: number } {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const t = length ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length)) : 0;
    return { t, distance: Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t), length };
}
function bodyParameter(body: ConnectorBody, point: Vec2): number {
    if (body.kind === 'line') return nearestSegment(point, body.start, body.end).t;
    const { centre, start, sweep } = body.arc, angle = Math.atan2(point.y - centre.y, point.x - centre.x), tau = Math.PI * 2;
    const forward = sweep >= 0 ? (angle - start + tau) % tau : (start - angle + tau) % tau, magnitude = Math.abs(sweep);
    if (forward <= magnitude) return magnitude ? forward / magnitude : 0;
    return Math.hypot(point.x - body.start.x, point.y - body.start.y) <= Math.hypot(point.x - body.end.x, point.y - body.end.y) ? 0 : 1;
}
function labelAt(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, point: Vec2): number {
    if (node.route === 'elbow') {
        const points: Vec2[] = [geometry.start.tipWorld];
        for (const op of geometry.body) if (op.op === 'M' || op.op === 'L') {
            const prior = points[points.length - 1]; if (prior.x !== op.p.x || prior.y !== op.p.y) points.push(op.p);
        }
        points.push(geometry.end.tipWorld);
        let total = 0, bestDistance = Infinity, bestAlong = 0;
        for (let i = 1; i < points.length; i++) {
            const hit = nearestSegment(point, points[i - 1], points[i]);
            if (hit.distance < bestDistance) { bestDistance = hit.distance; bestAlong = total + hit.t * hit.length; }
            total += hit.length;
        }
        return total ? clamp(bestAlong / total) : 0.5;
    }
    const metric = styleGeometryMetrics.bendThreshold(node.size, node.width);
    const threshold = metric.status === 'bracket' ? metric.min : metric.status === 'provisional' ? metric.value : node.width * 3;
    const body = connectorBody(geometry.start.aimWorld, geometry.end.aimWorld, Math.abs(node.bend) <= threshold ? 0 : node.bend, 0.01);
    const a = bodyParameter(body, geometry.start.tipWorld), b = bodyParameter(body, geometry.end.tipWorld), t = bodyParameter(body, point);
    return b > a ? clamp((t - a) / (b - a)) : 0.5;
}
function controlValue(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, control: ConnectorControl, point: Vec2): NodeSetOp {
    const a = geometry.start.aimWorld, b = geometry.end.aimWorld, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (control === 'label') return { t: 'set', id: node.id, key: 'labelAt', value: labelAt(node, geometry, point) };
    if (control === 'elbow') {
        // Default, calibration cut by owner: the dominant route axis controls the elbow midpoint.
        const value = Math.abs(dx) >= Math.abs(dy) ? (dx ? (point.x - a.x) / dx : 0.5) : (dy ? (point.y - a.y) / dy : 0.5);
        return { t: 'set', id: node.id, key: 'elbowMid', value: clamp(value) };
    }
    const bend = length ? ((point.x - (a.x + b.x) / 2) * -dy + (point.y - (a.y + b.y) / 2) * dx) / length : 0;
    return { t: 'set', id: node.id, key: 'bend', value: Math.max(-1_000_000, Math.min(1_000_000, bend)) };
}

/** The source and staged geometry stay pinned until commit or explicit release. */
export async function prepareConnectorControl(options: ConnectorControlOptions): Promise<ConnectorControlPreview> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    let epoch: number | undefined, released = false;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && !session.isReadOnly && runtime.selection.getSnapshot() === selection
        && (epoch === undefined || runtime.render.text.fonts.epoch === epoch);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Connector control became stale', 'AbortError'); };
    if (![options.point.x, options.point.y].every(Number.isFinite) || !['bend', 'elbow', 'label'].includes(options.control)) throw new RangeError('Invalid connector control');
    check(); const node = doc.nodes.get(options.id);
    if (!node || node.kind !== 'connector' || isLocked(doc, node)) throw new Error('Connector control is not editable');
    const source = await acquireBoardGeometryScope(runtime, [node.id], { signal, current, cooperate: options.cooperate });
    let final: BoardGeometryScope | undefined;
    try {
        check(); epoch = runtime.render.text.fonts.epoch;
        const prepared = await runtime.render.prepareForPick(node, signal, doc); check();
        if (!prepared.connector) throw new Error('Connector geometry is unavailable');
        const ops: NodeSetOp[] = [controlValue(node, prepared.connector, options.control, options.point)];
        const project = (changes: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, changes, { signal, current, cooperate: options.cooperate });
        const candidate = await project(ops); check();
        const staged = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal, current, cooperate: options.cooperate });
        try {
            check(); const b = staged.logicalBounds(node.id), pose = worldPose(candidate, node.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) };
            const placement = poseInParent(doc, node, node.parent, pose, geometry);
            if (placement.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
            if (placement.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: placement.x });
            if (placement.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: placement.y });
            const resultDoc = await project(ops); check();
            final = await acquireBoardGeometryScope(runtime, [node.id], { doc: resultDoc, signal, current, cooperate: options.cooperate }); check();
            const held = final, frozen = Object.freeze(ops.map(op => Object.freeze(op)));
            const release = () => { if (!released) { released = true; try { held.release(); } finally { source.release(); } } };
            return Object.freeze({ ops: frozen, doc: resultDoc,
                commit() { try { check(); const applied = session.apply({ origin: 'tool', label: 'Edit connector', ops: frozen }); applied.release(); } finally { release(); } }, release });
        } finally { staged.release(); }
    } catch (error) { try { final?.release(); } finally { source.release(); } throw error; }
}
