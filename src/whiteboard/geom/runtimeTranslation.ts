import { isLocked } from '../change/commands';
import { selectedRootsAsync } from './selectedRootsAsync';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp, Transaction } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Node } from '../model/nodes';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import { projectFrameMembership } from './frameMembership';
import { projectBoardTransformPreview } from './transformProjection';
import { findStickyPit } from './stickyNeighbours';
import type { Vec2 } from './path';
import { SNAP_MAX_SPEED, snapBoardBounds, type BoardSnapGuide } from './runtimeSnap';
import { TranslationPlan } from './translation';
import { constrainedTranslation } from './transforms';
import { yieldToHost } from '../../platform/yieldToHost';

/** The correction that moves a dragged note into the free slot beside another note it is within `10 / zoom` of (catalogue S§7.5).
 * Only a note on an unrotated frame has slots; the note itself neither offers nor occupies one. */
function stickyPitCorrection(doc: BoardDoc, root: Node, delta: Vec2, zoom: number): Vec2 | null {
    if (root.kind !== 'sticky' || root.rotation !== 0) return null;
    const parent = worldPose(doc, root.parent as ParentId), origin = worldPose(doc, root.id);
    if (parent.rotation !== 0) return null;
    const x = origin.x + delta.x - parent.x, y = origin.y + delta.y - parent.y;
    const centre = { x: x + 100 * root.scale, y: y + (100 + root.growY / 2) * root.scale };
    const slot = findStickyPit(doc, root.scale, centre, root.parent as ParentId, root.page, 10 / zoom, root.id);
    return slot ? { x: slot.x - x, y: slot.y - y } : null;
}

/** Positions commit to 1e-6 board units. Finer than any pointer step at any zoom, and coarser than the binary64 residue a delta
 * leaves: measured, a grid landing at 120 committed as 119.99999999999994 and a free drag as 290.00000000000006. Applied once,
 * to the committed placement; the live preview keeps the exact arithmetic so the gesture's feel does not change. */
const POSITION_SCALE = 1e6;
function cleanPlacement(op: NodeSetOp): NodeSetOp {
    if (op.t !== 'set' || (op.key !== 'x' && op.key !== 'y') || typeof op.value !== 'number') return op;
    return { ...op, value: Math.round(op.value * POSITION_SCALE) / POSITION_SCALE };
}

export interface BoardTranslationOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly down: Vec2;
    readonly zoom: () => number;
    readonly alwaysSnap: () => boolean;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    /** false is a pure move (keyboard nudges): no object or grid snapping, whatever the preferences say. */
    readonly snap?: boolean;
}
export interface BoardTranslationPreview { readonly ops: readonly NodeSetOp[]; readonly doc: BoardDoc; readonly guides: readonly BoardSnapGuide[] }
export interface BoardTranslationPlan {
    /** `speed` is the pointer's speed in CSS px per ms; object snapping is off at or above SNAP_MAX_SPEED. */
    preview(point: Vec2, shift: boolean, accel: boolean, signal: AbortSignal, speed?: number): Promise<BoardTranslationPreview>;
    commit(preview: BoardTranslationPreview): void;
    cancel(): void;
}

/** Translation keeps geometry leases through final actual-geometry page placement and commit. */
export async function createBoardTranslationPlan(options: BoardTranslationOptions): Promise<BoardTranslationPlan> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    let closed = false, serial = 0, font: number | undefined;
    const current = () => !closed && !signal.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && !session.isReadOnly && runtime.selection.getSnapshot() === selection
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = (request?: AbortSignal) => { signal.throwIfAborted(); request?.throwIfAborted(); if (!current()) throw new DOMException('Translation source changed', 'AbortError'); };
    if (![options.down.x, options.down.y].every(Number.isFinite)) throw new RangeError('Invalid translation origin');
    check(); const roots = await selectedRootsAsync(doc, options.ids, { signal, current, cooperate: options.cooperate }); check();
    if (!roots.length) throw new Error('Nothing selected to move');
    for (const node of roots) if (node.kind === 'opaque' || isLocked(doc, node) || hasOpaqueDescendant(doc, node.id)
        || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Node cannot be moved: ${node.id}`);
    const protectedRoots: { id: NodeId; pose: ReturnType<typeof worldPose> }[] = [], pending = [...roots];
    const cooperate = options.cooperate ?? yieldToHost; let visited = 0;
    while (pending.length) {
        check(); const node = pending.pop()!;
        if (++visited % 256 === 0) { await cooperate(); check(); }
        if (node.locked) { protectedRoots.push({ id: node.id, pose: worldPose(doc, node.id) }); continue; }
        if (node.kind === 'group' || node.kind === 'frame') for (const child of childrenOf(doc, node.id)) pending.push(child);
    }
    const source = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { signal, current, cooperate: options.cooperate });
    try { check(); font = runtime.render.text.fonts.epoch; } catch (error) { source.release(); throw error; }
    const geometry: ChangeGeometry = {
        resolvedTip: (candidate, connector, terminal) => source.geometry.resolvedTip(candidate, connector, terminal),
        worldBoundsCenter: (candidate, node) => {
            if (candidate !== doc) throw new Error('Translation geometry document mismatch');
            const bounds = source.logicalBounds(node.id);
            return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        },
    };
    let plan: TranslationPlan;
    try { plan = new TranslationPlan(doc, roots.map(node => node.id), geometry); } catch (error) { source.release(); throw error; }
    let latest: { value: BoardTranslationPreview; scope: BoardGeometryScope; signal: AbortSignal; serial: number; snapFence?: () => boolean } | undefined;
    const clear = () => { const value = latest; latest = undefined; value?.scope.release(); };
    const close = () => { if (closed) return; closed = true; serial++; plan.cancel(); try { clear(); } finally { source.release(); } };
    return {
        async preview(point, shift, accel, request, speed = 0) {
            check(request); if (![point.x, point.y].every(Number.isFinite)) throw new RangeError('Invalid translation pointer');
            const turn = ++serial, active = () => current() && !request.aborted && turn === serial;
            const assert = () => { check(request); if (turn !== serial) throw new DOMException('Translation preview superseded', 'AbortError'); };
            let delta = constrainedTranslation({ x: point.x - options.down.x, y: point.y - options.down.y }, shift), guides: readonly BoardSnapGuide[] = [];
            let snapFence: (() => boolean) | undefined;
            const project = (ops: readonly NodeSetOp[]) => projectBoardGeometrySets(doc, ops, { signal: request, current: active, cooperate: options.cooperate });
            const stage = async (movement: Vec2) => {
                const initial: NodeSetOp[] = plan.preview(movement).ops.map(op => { if (op.t !== 'set') throw new Error('Translation produced a non-set operation'); return op; });
                let candidate = await project(initial); assert(); const compensation: NodeSetOp[] = []; let protectedCount = 0;
                for (const saved of protectedRoots) {
                    const node = candidate.nodes.get(saved.id); if (!node) throw new Error('Protected descendant disappeared');
                    const pose = poseInParent(candidate, node, node.parent, saved.pose);
                    if (pose.x !== node.x) compensation.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
                    if (pose.y !== node.y) compensation.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
                    if (pose.rotation !== node.rotation) compensation.push({ t: 'set', id: node.id, key: 'rotation', value: pose.rotation });
                    if (++protectedCount % 256 === 0) { await cooperate(); assert(); }
                }
                if (compensation.length) { candidate = await project([...initial, ...compensation]); assert(); }
                const scope = await acquireBoardGeometryScope(runtime, roots.map(root => root.id), { doc: candidate, signal: request, current: active, cooperate: options.cooperate });
                // The plan detaches a connector end whose target is not moving: those ends are committed with the move.
                const detached = initial.filter(op => op.key === 'start' || op.key === 'end');
                return { scope, compensation, detached };
            };
            let staged = await stage(delta), final: BoardGeometryScope | undefined, transferred = false;
            try {
                assert();
                // Object snapping follows the calibrated default (off unless the modifier or Always Snap enables it) and the
                // velocity gate. The grid follows the modifier alone: held Cmd/Ctrl turns it off, nothing else does.
                const objects = options.alwaysSnap() !== accel && !(speed >= SNAP_MAX_SPEED), grid = !accel;
                if (options.snap !== false && (objects || grid)) {
                    const zoom = options.zoom(), preference = options.alwaysSnap();
                    snapFence = () => options.alwaysSnap() === preference && options.zoom() === zoom;
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                    for (const root of roots) { const b = staged.scope.logicalBounds(root.id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
                        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
                    const useX = !shift || delta.x !== 0, useY = !shift || delta.y !== 0;
                    // A note dragged into a free slot beside another note takes the pit, as a click does; the pit replaces the object
                    // and grid snap for this move (catalogue S§7.5). Its correction is measured from the current delta.
                    const pit = objects && roots.length === 1 ? stickyPitCorrection(doc, roots[0]!, delta, zoom) : null;
                    const result = pit ? { delta: pit, guides: [] as readonly BoardSnapGuide[] } : await snapBoardBounds({ runtime,
                        bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, selected: roots.map(node => node.id), zoom, allowX: useX,
                        allowY: useY, objects, grid, current: () => active() && snapFence!(), signal: request, cooperate: options.cooperate });
                    assert(); if (!snapFence()) throw new DOMException('Snap settings changed', 'AbortError');
                    const snapX = useX ? result.delta.x : 0, snapY = useY ? result.delta.y : 0;
                    guides = result.guides.filter(guide => (guide.featureAxis ?? guide.axis) === 'x' ? useX : useY);
                    if (snapX || snapY) { delta = { x: delta.x + snapX, y: delta.y + snapY }; staged.scope.release(); staged = await stage(delta); }
                }
                assert(); const ops: NodeSetOp[] = [...staged.detached, ...staged.compensation];
                for (const root of roots) {
                    const actual = staged.scope.logicalBounds(root.id), before = worldPose(doc, root.id);
                    const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => source.geometry.resolvedTip(d, connector, terminal),
                        worldBoundsCenter: () => ({ x: actual.x + actual.width / 2, y: actual.y + actual.height / 2 }) };
                    const placement = poseInParent(doc, root, root.parent, { x: before.x + delta.x, y: before.y + delta.y, rotation: before.rotation }, geometry);
                    if (placement.page !== root.page) ops.push({ t: 'set', id: root.id, key: 'page', value: placement.page });
                    if (placement.x !== root.x) ops.push({ t: 'set', id: root.id, key: 'x', value: placement.x });
                    if (placement.y !== root.y) ops.push({ t: 'set', id: root.id, key: 'y', value: placement.y });
                }
                let finalDoc = await project(ops); assert();
                if ((delta.x || delta.y) && ops.length) {
                    const placementScope = await acquireBoardGeometryScope(runtime, roots.map(root => root.id), { doc: finalDoc, signal: request, current: active, cooperate: options.cooperate });
                    try {
                        const membership = await projectFrameMembership({ runtime, doc: finalDoc, roots: roots.map(root => root.id), geometry: placementScope,
                            current: active, signal: request, cooperate: options.cooperate });
                        assert(); finalDoc = membership.doc;
                        if (membership.ops.length) {
                            ops.push(...membership.ops);
                            finalDoc = await projectBoardTransformPreview(doc, ops, { signal: request, current: active, cooperate: options.cooperate }); assert();
                        }
                    } finally { placementScope.release(); }
                }
                final = await acquireBoardGeometryScope(runtime, roots.map(root => root.id), { doc: finalDoc, signal: request, current: active, cooperate: options.cooperate }); assert();
                const value = Object.freeze({ ops: Object.freeze(ops.map(op => Object.freeze(op))), doc: finalDoc, guides: Object.freeze([...guides]) });
                if (snapFence && !snapFence()) throw new DOMException('Snap settings changed', 'AbortError');
                clear(); latest = { value, scope: final, signal: request, serial: turn, snapFence }; transferred = true; return value;
            } finally { try { if (!transferred) final?.release(); } finally { staged.scope.release(); } }
        },
        commit(value) {
            try {
                check(); if (!latest || latest.value !== value || latest.serial !== serial) throw new DOMException('Translation preview is not current', 'AbortError');
                latest.signal.throwIfAborted(); if (latest.snapFence && !latest.snapFence()) throw new DOMException('Snap settings changed', 'AbortError');
                const transaction: Transaction = { origin: 'tool', label: 'Move selection', ops: value.ops.map(cleanPlacement) };
                if (transaction.ops.length) { const applied = session.apply(transaction); applied.release(); }
            } finally { close(); }
        },
        cancel: close,
    };
}
