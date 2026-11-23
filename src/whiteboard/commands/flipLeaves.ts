import { isLocked } from '../change/commands';
import { selectedRootsAsync } from '../geom/selectedRootsAsync';
import { normalizedRotation, pageOrigin, poseInParent, worldPose, type ChangeGeometry, type WorldPose } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from './geometryScope';
import { inspectOpaqueSubtrees } from './selectionScope';
import { flipPicture } from '../geom/crop';
import { reflectedTargetAnchors } from '../geom/attachments';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
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
    /** Gesture holds the caller keeps open around this flip (the keyboard transform holds one). A flip refuses only holds it
     * does not own: a pointer gesture that starts meanwhile would otherwise commit ops staged against the old geometry. */
    readonly heldGestures?: number;
}
export interface FlipLeavesPlan {
    readonly doc: BoardRuntime['session']['doc'];
    readonly ops: readonly NodeSetOp[];
    commit(): void;
    cancel(): void;
}
interface Item { readonly node: Readonly<Node>; readonly protected: boolean; readonly depth: number }
function provisional(doc: BoardDoc, node: Readonly<Node>, world: WorldPose): NodeSetOp[] {
    let x: number, y: number, rotation: number;
    if (isSheetParent(doc, node.parent)) {
        const origin = pageOrigin(doc, node.page); x = world.x - origin.x; y = world.y - origin.y; rotation = world.rotation;
    } else {
        const parent = worldPose(doc, node.parent), dx = world.x - parent.x, dy = world.y - parent.y;
        const c = Math.cos(parent.rotation), s = Math.sin(parent.rotation);
        x = c * dx + s * dy; y = -s * dx + c * dy; rotation = world.rotation - parent.rotation;
    }
    if (![x, y, rotation].every(Number.isFinite)) throw new RangeError('Reflected placement overflows');
    return [{ t: 'set', id: node.id, key: 'x', value: x }, { t: 'set', id: node.id, key: 'y', value: y },
        { t: 'set', id: node.id, key: 'rotation', value: normalizedRotation(rotation) }];
}

/** Stage reflection in parent-before-child levels. Siblings share one sparse
 * projection, avoiding a growing whole-operation replay for every node. */
export async function prepareFlipBoardLeaves(options: FlipLeavesOptions): Promise<FlipLeavesPlan> {
    const { runtime, axis } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let font: number | undefined, released = false, source: BoardGeometryScope | undefined, final: BoardGeometryScope | undefined;
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && session.gestureHolds === (options.heldGestures ?? 0) && runtime.selection.getSnapshot() === selection
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Flip source changed', 'AbortError'); };
    const release = () => {
        if (released) return; released = true;
        try { final?.release(); } finally { source?.release(); }
        final = source = undefined;
    };
    const plan = (projected: typeof doc, ops: readonly NodeSetOp[]): FlipLeavesPlan => {
        const frozen = Object.freeze(ops);
        return Object.freeze({ doc: projected, ops: frozen,
            commit() {
                try {
                    check(); if (frozen.length) {
                        const applied = session.apply({ origin: 'tool', label: axis === 'x' ? 'Flip horizontal' : 'Flip vertical', ops: frozen });
                        applied.release();
                    }
                } finally { release(); }
            },
            cancel: release,
        });
    };
    let work = 0, started = performance.now();
    const tick = async () => {
        if (++work >= 256 || performance.now() - started >= 3) { check(); await cooperate(); check(); work = 0; started = performance.now(); }
    };
    if ((axis !== 'x' && axis !== 'y') || ![options.centre.x, options.centre.y].every(Number.isFinite)) throw new RangeError('Invalid flip axis');
    try {
        check(); const roots = await selectedRootsAsync(doc, options.ids, { signal, current, cooperate }); check();
        if (!roots.length) return plan(doc, []);
        const rootIds: NodeId[] = [];
        for (const node of roots) {
            if (node.kind === 'opaque' || isLocked(doc, node) || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Node cannot be reflected: ${node.id}`);
            let parent: ParentId = node.parent, inFocus = node.id === selection.focus || parent === selection.focus;
            for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
                const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Flip ancestor disappeared');
                parent = ancestor.parent; inFocus = parent === selection.focus;
            }
            if (!inFocus) throw new Error('Flip selection is outside the current focus');
            rootIds.push(node.id); await tick();
        }
        const opaque = await inspectOpaqueSubtrees(doc, rootIds, { signal, current, cooperate }); check();
        for (const id of rootIds) { if (opaque.get(id)) throw new Error(`Opaque content cannot be reflected: ${id}`); await tick(); }
        const levels: Item[][] = [], itemIds: NodeId[] = [], mutableIds: NodeId[] = [], stack: { node: Readonly<Node>; depth: number }[] = [];
        for (let i = roots.length - 1; i >= 0; i--) { stack.push({ node: roots[i], depth: 0 }); await tick(); }
        while (stack.length) {
            check(); const entry = stack.pop()!, node = entry.node, keep = node.locked, level = levels[entry.depth] ?? (levels[entry.depth] = []);
            level.push({ node, protected: keep, depth: entry.depth }); itemIds.push(node.id); if (!keep) mutableIds.push(node.id);
            if (!keep && (node.kind === 'group' || node.kind === 'frame')) {
                const children = childrenOf(doc, node.id);
                for (let i = children.length - 1; i >= 0; i--) { stack.push({ node: children[i], depth: entry.depth + 1 }); await tick(); }
            }
            await tick();
        }
        source = await acquireBoardGeometryScope(runtime, itemIds, { signal, current, cooperate }); check(); font = runtime.render.text.fonts.epoch;
        const shape: NodeSetOp[] = [], reflect = (p: Vec2): Vec2 => axis === 'x'
            ? { x: 2 * options.centre.x - p.x, y: p.y } : { x: p.x, y: 2 * options.centre.y - p.y };
        for (const level of levels) for (const { node, protected: keep } of level) {
            check(); if (keep) { await tick(); continue; }
            switch (node.kind) {
                case 'figure': shape.push(axis === 'x' ? { t: 'set', id: node.id, key: 'flipX', value: !node.flipX }
                    : { t: 'set', id: node.id, key: 'flipY', value: !node.flipY }); break;
                case 'picture': for (const op of flipPicture(node, axis)) { if (op.t !== 'set') throw new Error('Invalid picture flip'); shape.push(op); await tick(); } break;
                case 'stroke': shape.push(axis === 'x' ? { t: 'set', id: node.id, key: 'sx', value: -node.sx }
                    : { t: 'set', id: node.id, key: 'sy', value: -node.sy }); break;
                case 'polyline': {
                    const points: Vec2[] = [];
                    for (const point of node.points) { points.push(axis === 'x' ? { x: -point.x, y: point.y } : { x: point.x, y: -point.y }); await tick(); }
                    shape.push({ t: 'set', id: node.id, key: 'points', value: points }); break;
                }
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
            for (const op of reflectedTargetAnchors(doc, node.id, axis === 'x', axis === 'y')) { shape.push(op); await tick(); }
            await tick();
        }
        const project = (ops: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, ops, { signal, current, cooperate });
        const shapeDoc = await project(shape); check();
        const shapeScope = await acquireBoardGeometryScope(runtime, mutableIds, { doc: shapeDoc, signal, current, cooperate });
        try {
            check(); const operations: NodeSetOp[] = [], desired = new Map<NodeId, WorldPose>();
            for (const op of shape) { operations.push(op); await tick(); }
            let candidate = shapeDoc;
            for (const level of levels) {
                for (const item of level) {
                    check(); const node = item.node, oldPose = worldPose(doc, node.id); let world: WorldPose;
                    if (item.protected) world = oldPose;
                    else if (node.kind === 'connector' || node.kind === 'group') world = { ...reflect(oldPose), rotation: -oldPose.rotation };
                    else {
                        const before = source.localBounds(node.id), after = shapeScope.localBounds(node.id), c = Math.cos(oldPose.rotation), s = Math.sin(oldPose.rotation);
                        const oldX = before[0] / 2 + before[2] / 2, oldY = before[1] / 2 + before[3] / 2;
                        const target = reflect({ x: oldPose.x + c * oldX - s * oldY, y: oldPose.y + s * oldX + c * oldY });
                        const newX = after[0] / 2 + after[2] / 2, newY = after[1] / 2 + after[3] / 2, angle = -oldPose.rotation;
                        const nc = Math.cos(angle), ns = Math.sin(angle);
                        world = { x: target.x - nc * newX + ns * newY, y: target.y - ns * newX - nc * newY, rotation: angle };
                    }
                    if (![world.x, world.y, world.rotation].every(Number.isFinite)) throw new RangeError('Reflected world pose overflows');
                    const currentNode = candidate.nodes.get(node.id); if (!currentNode) throw new Error('Flip node disappeared');
                    desired.set(node.id, world);
                    for (const op of provisional(candidate, currentNode, world)) operations.push(op);
                    await tick();
                }
                candidate = await project(operations); check();
            }
            const staged = await acquireBoardGeometryScope(runtime, rootIds, { doc: candidate, signal, current, cooperate });
            try {
                for (const node of roots) {
                    check(); const b = staged.logicalBounds(node.id), geometry: ChangeGeometry = {
                        resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                        worldBoundsCenter: () => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }),
                    };
                    const world = desired.get(node.id); if (!world) throw new Error('Reflected root pose is unavailable');
                    const placement = poseInParent(doc, node, node.parent, world, geometry);
                    if (placement.page !== node.page) operations.push({ t: 'set', id: node.id, key: 'page', value: placement.page });
                    operations.push({ t: 'set', id: node.id, key: 'x', value: placement.x },
                        { t: 'set', id: node.id, key: 'y', value: placement.y }, { t: 'set', id: node.id, key: 'rotation', value: placement.rotation });
                    await tick();
                }
                const finalDoc = await project(operations); check();
                final = await acquireBoardGeometryScope(runtime, rootIds, { doc: finalDoc, signal, current, cooperate }); check();
                const frozen: NodeSetOp[] = [];
                for (const op of operations) { frozen.push(Object.freeze(op)); await tick(); }
                return plan(finalDoc, frozen);
            } finally { staged.release(); }
        } finally { shapeScope.release(); }
    } catch (error) { release(); throw error; }
}

export async function flipBoardLeaves(options: FlipLeavesOptions): Promise<void> {
    const plan = await prepareFlipBoardLeaves(options); plan.commit();
}
