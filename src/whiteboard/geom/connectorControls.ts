import { isLocked } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
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
    /** World distances within which an arc's bend snaps to straight (centre) and an elbow's midpoint to the middle of its range. */
    readonly handleSnapWorld?: Readonly<{ centre: number; mid: number }>;
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
function controlValue(node: Readonly<ConnectorNode>, geometry: ConnectorGeometry, control: ConnectorControl, point: Vec2, snapWorld?: number,
    handleSnap?: Readonly<{ centre: number; mid: number }>, parallel: readonly number[] = []): NodeSetOp {
    const a = geometry.start.aimWorld, b = geometry.end.aimWorld, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (![a.x, a.y, b.x, b.y, dx, dy, length].every(Number.isFinite)) throw new RangeError('Connector control geometry overflows');
    if (control === 'label') return { t: 'set', id: node.id, key: 'labelAt', value: connectorLabelFraction(node, geometry, point, snapWorld) };
    if (control === 'elbow') {
        // Default, calibration cut by owner: the dominant route axis controls the elbow midpoint.
        const dominantX = Math.abs(dx) >= Math.abs(dy), origin = dominantX ? a.x : a.y, span = dominantX ? dx : dy;
        const value = Math.abs(dx) >= Math.abs(dy) ? (dx ? (point.x - a.x) / dx : 0.5) : (dy ? (point.y - a.y) / dy : 0.5);
        if (!Number.isFinite(value)) throw new RangeError('Connector elbow control overflows');
        // Within the mid radius of the middle of the range, the midpoint snaps there (catalogue B§ elbow midpoint snap 10).
        const axisLength = Math.abs(dx) >= Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
        let mid = handleSnap && Math.abs(value - 0.5) * axisLength <= handleSnap.mid ? 0.5 : clamp(value);
        // Otherwise the midline snaps to the nearest parallel segment of an elbow that shares a bound shape, within the same radius
        // (catalogue a.6). The midline runs along the dominant axis, so its candidates are the segments parallel to it.
        if (handleSnap && mid !== 0.5 && span !== 0) {
            const current = dominantX ? point.x : point.y;
            let best: number | undefined;
            for (const line of parallel) if (Math.abs(line - current) <= handleSnap.mid && (best === undefined || Math.abs(line - current) < Math.abs(best - current))) best = line;
            if (best !== undefined) mid = clamp((best - origin) / span);
        }
        return { t: 'set', id: node.id, key: 'elbowMid', value: mid };
    }
    let bend = length ? (point.x - (a.x / 2 + b.x / 2)) * (-dy / length) + (point.y - (a.y / 2 + b.y / 2)) * (dx / length) : 0;
    if (!Number.isFinite(bend)) throw new RangeError('Connector bend control overflows');
    // Near the chord the bend snaps to straight: an arc's middle handle centres on the chord (catalogue B§ arc centre snap 16).
    if (handleSnap && Math.abs(bend) <= handleSnap.centre) bend = 0;
    return { t: 'set', id: node.id, key: 'bend', value: Math.max(-1_000_000, Math.min(1_000_000, bend)) };
}

/** World coordinates of the segments parallel to an elbow's midline (along its dominant axis) in other elbows that share a bound
 * shape with it: the midline snaps to them (catalogue a.6). */
async function sharedElbowLines(runtime: BoardRuntime, doc: Readonly<BoardDoc>, node: Readonly<ConnectorNode>, geometry: ConnectorGeometry,
    signal: AbortSignal, cooperate?: () => Promise<void>): Promise<number[]> {
    const targets = new Set([node.start.attach?.target, node.end.attach?.target].filter((id): id is NodeId => !!id));
    if (!targets.size || node.route !== 'elbow') return [];
    const a = geometry.start.aimWorld, b = geometry.end.aimWorld, dominantX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const lines: number[] = [];
    for (const other of doc.nodes.values()) {
        if (other.kind !== 'connector' || other.id === node.id || other.route !== 'elbow') continue;
        if (!(other.start.attach && targets.has(other.start.attach.target)) && !(other.end.attach && targets.has(other.end.attach.target))) continue;
        const prepared = await runtime.render.prepareForPick(other, signal, doc);
        let previous: Vec2 | null = null;
        for (const op of prepared.connector?.body ?? []) {
            if (op.op === 'M') { previous = op.p; continue; }
            if (op.op === 'L' && previous) {
                if (dominantX && Math.abs(op.p.x - previous.x) < 1e-6) lines.push(op.p.x);
                else if (!dominantX && Math.abs(op.p.y - previous.y) < 1e-6) lines.push(op.p.y);
            }
            if (op.op !== 'Z') previous = op.p;
        }
        if (cooperate) await cooperate();
        signal.throwIfAborted();
    }
    return lines;
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
        const parallel = options.control === 'elbow' && options.handleSnapWorld ? await sharedElbowLines(runtime, doc, node, prepared.connector, signal, options.cooperate) : [];
        check();
        const control = controlValue(node, prepared.connector, options.control, options.point, options.labelSnapWorld, options.handleSnapWorld, parallel);
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
