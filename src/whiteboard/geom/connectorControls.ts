import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { ConnectorNode } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { ConnectorGeometry } from './connectorTypes';
import type { Vec2 } from './path';
import { projectConnectorLabel } from './connectorLabelProjection';

export type ConnectorControl = 'bend' | 'elbow' | 'label';
export interface ConnectorControlOptions {
    readonly runtime: BoardRuntime;
    readonly id: NodeId;
    readonly control: ConnectorControl;
    readonly point: Vec2;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    /** World distance within which a dragged label snaps to the path centre (a screen distance at the current zoom). */
    readonly labelSnapWorld?: number;
}
export interface ConnectorControlPreview {
    readonly ops: readonly NodeSetOp[];
    readonly doc: BoardRuntime['session']['doc'];
    commit(): void;
    release(): void;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function connectorLabelFraction(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, point: Vec2, snapWorld?: number): number {
    return projectConnectorLabel(node, geometry, point, snapWorld).fraction;
}
function controlValue(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, control: ConnectorControl, point: Vec2, snapWorld?: number): NodeSetOp {
    const a = geometry.start.aimWorld, b = geometry.end.aimWorld, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (![a.x, a.y, b.x, b.y, dx, dy, length].every(Number.isFinite)) throw new RangeError('Connector control geometry overflows');
    if (control === 'label') return { t: 'set', id: node.id, key: 'labelAt', value: connectorLabelFraction(node, geometry, point, snapWorld) };
    if (control === 'elbow') {
        // Default, calibration cut by owner: the dominant route axis controls the elbow midpoint.
        const value = Math.abs(dx) >= Math.abs(dy) ? (dx ? (point.x - a.x) / dx : 0.5) : (dy ? (point.y - a.y) / dy : 0.5);
        if (!Number.isFinite(value)) throw new RangeError('Connector elbow control overflows');
        return { t: 'set', id: node.id, key: 'elbowMid', value: clamp(value) };
    }
    const bend = length ? (point.x - (a.x / 2 + b.x / 2)) * (-dy / length) + (point.y - (a.y / 2 + b.y / 2)) * (dx / length) : 0;
    if (!Number.isFinite(bend)) throw new RangeError('Connector bend control overflows');
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
        const control = controlValue(node, prepared.connector, options.control, options.point, options.labelSnapWorld);
        const ops: NodeSetOp[] = Object.is(Reflect.get(node, control.key), control.value) ? [] : [control];
        if (!ops.length) {
            const release = () => { if (!released) { released = true; source.release(); } };
            return Object.freeze({ ops: Object.freeze(ops), doc, commit() { try { check(); } finally { release(); } }, release });
        }
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
                commit() { try { check(); if (frozen.length) { const applied = session.apply({ origin: 'tool', label: 'Edit connector', ops: frozen }); applied.release(); } } finally { release(); } }, release });
        } finally { staged.release(); }
    } catch (error) { try { final?.release(); } finally { source.release(); } throw error; }
}
