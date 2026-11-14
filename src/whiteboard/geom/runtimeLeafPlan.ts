import { isLocked, selectedRoots } from '../change/commands';
import { worldPose } from '../change/coordinates';
import { inverse } from './affine';
import type { NodeSetOp, Transaction } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, hasOpaqueDescendant, sheetOf, type BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import type { Vec2 } from './path';
import { prepareBoardLeafResize } from './runtimeResizeKinds';
import { prepareConnectorResize } from './runtimeConnectorResize';
import { ResizePlan, type SelectionResizePreview } from './resizePlan';
import type { ResizeTargetSnapshot } from './resizePlan.types';
import type { KindResizeFactors } from './resizeKinds.types';
import { commonResizeRotation } from './transforms';
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

/** A coordinated selection uses one immutable candidate and one history transaction. */
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
        if (node.kind === 'opaque' || isLocked(doc, node)
            || hasOpaqueDescendant(doc, node.id) || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Unsupported resize target: ${node.id}`);
    }
    const leaves = new Map<NodeId, NodeId[]>(), all = new Set<NodeId>(), cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let count = 0;
    for (const root of nodes) {
        const result: NodeId[] = [], pending = [root]; leaves.set(root.id, result);
        while (pending.length) {
            check(); const node = pending.pop()!;
            if (++count % 256 === 0) { await cooperate(); check(); }
            if (node.locked) continue;
            if (node.kind === 'group') { for (const child of childrenOf(doc, node.id)) pending.push(child); }
            else {
                if (node.kind === 'opaque') throw new Error(`Unsupported group resize descendant: ${node.id}`);
                result.push(node.id); all.add(node.id);
            }
        }
        if (!result.length) throw new Error(`Group has no resizable content: ${root.id}`);
        all.add(root.id);
    }
    const scope = await acquireBoardGeometryScope(runtime, all, { signal, current, cooperate: options.cooperate });
    try { check(); fontEpoch = runtime.render.text.fonts.epoch; } catch (error) { scope.release(); throw error; }
    const snapshots = new Map<NodeId, ResizeTargetSnapshot>();
    const rotations = new Map<NodeId, number[]>();
    try { for (const node of nodes) rotations.set(node.id, leaves.get(node.id)!.map(id => worldPose(doc, id).rotation)); }
    catch (error) { scope.release(); throw error; }
    const common = commonResizeRotation([...rotations.values()].flat()), mixed = common === null, frameAngle = common ?? 0;
    const c = Math.cos(frameAngle), s = Math.sin(frameAngle), target = inverse([c, s, -s, c, 0, 0], 1e12);
    if (!target) { scope.release(); throw new Error('Resize selection frame is not invertible'); }
    const textNeedsUniform = (node: Readonly<Node>): boolean => {
        if (node.kind !== 'text') return false;
        if (mixed || (options.handle.x && options.handle.y)) return true;
        const turns = Math.round((worldPose(doc, node.id).rotation - frameAngle) / (Math.PI / 2));
        const turn = (turns % 4 + 4) % 4, hx = options.handle.x, hy = options.handle.y;
        return (turn === 0 ? hy : turn === 1 ? -hx : turn === 2 ? -hy : hx) !== 0;
    };
    const leafCentres = new Map<NodeId, Vec2>();
    try {
        for (const ids of leaves.values()) for (const id of ids) {
            const box = await scope.boundsInSpace(id, target); check();
            const x = (box[0] + box[2]) / 2, y = (box[1] + box[3]) / 2;
            leafCentres.set(id, { x: c * x - s * y, y: s * x + c * y });
        }
        for (const node of nodes) {
        const box = await scope.boundsInSpace(node.id, target), pose = worldPose(doc, node.id);
        check();
        const point = (x: number, y: number) => ({ x: c * x - s * y, y: s * x + c * y });
        const descendants = leaves.get(node.id)!.map(id => doc.nodes.get(id)!);
        snapshots.set(node.id, { node, centreWorld: point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
            cornersWorld: [point(box[0], box[1]), point(box[2], box[1]), point(box[2], box[3]), point(box[0], box[3])],
            // Default, calibration cut by owner: a text side that cannot change width scales uniformly.
            relevantRotations: rotations.get(node.id)!, forceAspect: descendants.some(child => child.kind === 'clip' || child.kind === 'sticky'
                || textNeedsUniform(child)), worldRotation: pose.rotation });
    } } catch (error) { scope.release(); throw error; }
    type Lease = { release(): void };
    let latest: { value: BoardLeafResizePreview; leases: Lease[]; generation: number; signal: AbortSignal } | undefined;
    let pending: { doc: BoardDoc; leases: Lease[]; generation: number } | undefined;
    const release = (leases: readonly Lease[]) => { for (let i = leases.length - 1; i >= 0; i--) leases[i].release(); };
    const clear = () => { const value = latest; latest = undefined; if (value) release(value.leases); };
    let plan: ResizePlan;
    try { plan = new ResizePlan(nodes, options.down, options.handle, {
        capture(node) { const value = snapshots.get(node.id); if (!value) throw new Error('Resize target disappeared'); return value; },
        isCurrent: current,
        async planAllAsync(targets, frame, request) {
            const turn = generation, leases: Lease[] = [], ops: NodeSetOp[] = [], connectors: NodeId[] = [];
            const active = () => current() && turn === generation && !request.aborted;
            let candidate = doc, transferred = false;
            try {
                for (const target of targets) {
                    const rootId = target.snapshot.node.id, rootTurns = Math.round((target.snapshot.worldRotation - frame.box.rotation) / (Math.PI / 2));
                    const rootSwap = !mixed && Math.abs(rootTurns % 2) === 1;
                    const zeroX = rootSwap ? target.factors.zeroSignY : target.factors.zeroSignX;
                    const zeroY = rootSwap ? target.factors.zeroSignX : target.factors.zeroSignY;
                    for (const id of leaves.get(rootId)!) {
                        check(request); if (!active()) throw new DOMException('Resize preview superseded', 'AbortError');
                        const node = candidate.nodes.get(id);
                        if (!node || node.kind === 'opaque' || node.kind === 'group') throw new Error('Resize target changed');
                        if (node.kind === 'connector') { connectors.push(id); continue; }
                        let factors: KindResizeFactors = target.factors, centreWorld = target.centre;
                        const oldPose = scope.worldPose(id);
                        if (id !== rootId) {
                            const turns = Math.round((oldPose.rotation - frame.box.rotation) / (Math.PI / 2));
                            const swap = !mixed && Math.abs(turns % 2) === 1, turn = mixed ? 0 : (turns % 4 + 4) % 4;
                            const hx = options.handle.x, hy = options.handle.y;
                            factors = { x: swap ? frame.scaleY : frame.scaleX, y: swap ? frame.scaleX : frame.scaleY,
                                zeroSignX: swap ? zeroY : zeroX, zeroSignY: swap ? zeroX : zeroY,
                                handleX: (turn === 0 ? hx : turn === 1 ? hy : turn === 2 ? -hx : -hy) as -1 | 0 | 1,
                                handleY: (turn === 0 ? hy : turn === 1 ? -hx : turn === 2 ? -hy : hx) as -1 | 0 | 1,
                                handle: hx && hy ? 'corner' : 'side', scope: 'multi' };
                            const centre = leafCentres.get(id); if (!centre) throw new Error('Resize source centre disappeared');
                            const worldX = centre.x, worldY = centre.y;
                            const c = Math.cos(frame.box.rotation), s = Math.sin(frame.box.rotation);
                            const dx = worldX - frame.anchor.x, dy = worldY - frame.anchor.y, u = c * dx + s * dy, v = -s * dx + c * dy;
                            centreWorld = { x: frame.anchor.x + c * u * frame.scaleX - s * v * frame.scaleY,
                                y: frame.anchor.y + s * u * frame.scaleX + c * v * frame.scaleY };
                        }
                        if (node.kind === 'text' && factors.handle === 'side' && (mixed || (!factors.handleX && factors.handleY))) {
                            factors = { ...factors, handle: 'corner' };
                        }
                        const fx = factors.x < 0 || (factors.x === 0 && factors.zeroSignX < 0);
                        const fy = factors.y < 0 || (factors.y === 0 && factors.zeroSignY < 0);
                        // Default, calibration cut by owner: a single crossed axis reflects orientation without shear.
                        const rotationWorld = fx !== fy ? 2 * frame.box.rotation - oldPose.rotation : oldPose.rotation;
                        const result = await prepareBoardLeafResize(node as Leaf, { runtime, doc: candidate, factors,
                            centreWorld, rotationWorld, alignmentRotation: frame.box.rotation, signal: request, current: active, cooperate: options.cooperate });
                        leases.push(result); candidate = result.doc; ops.push(...result.kindOps, ...result.placementOps);
                    }
                }
                // Default, calibration cut by owner: selected targets are staged before bound connectors resolve.
                for (const id of connectors) {
                    check(request); if (!active()) throw new DOMException('Resize preview superseded', 'AbortError');
                    const original = doc.nodes.get(id); if (!original || original.kind !== 'connector') throw new Error('Connector source changed');
                    const result = await prepareConnectorResize({ runtime, source: doc, doc: candidate, node: original,
                        frame, signal: request, current: active, cooperate: options.cooperate });
                    leases.push(result); candidate = result.doc; ops.push(...result.ops);
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
            try { check(request); if (turn !== generation) throw new DOMException('Resize preview superseded', 'AbortError'); }
            catch (error) { if (pending?.generation === turn) { const failed = pending; pending = undefined; release(failed.leases); } throw error; }
            if (!value.ops.length && (!pending || pending.generation !== turn)) {
                if (pending) { release(pending.leases); pending = undefined; }
                pending = { doc, leases: [], generation: turn };
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
