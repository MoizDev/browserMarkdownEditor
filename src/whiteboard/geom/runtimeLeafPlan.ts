import { isLocked, selectedRoots } from '../change/commands';
import { worldPose } from '../change/coordinates';
import type { NodeSetOp, Transaction } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { hasOpaqueDescendant, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import { prepareBoardLeafResize, type BoardLeafResizeResult } from './runtimeResizeKinds';
import { ResizePlan, type SelectionResizePreview } from './resizePlan';
import type { ResizeTargetSnapshot } from './resizePlan.types';
import type { OrientedBox, ResizeHandle, ResizeModifiers } from './transforms';

export interface BoardLeafResizePlanOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly down: Vec2;
    readonly handle: ResizeHandle;
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface BoardLeafResizePreview extends SelectionResizePreview { readonly doc: BoardDoc }
export interface BoardLeafResizePlan {
    readonly startBox: OrientedBox;
    preview(pointer: Vec2, modifiers: ResizeModifiers, signal: AbortSignal, zeroSignX?: -1 | 1, zeroSignY?: -1 | 1): Promise<BoardLeafResizePreview>;
    commit(preview: BoardLeafResizePreview): void;
    cancel(): void;
}

type Leaf = Exclude<Node, { kind: 'opaque' | 'group' | 'connector' }>;

/** A coordinated leaf selection uses one immutable candidate and one history transaction. */
export async function createBoardLeafResizePlan(options: BoardLeafResizePlanOptions): Promise<BoardLeafResizePlan> {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    let closed = false, generation = 0, fontEpoch: number | undefined;
    const current = () => !closed && !signal.aborted && options.current() && session.owner === owner && session.doc === doc
        && doc.rev === revision && !session.isReadOnly && runtime.selection.getSnapshot() === selection
        && (fontEpoch === undefined || runtime.render.text.fonts.epoch === fontEpoch);
    const check = (request?: AbortSignal) => {
        signal.throwIfAborted(); request?.throwIfAborted();
        if (!current()) throw new DOMException('Resize plan became stale', 'AbortError');
    };
    check();
    const nodes = selectedRoots(doc, options.ids);
    if (!nodes.length) throw new Error('Nothing selected for resize');
    for (const node of nodes) {
        if (node.kind === 'opaque' || node.kind === 'group' || node.kind === 'connector' || isLocked(doc, node)
            || hasOpaqueDescendant(doc, node.id) || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Not a leaf resize target: ${node.id}`);
    }
    const scope = await acquireBoardGeometryScope(runtime, nodes.map(node => node.id), { signal, current, cooperate: options.cooperate });
    try { check(); fontEpoch = runtime.render.text.fonts.epoch; } catch (error) { scope.release(); throw error; }
    const snapshots = new Map<NodeId, ResizeTargetSnapshot>();
    try { for (const node of nodes) {
        const box = scope.localBounds(node.id), pose = worldPose(doc, node.id), c = Math.cos(pose.rotation), s = Math.sin(pose.rotation);
        const point = (x: number, y: number) => ({ x: pose.x + c * x - s * y, y: pose.y + s * x + c * y });
        snapshots.set(node.id, { node, centreWorld: point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
            cornersWorld: [point(box[0], box[1]), point(box[2], box[1]), point(box[2], box[3]), point(box[0], box[3])],
            relevantRotations: [pose.rotation], worldRotation: pose.rotation });
    } } catch (error) { scope.release(); throw error; }
    let latest: { value: BoardLeafResizePreview; leases: BoardLeafResizeResult[]; generation: number; signal: AbortSignal } | undefined;
    let pending: { doc: BoardDoc; leases: BoardLeafResizeResult[]; generation: number } | undefined;
    const release = (leases: readonly BoardLeafResizeResult[]) => { for (let i = leases.length - 1; i >= 0; i--) leases[i].release(); };
    const clear = () => { const value = latest; latest = undefined; if (value) release(value.leases); };
    let plan: ResizePlan;
    try { plan = new ResizePlan(nodes, options.down, options.handle, {
        capture(node) { const value = snapshots.get(node.id); if (!value) throw new Error('Resize target disappeared'); return value; },
        isCurrent: current,
        async planAllAsync(targets, frame, request) {
            const turn = generation, leases: BoardLeafResizeResult[] = [], ops: NodeSetOp[] = [];
            const active = () => current() && turn === generation && !request.aborted;
            let candidate = doc, transferred = false;
            try {
                for (const target of targets) {
                    check(request); if (!active()) throw new DOMException('Resize preview superseded', 'AbortError');
                    const node = candidate.nodes.get(target.snapshot.node.id);
                    if (!node || node.kind === 'opaque' || node.kind === 'group' || node.kind === 'connector') throw new Error('Resize target changed');
                    const fx = target.factors.x < 0 || (target.factors.x === 0 && target.factors.zeroSignX < 0);
                    const fy = target.factors.y < 0 || (target.factors.y === 0 && target.factors.zeroSignY < 0);
                    // Default, calibration cut by owner: a single crossed axis reflects orientation without shear.
                    const rotationWorld = fx !== fy ? 2 * frame.box.rotation - target.snapshot.worldRotation : target.snapshot.worldRotation;
                    const result = await prepareBoardLeafResize(node as Leaf, { runtime, doc: candidate, factors: target.factors,
                        centreWorld: target.centre, rotationWorld, signal: request, current: active, cooperate: options.cooperate });
                    leases.push(result); candidate = result.doc; ops.push(...result.kindOps, ...result.placementOps);
                }
                check(request); if (!active()) throw new DOMException('Resize preview superseded', 'AbortError');
                pending = { doc: candidate, leases, generation: turn }; transferred = true;
                return ops;
            } finally { if (!transferred) release(leases); }
        },
    }); } catch (error) { scope.release(); throw error; }
    const close = () => {
        if (closed) return; closed = true; generation++; plan.cancel();
        try { clear(); } finally { if (pending) { release(pending.leases); pending = undefined; } scope.release(); }
    };
    return {
        startBox: plan.startBox,
        async preview(pointer, modifiers, request, zeroSignX = 1, zeroSignY = 1) {
            check(request); const turn = ++generation;
            let value: SelectionResizePreview;
            try { value = await plan.previewAsync(pointer, modifiers, request, zeroSignX, zeroSignY); }
            catch (error) {
                if (pending?.generation === turn) { const failed = pending; pending = undefined; release(failed.leases); }
                throw error;
            }
            const prepared = pending;
            if (!prepared || prepared.generation !== turn || turn !== generation) {
                if (prepared?.generation === turn) { pending = undefined; release(prepared.leases); }
                throw new DOMException('Resize preview superseded', 'AbortError');
            }
            pending = undefined;
            try {
                check(request);
                const result: BoardLeafResizePreview = Object.freeze({ ...value, doc: prepared.doc });
                clear(); latest = { value: result, leases: prepared.leases, generation: turn, signal: request }; return result;
            } catch (error) { release(prepared.leases); throw error; }
        },
        commit(value) {
            try {
                check();
                if (!latest || latest.value !== value || latest.generation !== generation) throw new DOMException('Resize preview is not current', 'AbortError');
                latest.signal.throwIfAborted();
                const transaction: Transaction = { origin: 'tool', label: 'Resize selection', ops: value.ops };
                if (transaction.ops.length) { const applied = session.apply(transaction); applied.release(); }
            } finally { close(); }
        },
        cancel: close,
    };
}
