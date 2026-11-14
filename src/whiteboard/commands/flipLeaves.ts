import { isLocked, selectedRoots } from '../change/commands';
import { normalizedRotation, pageOrigin, poseInParent, worldPose, type ChangeGeometry, type WorldPose } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope } from './geometryScope';
import { flipPicture } from '../geom/crop';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import { hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { ConnectorEnd, Node } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';

export interface FlipLeavesOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly centre: Vec2;
    readonly axis: 'x' | 'y';
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
function provisional(doc: BoardDoc, node: Readonly<Node>, world: WorldPose): NodeSetOp[] {
    let x: number, y: number, rotation: number;
    if (isSheetParent(doc, node.parent)) {
        const origin = pageOrigin(doc, node.page); x = world.x - origin.x; y = world.y - origin.y; rotation = world.rotation;
    } else {
        const parent = worldPose(doc, node.parent), dx = world.x - parent.x, dy = world.y - parent.y;
        const c = Math.cos(parent.rotation), s = Math.sin(parent.rotation);
        x = c * dx + s * dy; y = -s * dx + c * dy; rotation = world.rotation - parent.rotation;
    }
    return [{ t: 'set', id: node.id, key: 'x', value: x }, { t: 'set', id: node.id, key: 'y', value: y },
        { t: 'set', id: node.id, key: 'rotation', value: normalizedRotation(rotation) }];
}

/** Reflects selected leaf geometry in one transaction; container recursion has a separate owner. */
export async function flipBoardLeaves(options: FlipLeavesOptions): Promise<void> {
    const { runtime, axis } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    let font: number | undefined;
    const current = () => !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && runtime.selection.getSnapshot() === selection && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Flip source changed', 'AbortError'); };
    if ((axis !== 'x' && axis !== 'y') || ![options.centre.x, options.centre.y].every(Number.isFinite)) throw new RangeError('Invalid flip axis');
    check(); const nodes = selectedRoots(doc, options.ids);
    if (!nodes.length) return;
    for (const node of nodes) if (node.kind === 'group' || node.kind === 'opaque' || (node.kind === 'frame' && (doc.children.get(node.id)?.length ?? 0) > 0)
        || isLocked(doc, node) || hasOpaqueDescendant(doc, node.id) || sheetOf(doc, node.id) !== selection.sheet)
        throw new Error(`Node is not a leaf reflection target: ${node.id}`);
    const source = await acquireBoardGeometryScope(runtime, nodes.map(node => node.id), { signal, current, cooperate: options.cooperate });
    try {
        check(); font = runtime.render.text.fonts.epoch;
        const selected = new Set(nodes.map(node => node.id)), shape: NodeSetOp[] = [];
        const ends = new Map<NodeId, { start: ConnectorEnd; end: ConnectorEnd }>();
        const reflect = (p: Vec2): Vec2 => axis === 'x' ? { x: 2 * options.centre.x - p.x, y: p.y } : { x: p.x, y: 2 * options.centre.y - p.y };
        const endPair = (id: NodeId) => {
            let pair = ends.get(id); if (pair) return pair;
            const node = doc.nodes.get(id); if (!node || node.kind !== 'connector') throw new Error('Flip incident connector disappeared');
            pair = { start: node.start, end: node.end }; ends.set(id, pair); return pair;
        };
        for (const node of nodes) {
            check();
            switch (node.kind) {
                case 'figure': shape.push(axis === 'x' ? { t: 'set', id: node.id, key: 'flipX', value: !node.flipX }
                    : { t: 'set', id: node.id, key: 'flipY', value: !node.flipY }); break;
                case 'picture': for (const op of flipPicture(node, axis)) { if (op.t !== 'set') throw new Error('Invalid picture flip'); shape.push(op); } break;
                case 'stroke': shape.push(axis === 'x' ? { t: 'set', id: node.id, key: 'sx', value: -node.sx }
                    : { t: 'set', id: node.id, key: 'sy', value: -node.sy }); break;
                case 'polyline': shape.push({ t: 'set', id: node.id, key: 'points', value: node.points.map(p => axis === 'x' ? { x: -p.x, y: p.y } : { x: p.x, y: -p.y }) }); break;
                case 'connector': {
                    const pair = endPair(node.id);
                    for (const side of ['start', 'end'] as const) if (!pair[side].attach) pair[side] = { ...pair[side],
                        x: axis === 'x' ? -pair[side].x : pair[side].x, y: axis === 'y' ? -pair[side].y : pair[side].y };
                    shape.push({ t: 'set', id: node.id, key: 'bend', value: -node.bend }); break;
                }
                // Default, calibration cut by owner: readable glyphs and external surfaces are not mirrored.
                case 'text': case 'sticky': case 'clip': case 'linkcard': case 'embed': case 'frame': break;
                case 'group': case 'opaque': throw new Error('Container reflection requires recursive planning');
            }
            for (const incident of doc.attachedTo.get(node.id) ?? []) {
                const pair = endPair(incident);
                for (const side of ['start', 'end'] as const) {
                    const end = pair[side], attachment = end.attach;
                    if (!attachment || attachment.target !== node.id) continue;
                    // Default, calibration cut by owner: reflect the normalized anchor on selected targets.
                    const anchor = axis === 'x' ? { x: 1 - attachment.anchor.x, y: attachment.anchor.y }
                        : { x: attachment.anchor.x, y: 1 - attachment.anchor.y };
                    pair[side] = { ...end, attach: { ...attachment, anchor } };
                }
            }
        }
        for (const [id, pair] of ends) {
            const original = doc.nodes.get(id); if (!original || original.kind !== 'connector') throw new Error('Flip connector disappeared');
            if (pair.start !== original.start) shape.push({ t: 'set', id, key: 'start', value: pair.start });
            if (pair.end !== original.end) shape.push({ t: 'set', id, key: 'end', value: pair.end });
        }
        const project = (ops: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, ops, { signal, current, cooperate: options.cooperate });
        const shapeDoc = await project(shape); check();
        const shapeScope = await acquireBoardGeometryScope(runtime, nodes.map(node => node.id), { doc: shapeDoc, signal, current, cooperate: options.cooperate });
        try {
            check(); const preliminary: NodeSetOp[] = [...shape], desired = new Map<NodeId, WorldPose>();
            for (const node of nodes) {
                const pose = worldPose(doc, node.id), angle = -pose.rotation;
                let world: WorldPose;
                if (node.kind === 'connector') world = { ...reflect(pose), rotation: angle };
                else {
                    const before = source.localBounds(node.id), after = shapeScope.localBounds(node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
                    const oldX = (before[0] + before[2]) / 2, oldY = (before[1] + before[3]) / 2;
                    const target = reflect({ x: pose.x + c * oldX - s * oldY, y: pose.y + s * oldX + c * oldY });
                    const newX = (after[0] + after[2]) / 2, newY = (after[1] + after[3]) / 2, nc = Math.cos(angle), ns = Math.sin(angle);
                    world = { x: target.x - nc * newX + ns * newY, y: target.y - ns * newX - nc * newY, rotation: angle };
                }
                desired.set(node.id, world); preliminary.push(...provisional(doc, node, world));
            }
            const candidate = await project(preliminary); check();
            const staged = await acquireBoardGeometryScope(runtime, nodes.map(node => node.id), { doc: candidate, signal, current, cooperate: options.cooperate });
            try {
                check(); const ops: NodeSetOp[] = [...shape];
                for (const node of nodes) {
                    const b = staged.logicalBounds(node.id), geometry: ChangeGeometry = {
                        resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                        worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }),
                    };
                    const pose = poseInParent(doc, node as Node, node.parent, desired.get(node.id)!, geometry);
                    if (pose.page !== node.page) ops.push({ t: 'set', id: node.id, key: 'page', value: pose.page });
                    if (pose.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
                    if (pose.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
                    if (pose.rotation !== node.rotation) ops.push({ t: 'set', id: node.id, key: 'rotation', value: pose.rotation });
                }
                const finalDoc = await project(ops); check();
                const final = await acquireBoardGeometryScope(runtime, selected, { doc: finalDoc, signal, current, cooperate: options.cooperate });
                try { check(); if (ops.length) { const applied = session.apply({ origin: 'tool', label: axis === 'x' ? 'Flip horizontal' : 'Flip vertical', ops }); applied.release(); } }
                finally { final.release(); }
            } finally { staged.release(); }
        } finally { shapeScope.release(); }
    } finally { source.release(); }
}
