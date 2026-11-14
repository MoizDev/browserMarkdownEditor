import { poseInParent, worldPose, worldToLocal, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import type { BoardDoc } from '../model/doc';
import type { ConnectorNode } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import { connectorBody, connectorBodyPoint } from './connectors';
import { connectorLabelFraction } from './connectorControls';
import type { Vec2 } from './path';
import { styleGeometryMetrics } from './styleMetrics';
import type { ResizePreview } from './transforms';

export interface ConnectorResizeOptions {
    readonly runtime: BoardRuntime;
    readonly source: BoardDoc;
    /** A staged document in which selected targets have already been resized. */
    readonly doc: BoardDoc;
    readonly node: Readonly<ConnectorNode>;
    readonly frame: ResizePreview;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface ConnectorResizeResult {
    readonly ops: readonly NodeSetOp[];
    readonly doc: BoardDoc;
    release(): void;
}
function mapped(point: Vec2, frame: ResizePreview): Vec2 {
    const c = Math.cos(frame.box.rotation), s = Math.sin(frame.box.rotation), dx = point.x - frame.anchor.x, dy = point.y - frame.anchor.y;
    const x = (c * dx + s * dy) * frame.scaleX, y = (-s * dx + c * dy) * frame.scaleY;
    return { x: frame.anchor.x + c * x - s * y, y: frame.anchor.y + s * x + c * y };
}

/** Targets are already staged; bound ends stay bound while free ends and controls map once. */
export async function prepareConnectorResize(options: ConnectorResizeOptions): Promise<ConnectorResizeResult> {
    const { runtime, source, doc, frame, signal } = options, session = runtime.session, live = session.doc, owner = session.owner;
    const sourceRevision = source.rev, revision = doc.rev, liveRevision = live.rev;
    let released = false, font: number | undefined;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === live
        && live.rev === liveRevision && source.rev === sourceRevision && doc.rev === revision
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Connector resize source changed', 'AbortError'); };
    check(); const original = source.nodes.get(options.node.id), node = doc.nodes.get(options.node.id);
    if (!original || original.kind !== 'connector' || !node || node.kind !== 'connector') throw new Error('Connector resize target disappeared');
    const sourceScope = await acquireBoardGeometryScope(runtime, [node.id], { doc: source, signal, current, cooperate: options.cooperate });
    let final: BoardGeometryScope | undefined;
    try {
        check(); font = runtime.render.text.fonts.epoch;
        const initial = await runtime.render.prepareForPick(original, signal, source); check();
        if (!initial.connector) throw new Error('Original connector geometry is unavailable');
        const metric = styleGeometryMetrics.bendThreshold(original.size, original.width);
        const threshold = metric.status === 'bracket' ? metric.min : metric.status === 'provisional' ? metric.value : original.width * 3;
        const sourceBody = connectorBody(initial.connector.start.aimWorld, initial.connector.end.aimWorld,
            Math.abs(original.bend) <= threshold ? 0 : original.bend, 0.01);
        const middle = mapped(connectorBodyPoint(sourceBody, .5), frame), labelPoint = mapped(initial.connector.editMetrics.anchorWorld, frame);
        const pose = worldPose(source, original.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation), ops: NodeSetOp[] = [];
        for (const side of ['start', 'end'] as const) {
            const prior = original[side], currentEnd = node[side];
            if (prior.attach) continue;
            const world = mapped({ x: pose.x + c * prior.x - s * prior.y, y: pose.y + s * prior.x + c * prior.y }, frame);
            const local = worldToLocal(doc, node, world);
            // Default, calibration cut by owner: a selection transform never detaches a binding.
            ops.push({ t: 'set', id: node.id, key: side, value: { ...currentEnd, x: local.x, y: local.y } });
        }
        const project = (changes: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, changes, { signal, current, cooperate: options.cooperate });
        let candidate = await project(ops); check();
        let projected = candidate.nodes.get(node.id);
        if (!projected || projected.kind !== 'connector') throw new Error('Connector resize projection disappeared');
        let prepared = await runtime.render.prepareForPick(projected, signal, candidate); check();
        if (!prepared.connector) throw new Error('Projected connector geometry is unavailable');
        if (node.route === 'arc') {
            const a = prepared.connector.start.aimWorld, b = prepared.connector.end.aimWorld, dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
            const bend = length ? ((middle.x - (a.x + b.x) / 2) * -dy + (middle.y - (a.y + b.y) / 2) * dx) / length : 0;
            ops.push({ t: 'set', id: node.id, key: 'bend', value: Math.max(-1_000_000, Math.min(1_000_000, bend)) });
            candidate = await project(ops); check(); projected = candidate.nodes.get(node.id);
            if (!projected || projected.kind !== 'connector') throw new Error('Connector resize projection disappeared');
            prepared = await runtime.render.prepareForPick(projected, signal, candidate); check();
            if (!prepared.connector) throw new Error('Projected connector geometry is unavailable');
        }
        ops.push({ t: 'set', id: node.id, key: 'labelAt', value: connectorLabelFraction(projected, prepared.connector, labelPoint) });
        candidate = await project(ops); check();
        const staged = await acquireBoardGeometryScope(runtime, [node.id], { doc: candidate, signal, current, cooperate: options.cooperate });
        try {
            check(); const b = staged.logicalBounds(node.id), world = worldPose(candidate, node.id);
            const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }) };
            const placement = poseInParent(doc, node, node.parent, world, geometry);
            if (placement.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
            if (placement.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: placement.x });
            if (placement.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: placement.y });
            const finalDoc = await project(ops); check();
            final = await acquireBoardGeometryScope(runtime, [node.id], { doc: finalDoc, signal, current, cooperate: options.cooperate }); check();
            const held = final;
            return { ops: Object.freeze(ops.map(op => Object.freeze(op))), doc: finalDoc,
                release() { if (!released) { released = true; try { held.release(); } finally { sourceScope.release(); } } } };
        } finally { staged.release(); }
    } catch (error) { try { final?.release(); } finally { sourceScope.release(); } throw error; }
}
