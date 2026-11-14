import { isLocked } from '../change/commands';
import { selectedRootsAsync } from '../geom/selectedRootsAsync';
import { normalizedRotation, pageOrigin, poseInParent, worldPose, type ChangeGeometry, type WorldPose } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope } from './geometryScope';
import { flipPicture } from '../geom/crop';
import { reflectedTargetAnchors } from '../geom/attachments';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
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
interface Item { readonly node: Readonly<Node>; readonly protected: boolean }
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

/** Reflects roots and their descendants in one staged transaction, retaining locked subtrees in world space. */
export async function flipBoardLeaves(options: FlipLeavesOptions): Promise<void> {
    const { runtime, axis } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let font: number | undefined;
    const current = () => !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && runtime.selection.getSnapshot() === selection && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Flip source changed', 'AbortError'); };
    if ((axis !== 'x' && axis !== 'y') || ![options.centre.x, options.centre.y].every(Number.isFinite)) throw new RangeError('Invalid flip axis');
    check(); const roots = await selectedRootsAsync(doc, options.ids, { signal, current, cooperate }); check();
    if (!roots.length) return;
    for (const node of roots) if (node.kind === 'opaque' || isLocked(doc, node) || hasOpaqueDescendant(doc, node.id)
        || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Node cannot be reflected: ${node.id}`);
    const items: Item[] = [], stack = [...roots].reverse(); let work = 0;
    while (stack.length) {
        check(); const node = stack.pop()!, protectedNode = node.locked;
        items.push({ node, protected: protectedNode });
        if (!protectedNode && (node.kind === 'group' || node.kind === 'frame')) {
            const children = childrenOf(doc, node.id); for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        }
        if (++work % 256 === 0) { await cooperate(); check(); }
    }
    const source = await acquireBoardGeometryScope(runtime, items.map(item => item.node.id), { signal, current, cooperate });
    try {
        check(); font = runtime.render.text.fonts.epoch;
        const shape: NodeSetOp[] = [], reflect = (p: Vec2): Vec2 => axis === 'x'
            ? { x: 2 * options.centre.x - p.x, y: p.y } : { x: p.x, y: 2 * options.centre.y - p.y };
        for (const { node, protected: keep } of items) {
            check(); if (keep) continue;
            switch (node.kind) {
                case 'figure': shape.push(axis === 'x' ? { t: 'set', id: node.id, key: 'flipX', value: !node.flipX }
                    : { t: 'set', id: node.id, key: 'flipY', value: !node.flipY }); break;
                case 'picture': for (const op of flipPicture(node, axis)) { if (op.t !== 'set') throw new Error('Invalid picture flip'); shape.push(op); } break;
                case 'stroke': shape.push(axis === 'x' ? { t: 'set', id: node.id, key: 'sx', value: -node.sx }
                    : { t: 'set', id: node.id, key: 'sy', value: -node.sy }); break;
                case 'polyline': shape.push({ t: 'set', id: node.id, key: 'points', value: node.points.map(p => axis === 'x' ? { x: -p.x, y: p.y } : { x: p.x, y: -p.y }) }); break;
                case 'connector': {
                    for (const side of ['start', 'end'] as const) {
                        const end = node[side]; if (end.attach) continue;
                        shape.push({ t: 'set', id: node.id, key: side, value: { ...end,
                            x: axis === 'x' ? -end.x : end.x, y: axis === 'y' ? -end.y : end.y } });
                    }
                    shape.push({ t: 'set', id: node.id, key: 'bend', value: -node.bend }); break;
                }
                // Default, calibration cut by owner: readable glyphs and media surfaces are not mirrored.
                case 'text': case 'sticky': case 'clip': case 'linkcard': case 'embed': case 'frame': case 'group': break;
                case 'opaque': throw new Error('Opaque descendants cannot be reflected');
            }
            shape.push(...reflectedTargetAnchors(doc, node.id, axis === 'x', axis === 'y'));
        }
        const project = (ops: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, ops, { signal, current, cooperate });
        const shapeDoc = await project(shape); check();
        const shapeScope = await acquireBoardGeometryScope(runtime, items.filter(item => !item.protected).map(item => item.node.id),
            { doc: shapeDoc, signal, current, cooperate });
        try {
            check(); const operations: NodeSetOp[] = [...shape], desired = new Map<NodeId, WorldPose>();
            let candidate = shapeDoc;
            for (const item of items) {
                check(); const node = item.node, oldPose = worldPose(doc, node.id);
                let world: WorldPose;
                if (item.protected) world = oldPose;
                else if (node.kind === 'connector' || node.kind === 'group') world = { ...reflect(oldPose), rotation: -oldPose.rotation };
                else {
                    const before = source.localBounds(node.id), after = shapeScope.localBounds(node.id), c = Math.cos(oldPose.rotation), s = Math.sin(oldPose.rotation);
                    const oldX = (before[0] + before[2]) / 2, oldY = (before[1] + before[3]) / 2;
                    const target = reflect({ x: oldPose.x + c * oldX - s * oldY, y: oldPose.y + s * oldX + c * oldY });
                    const newX = (after[0] + after[2]) / 2, newY = (after[1] + after[3]) / 2, angle = -oldPose.rotation;
                    const nc = Math.cos(angle), ns = Math.sin(angle);
                    world = { x: target.x - nc * newX + ns * newY, y: target.y - ns * newX - nc * newY, rotation: angle };
                }
                const currentNode = candidate.nodes.get(node.id); if (!currentNode) throw new Error('Flip node disappeared');
                desired.set(node.id, world); operations.push(...provisional(candidate, currentNode, world));
                candidate = await project(operations); check();
            }
            const staged = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { doc: candidate, signal, current, cooperate });
            try {
                check();
                for (const node of roots) {
                    const b = staged.logicalBounds(node.id), geometry: ChangeGeometry = {
                        resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                        worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }),
                    };
                    const placement = poseInParent(doc, node, node.parent, desired.get(node.id)!, geometry);
                    if (placement.page !== node.page) operations.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
                    operations.push({ t: 'set', id: node.id, key: 'x', value: placement.x },
                        { t: 'set', id: node.id, key: 'y', value: placement.y }, { t: 'set', id: node.id, key: 'rotation', value: placement.rotation });
                }
                const finalDoc = await project(operations); check();
                const final = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { doc: finalDoc, signal, current, cooperate });
                try { check(); if (operations.length) { const applied = session.apply({ origin: 'tool', label: axis === 'x' ? 'Flip horizontal' : 'Flip vertical', ops: operations }); applied.release(); } }
                finally { final.release(); }
            } finally { staged.release(); }
        } finally { shapeScope.release(); }
    } finally { source.release(); }
}
