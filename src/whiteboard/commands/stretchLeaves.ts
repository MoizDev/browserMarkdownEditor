import { isLocked } from '../change/commands';
import { selectedRootsAsync } from '../geom/selectedRootsAsync';
import type { NodeSetOp, Op } from '../change/ops';
import { prepareNotebookTransform } from '../input/notebookTranslation';
import { acquireBoardGeometryScope, type BoardGeometryScope } from './geometryScope';
import { inspectOpaqueSubtrees } from './selectionScope';
import { prepareBoardLeafResize } from '../geom/runtimeResizeKinds';
import { prepareConnectorResize } from '../geom/runtimeConnectorResize';
import type { KindResizeFactors } from '../geom/resizeKinds.types';
import type { ResizePreview } from '../geom/transforms';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, isSheetParent, sheetOf } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { Node } from '../model/nodes';

export interface StretchLeavesOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly axis: 'x' | 'y';
    readonly current: () => boolean;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
}
export interface StretchLeavesPlan {
    readonly doc: BoardRuntime['session']['doc'];
    readonly ops: readonly Op[];
    commit(): void;
    cancel(): void;
}
type Leaf = Exclude<Node, { kind: 'opaque' | 'group' | 'connector' }>;
type Lease = { release(): void };

/** Prepare every stretched leaf and bound connector in one immutable candidate;
 * all intermediate resources remain pinned through commit or cancellation. */
export async function prepareStretchBoardLeaves(options: StretchLeavesOptions): Promise<StretchLeavesPlan> {
    const { runtime, axis } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const selection = runtime.selection.getSnapshot(), signal = options.signal ?? new AbortController().signal;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let font: number | undefined, released = false, scope: BoardGeometryScope | undefined; const leases: Lease[] = [];
    const current = () => !released && !signal.aborted && options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && !session.isReadOnly && !session.isGestureActive && runtime.selection.getSnapshot() === selection
        && (font === undefined || runtime.render.text.fonts.epoch === font);
    const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Stretch source changed', 'AbortError'); };
    const release = () => {
        if (released) return; released = true;
        try { for (let i = leases.length - 1; i >= 0; i--) leases[i].release(); } finally { scope?.release(); }
        leases.length = 0; scope = undefined;
    };
    const plan = (candidate: typeof doc, ops: readonly Op[]): StretchLeavesPlan => {
        const frozen = Object.freeze(ops);
        return Object.freeze({ doc: candidate, ops: frozen,
            commit() {
                try {
                    check(); if (frozen.length) {
                        const applied = session.apply({ origin: 'tool', label: axis === 'x' ? 'Stretch horizontal' : 'Stretch vertical', ops: frozen });
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
    if (axis !== 'x' && axis !== 'y') throw new RangeError('Invalid stretch axis');
    try {
        check(); const roots = await selectedRootsAsync(doc, options.ids, { signal, current, cooperate }); check();
        if (!roots.length) return plan(doc, []);
        const rootIds: NodeId[] = [];
        for (const node of roots) {
            if (node.kind === 'opaque' || isLocked(doc, node) || sheetOf(doc, node.id) !== selection.sheet) throw new Error(`Node cannot be stretched: ${node.id}`);
            let parent: ParentId = node.parent, inFocus = node.id === selection.focus || parent === selection.focus;
            for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
                const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Stretch ancestor disappeared');
                parent = ancestor.parent; inFocus = parent === selection.focus;
            }
            if (!inFocus) throw new Error('Stretch selection is outside the current focus');
            rootIds.push(node.id); await tick();
        }
        const opaque = await inspectOpaqueSubtrees(doc, rootIds, { signal, current, cooperate }); check();
        for (const id of rootIds) { if (opaque.get(id)) throw new Error(`Opaque content cannot be stretched: ${id}`); await tick(); }
        const leaves = new Map<NodeId, NodeId[]>(), all = new Set<NodeId>();
        for (const root of roots) {
            const result: NodeId[] = [], pending: Node[] = [root]; leaves.set(root.id, result);
            while (pending.length) {
                check(); const node = pending.pop()!;
                if (node.locked) { await tick(); continue; }
                if (node.kind === 'group') for (const child of childrenOf(doc, node.id)) { pending.push(child); await tick(); }
                // Opaque nodes are locked, so the check above already skips them; opaque subtrees were rejected by inspectOpaqueSubtrees before this walk.
                else { result.push(node.id); all.add(node.id); }
                await tick();
            }
            if (!result.length) throw new Error(`Group has no stretchable content: ${root.id}`);
            all.add(root.id);
        }
        scope = await acquireBoardGeometryScope(runtime, all, { signal, current, cooperate }); check();
        font = runtime.render.text.fonts.epoch;
        const boxes = new Map<NodeId, ReturnType<BoardGeometryScope['logicalBounds']>>();
        let minimum = Infinity, maximum = -Infinity;
        for (const node of roots) {
            const box = scope.logicalBounds(node.id), start = axis === 'x' ? box.x : box.y, size = axis === 'x' ? box.width : box.height;
            boxes.set(node.id, box); minimum = Math.min(minimum, start); maximum = Math.max(maximum, start + size); await tick();
        }
        const span = maximum - minimum, targetCentre = minimum / 2 + maximum / 2;
        if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(targetCentre)) throw new RangeError('Stretch selection has no finite extent');
        let candidate = doc; const ops: NodeSetOp[] = [];
        const connectors: { id: NodeId; frame: ResizePreview; delta: { x: number; y: number } }[] = [];
        for (const root of roots) {
            check(); const box = boxes.get(root.id)!, size = axis === 'x' ? box.width : box.height;
            if (!(size > 0)) throw new RangeError('A zero-sized logical extent cannot be stretched');
            const factor = span / size, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
            if (![factor, cx, cy].every(Number.isFinite) || factor <= 0) throw new RangeError('Stretch factors overflow');
            const axes = new Map<NodeId, 'x' | 'y' | null>(); let aspect = false;
            for (const id of leaves.get(root.id)!) {
                const node = doc.nodes.get(id); if (!node) throw new Error('Stretch leaf disappeared');
                const angle = scope.worldPose(id).rotation, quarter = Math.PI / 2, turns = Math.round(angle / quarter);
                const aligned = Math.abs(angle - turns * quarter) <= 8 * Number.EPSILON * Math.max(1, Math.abs(angle), Math.abs(turns * quarter));
                const swap = Math.abs(turns % 2) === 1;
                const localAxis = aligned ? (axis === 'x' ? (swap ? 'y' : 'x') : (swap ? 'x' : 'y')) : null;
                axes.set(id, localAxis);
                if (!aligned || node.kind === 'sticky' || node.kind === 'clip' || (node.kind === 'text' && localAxis === 'y')) aspect = true;
                await tick();
            }
            // Default, calibration cut by owner: arbitrary rotations or aspect-only descendants lock the whole root uniformly.
            const sx = axis === 'x' || aspect ? factor : 1, sy = axis === 'y' || aspect ? factor : 1;
            const delta = { x: axis === 'x' ? targetCentre - cx : 0, y: axis === 'y' ? targetCentre - cy : 0 };
            if (factor === 1 && delta.x === 0 && delta.y === 0) continue;
            const frame: ResizePreview = { box: { origin: { x: box.x, y: box.y }, width: box.width * sx, height: box.height * sy, rotation: 0 },
                scaleX: sx, scaleY: sy, signedWidth: box.width * sx, signedHeight: box.height * sy, anchor: { x: cx, y: cy } };
            for (const id of leaves.get(root.id)!) {
                check(); const node = candidate.nodes.get(id); if (!node || node.kind === 'opaque' || node.kind === 'group') throw new Error('Stretch node changed');
                if (node.kind === 'connector') { connectors.push({ id, frame, delta }); await tick(); continue; }
                const b = scope.logicalBounds(id), px = b.x + b.width / 2, py = b.y + b.height / 2;
                const centreWorld = { x: cx + (px - cx) * sx + delta.x, y: cy + (py - cy) * sy + delta.y };
                if (![centreWorld.x, centreWorld.y].every(Number.isFinite)) throw new RangeError('Stretch placement overflows');
                const localAxis = axes.get(id), factors: KindResizeFactors = {
                    x: aspect || localAxis === 'x' ? factor : 1, y: aspect || localAxis === 'y' ? factor : 1,
                    zeroSignX: 1, zeroSignY: 1, handle: aspect && node.kind === 'text' ? 'corner' : 'side',
                    handleX: localAxis === 'x' ? 1 : 0, handleY: localAxis === 'y' ? 1 : 0, scope: 'multi' };
                const result = await prepareBoardLeafResize(node as Leaf, { runtime, doc: candidate, factors, centreWorld,
                    alignmentRotation: 0, signal, current, cooperate });
                leases.push(result); candidate = result.doc;
                for (const op of result.kindOps) { ops.push(op); await tick(); }
                for (const op of result.placementOps) { ops.push(op); await tick(); }
            }
        }
        // Default, calibration cut by owner: bound connectors resolve only after all selected targets.
        for (const item of connectors) {
            check(); const node = doc.nodes.get(item.id); if (!node || node.kind !== 'connector') throw new Error('Stretch connector changed');
            const result = await prepareConnectorResize({ runtime, source: doc, doc: candidate, node, frame: item.frame,
                translateWorld: item.delta, signal, current, cooperate });
            leases.push(result); candidate = result.doc;
            for (const op of result.ops) { ops.push(op); await tick(); }
        }
        const frozen: NodeSetOp[] = [];
        for (const op of ops) { frozen.push(Object.freeze(op)); await tick(); }
        // A notebook stretch that reaches the paper edge grows it in the same step, as every notebook edit does (R-24).
        const growth = await prepareNotebookTransform({ runtime, ids: roots.map(node => node.id), preview: { doc: candidate, ops: frozen }, signal, current, cooperate });
        if (growth) leases.push(growth);
        check(); return plan(growth ? growth.preview.doc : candidate, growth ? growth.ops : frozen);
    } catch (error) { release(); throw error; }
}

export async function stretchBoardLeaves(options: StretchLeavesOptions): Promise<void> {
    const plan = await prepareStretchBoardLeaves(options); plan.commit();
}
