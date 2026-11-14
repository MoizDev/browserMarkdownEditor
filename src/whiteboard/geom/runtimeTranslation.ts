import { isLocked, selectedRoots } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp, Transaction } from '../change/ops';
import { acquireBoardGeometryScope, type BoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import { projectFrameMembership } from './frameMembership';
import { projectBoardTransformPreview } from './transformProjection';
import type { Vec2 } from './path';
import { snapBoardBounds, type BoardSnapGuide } from './runtimeSnap';
import { TranslationPlan } from './translation';
import { constrainedTranslation } from './transforms';

export interface BoardTranslationOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly down: Vec2;
    readonly zoom: () => number;
    readonly alwaysSnap: () => boolean;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface BoardTranslationPreview { readonly ops: readonly NodeSetOp[]; readonly doc: BoardDoc; readonly guides: readonly BoardSnapGuide[] }
export interface BoardTranslationPlan {
    preview(point: Vec2, shift: boolean, accel: boolean, signal: AbortSignal): Promise<BoardTranslationPreview>;
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
    check(); const roots = selectedRoots(doc, options.ids);
    if (!roots.length) throw new Error('Nothing selected to move');
    for (const node of roots) if (node.kind === 'opaque' || isLocked(doc, node) || hasOpaqueDescendant(doc, node.id)
        || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Node cannot be moved: ${node.id}`);
    const protectedRoots: { id: NodeId; pose: ReturnType<typeof worldPose> }[] = [], pending = [...roots];
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0))); let visited = 0;
    while (pending.length) {
        check(); const node = pending.pop()!;
        if (++visited % 256 === 0) { await cooperate(); check(); }
        if (node.locked) { protectedRoots.push({ id: node.id, pose: worldPose(doc, node.id) }); continue; }
        if (node.kind === 'group' || node.kind === 'frame') for (const child of childrenOf(doc, node.id)) pending.push(child);
    }
    const source = await acquireBoardGeometryScope(runtime, roots.map(node => node.id), { signal, current, cooperate: options.cooperate });
    try { check(); font = runtime.render.text.fonts.epoch; } catch (error) { source.release(); throw error; }
    let plan: TranslationPlan;
    try { plan = new TranslationPlan(doc, roots.map(node => node.id), runtime.render.changeGeometry); } catch (error) { source.release(); throw error; }
    let latest: { value: BoardTranslationPreview; scope: BoardGeometryScope; signal: AbortSignal; serial: number } | undefined;
    const clear = () => { const value = latest; latest = undefined; value?.scope.release(); };
    const close = () => { if (closed) return; closed = true; serial++; plan.cancel(); try { clear(); } finally { source.release(); } };
    return {
        async preview(point, shift, accel, request) {
            check(request); if (![point.x, point.y].every(Number.isFinite)) throw new RangeError('Invalid translation pointer');
            const turn = ++serial, active = () => current() && !request.aborted && turn === serial;
            const assert = () => { check(request); if (turn !== serial) throw new DOMException('Translation preview superseded', 'AbortError'); };
            let delta = constrainedTranslation({ x: point.x - options.down.x, y: point.y - options.down.y }, shift), guides: readonly BoardSnapGuide[] = [];
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
                return { scope, compensation };
            };
            let staged = await stage(delta), final: BoardGeometryScope | undefined, transferred = false;
            try {
                assert();
                // Default, calibration cut by owner: snapping is off unless the modifier or Always Snap enables it.
                if (options.alwaysSnap() !== accel) {
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                    for (const root of roots) { const b = staged.scope.logicalBounds(root.id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
                        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
                    const useX = !shift || delta.x !== 0, useY = !shift || delta.y !== 0;
                    const result = await snapBoardBounds({ runtime, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
                        selected: roots.map(node => node.id), zoom: options.zoom(), allowX: useX, allowY: useY,
                        current: active, signal: request, cooperate: options.cooperate });
                    assert();
                    const snapX = useX ? result.delta.x : 0, snapY = useY ? result.delta.y : 0;
                    guides = result.guides.filter(guide => (guide.featureAxis ?? guide.axis) === 'x' ? useX : useY).map(guide =>
                        guide.kind === 'equal-gap' ? { ...guide, value: guide.value + (guide.featureAxis === 'x' ? snapY : snapX) } : guide);
                    if (snapX || snapY) { delta = { x: delta.x + snapX, y: delta.y + snapY }; staged.scope.release(); staged = await stage(delta); }
                }
                assert(); const ops: NodeSetOp[] = [...staged.compensation];
                for (const root of roots) {
                    const actual = staged.scope.logicalBounds(root.id), before = worldPose(doc, root.id);
                    const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
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
                clear(); latest = { value, scope: final, signal: request, serial: turn }; transferred = true; return value;
            } finally { try { if (!transferred) final?.release(); } finally { staged.scope.release(); } }
        },
        commit(value) {
            try {
                check(); if (!latest || latest.value !== value || latest.serial !== serial) throw new DOMException('Translation preview is not current', 'AbortError');
                latest.signal.throwIfAborted(); const transaction: Transaction = { origin: 'tool', label: 'Move selection', ops: value.ops };
                if (transaction.ops.length) { const applied = session.apply(transaction); applied.release(); }
            } finally { close(); }
        },
        cancel: close,
    };
}
