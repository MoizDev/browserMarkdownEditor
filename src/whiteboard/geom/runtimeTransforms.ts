import { isLocked } from '../change/commands';
import { selectedRootsAsync } from './selectedRootsAsync';
import { normalizedRotation, pageOrigin, poseInParent, worldPose, type ChangeGeometry, type WorldPose } from '../change/coordinates';
import type { NodeSetOp, Transaction } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, isSheetParent, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { Vec2 } from './path';
import { rotatePoint, snapReleasedRotation, snapRotation, unwrapRotation } from './transforms';
import { yieldToHost } from '../../platform/yieldToHost';

export interface BoardRotationOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly centre: Vec2;
    readonly down: Vec2;
    readonly orientation: number;
    /** Fences the owning view and input gesture through commit or cancellation. */
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface BoardRotationPreview {
    readonly angle: number;
    readonly doc: BoardDoc;
    readonly ops: readonly NodeSetOp[];
}
export interface BoardRotationPlan {
    /** `release`: the pointer is up, so the angle also lands on whole degrees (and a right angle when coarse). */
    preview(pointer: Vec2, shift: boolean, signal?: AbortSignal, release?: { readonly coarse: boolean }): Promise<BoardRotationPreview>;
    previewAngle(delta: number, signal?: AbortSignal): Promise<BoardRotationPreview>;
    commit(preview: BoardRotationPreview): void;
    cancel(): void;
}
interface Root { readonly node: Readonly<Node>; readonly pose: WorldPose }

/** Convert the desired world origin through the unchanged parent and original page.
 * Page ownership is selected only after the complete staged geometry is realized. */
function provisional(doc: BoardDoc, root: Root, world: WorldPose): NodeSetOp[] {
    const node = root.node;
    let x: number, y: number, rotation: number;
    if (isSheetParent(doc, node.parent)) {
        const origin = pageOrigin(doc, node.page);
        x = world.x - origin.x; y = world.y - origin.y; rotation = world.rotation;
    } else {
        const parent = worldPose(doc, node.parent), dx = world.x - parent.x, dy = world.y - parent.y;
        const c = Math.cos(parent.rotation), s = Math.sin(parent.rotation);
        x = c * dx + s * dy; y = -s * dx + c * dy; rotation = normalizedRotation(world.rotation - parent.rotation);
    }
    if (![x, y, rotation].every(Number.isFinite)) throw new RangeError('Rotation pose is not finite');
    return [
        { t: 'set', id: node.id, key: 'x', value: x },
        { t: 'set', id: node.id, key: 'y', value: y },
        { t: 'set', id: node.id, key: 'rotation', value: rotation },
    ];
}

/** Actual rigid rotation only. Resize, stretch and reflection need their own kind planners. */
export async function createBoardRotationPlan(options: BoardRotationOptions): Promise<BoardRotationPlan> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot();
    let font: number | undefined;
    const signal = options.signal ?? new AbortController().signal;
    const centre = { ...options.centre }, down = { ...options.down }, orientation = options.orientation;
    if (![centre.x, centre.y, down.x, down.y, orientation].every(Number.isFinite)
        || (centre.x === down.x && centre.y === down.y)) throw new RangeError('Invalid rotation gesture');
    let closed = false, generation = 0;
    const current = () => !closed && !signal.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && !session.isReadOnly && runtime.selection.getSnapshot() === selection
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = (request?: AbortSignal) => {
        signal.throwIfAborted(); request?.throwIfAborted();
        if (!current()) throw new DOMException('Rotation plan became stale', 'AbortError');
    };
    check();
    const chosen = await selectedRootsAsync(doc, options.ids, { signal, current, cooperate: options.cooperate }); check();
    if (!chosen.length) throw new Error('Nothing selected for rotation');
    for (const node of chosen) {
        if (node.kind === 'opaque' || isLocked(doc, node) || hasOpaqueDescendant(doc, node.id)) throw new Error(`Node cannot be rotated: ${node.id}`);
        if (sheetOf(doc, node.id) !== selection.sheet) throw new Error('Rotation selection spans another sheet');
    }
    const roots: Root[] = chosen.map(node => ({ node, pose: worldPose(doc, node.id) }));
    const protectedRoots: Root[] = [], pending = [...chosen], cooperate = options.cooperate ?? yieldToHost;
    let visited = 0;
    while (pending.length) {
        check(); const node = pending.pop()!;
        if (++visited % 256 === 0) { await cooperate(); check(); }
        if (node.locked) { protectedRoots.push({ node, pose: worldPose(doc, node.id) }); continue; }
        if (node.kind === 'group' || node.kind === 'frame') for (const child of childrenOf(doc, node.id)) pending.push(child);
    }
    const protectedIds = new Set(protectedRoots.map(root => root.node.id));
    const base = await acquireBoardGeometryScope(runtime, roots.map(root => root.node.id), { signal, current, cooperate: options.cooperate });
    try { check(); font = runtime.render.text.fonts.epoch; } catch (error) { base.release(); throw error; }
    let angle = 0, lastPointer = Math.atan2(down.y - centre.y, down.x - centre.x);
    let latest: { value: BoardRotationPreview; scope: BoardGeometryScope; generation: number; signal?: AbortSignal } | undefined;
    const releaseLatest = () => { const prior = latest; latest = undefined; prior?.scope.release(); };
    const close = () => {
        if (closed) return;
        closed = true; generation++;
        try { releaseLatest(); } finally { base.release(); }
    };
    const render = async (resolved: number, requestSignal?: AbortSignal): Promise<BoardRotationPreview> => {
            check(requestSignal); if (!Number.isFinite(resolved)) throw new RangeError('Invalid rotation angle');
            const turn = ++generation;
            const active = () => current() && turn === generation && !requestSignal?.aborted;
            const assert = () => { check(requestSignal); if (turn !== generation) throw new DOMException('Rotation preview superseded', 'AbortError'); };
            const desired = new Map<NodeId, WorldPose>(), initial: NodeSetOp[] = [];
            for (const root of roots) {
                const p = rotatePoint(root.pose, centre, resolved), world = { ...p, rotation: normalizedRotation(root.pose.rotation + resolved) };
                desired.set(root.node.id, world); initial.push(...provisional(doc, root, world));
            }
            const request = requestSignal ?? signal;
            let candidate = await projectBoardGeometrySets(doc, initial, { signal: request, current: active, cooperate: options.cooperate });
            assert();
            let protectedCount = 0;
            for (const saved of protectedRoots) {
                const node = candidate.nodes.get(saved.node.id); if (!node) throw new Error('Protected descendant disappeared');
                initial.push(...provisional(candidate, { node, pose: saved.pose }, saved.pose));
                if (++protectedCount % 256 === 0) { await cooperate(); assert(); }
            }
            if (protectedRoots.length) {
                candidate = await projectBoardGeometrySets(doc, initial, { signal: request, current: active, cooperate: options.cooperate }); assert();
            }
            const staged = await acquireBoardGeometryScope(runtime, roots.map(root => root.node.id), { doc: candidate, signal: request, current: active, cooperate: options.cooperate });
            let published = false;
            try {
                assert(); const final: NodeSetOp[] = initial.filter(op => protectedIds.has(op.id)
                    && !Object.is(Reflect.get(doc.nodes.get(op.id)!, op.key), op.value));
                for (const root of roots) {
                    const b = staged.logicalBounds(root.node.id), center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
                    const geometry: ChangeGeometry = { resolvedTip: runtime.render.changeGeometry.resolvedTip,
                        worldBoundsCenter: () => center };
                    const pose = poseInParent(doc, root.node as Node, root.node.parent, desired.get(root.node.id)!, geometry), node = root.node;
                    if (pose.page !== node.page) final.push({ t: 'set', id: node.id, key: 'page', value: pose.page });
                    if (pose.x !== node.x) final.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
                    if (pose.y !== node.y) final.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
                    if (pose.rotation !== node.rotation) final.push({ t: 'set', id: node.id, key: 'rotation', value: pose.rotation });
                }
                // If page ownership changes, rebuild against the final page-local records;
                // the preview never exposes the provisional page index.
                const finalDoc = await projectBoardGeometrySets(doc, final, { signal: request, current: active, cooperate: options.cooperate });
                assert();
                const finalScope = await acquireBoardGeometryScope(runtime, roots.map(root => root.node.id), { doc: finalDoc, signal: request, current: active, cooperate: options.cooperate });
                try {
                    assert();
                    const ops = Object.freeze(final.map(op => Object.freeze(op)));
                    const value: BoardRotationPreview = Object.freeze({ angle: resolved, doc: finalDoc, ops });
                    releaseLatest(); latest = { value, scope: finalScope, generation: turn, signal: requestSignal }; published = true; return value;
                } finally { if (!published) finalScope.release(); }
            } finally { staged.release(); }
    };
    return {
        preview(pointer, shift, requestSignal, release) {
            check(requestSignal);
            if (![pointer.x, pointer.y].every(Number.isFinite) || (pointer.x === centre.x && pointer.y === centre.y)) throw new RangeError('Invalid rotation pointer');
            const pointerAngle = Math.atan2(pointer.y - centre.y, pointer.x - centre.x);
            angle = unwrapRotation(angle, lastPointer, pointerAngle); lastPointer = pointerAngle;
            let next = snapRotation(orientation + angle, shift);
            if (release) next = snapReleasedRotation(next, release.coarse);
            return render(next - orientation, requestSignal);
        },
        previewAngle(delta, requestSignal) { return render(delta, requestSignal); },
        commit(value) {
            try {
                check();
                if (!latest || latest.value !== value || latest.generation !== generation) throw new DOMException('Rotation preview is not current', 'AbortError');
                latest.signal?.throwIfAborted();
                const transaction: Transaction = { origin: 'tool', label: 'Rotate selection', ops: value.ops };
                if (transaction.ops.length) { const applied = session.apply(transaction); applied.release(); }
            } finally { close(); }
        },
        cancel: close,
    };
}
