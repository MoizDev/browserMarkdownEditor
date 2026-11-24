import { isLocked } from '../change/commands';
import { selectedRootsAsync } from '../geom/selectedRootsAsync';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp, Op, Transaction } from '../change/ops';
import { prepareNotebookTransform } from '../input/notebookTranslation';
import type { ArrangementAction, ArrangementServices } from '../geom/arrangement.types';
import { arrangementTransactionAsync } from '../geom/arrangementAsync';
import type { Align, Axis } from '../geom/arrange';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, isSheetParent, sheetOf } from '../model/doc';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { NodeId, ParentId } from '../model/ids';
import type { Node } from '../model/nodes';
import { acquireBoardGeometryScope, type BoardGeometryScope } from './geometryScope';
import { yieldToHost } from '../../platform/yieldToHost';

export interface BoardArrangementCommandOptions {
    readonly runtime: BoardRuntime;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}
export interface BoardArrangementPlan {
    readonly doc: BoardRuntime['session']['doc'];
    readonly ops: readonly Op[];
    commit(): void;
    cancel(): void;
}

/** Every arrangement is projected before mutation; source and final geometry
 * remain leased until the one commit or cancellation. */
export function createBoardArrangementCommands(options: BoardArrangementCommandOptions) {
    const { runtime } = options, cooperate = options.cooperate ?? yieldToHost;
    async function prepare(ids: readonly NodeId[], action: ArrangementAction, signal = new AbortController().signal): Promise<BoardArrangementPlan> {
        const session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
        const selection = runtime.selection.getSnapshot(), { sheet, focus } = selection;
        let font: number | undefined, released = false, source: BoardGeometryScope | undefined, final: BoardGeometryScope | undefined;
        let paperGrowth: { preview: { doc: BoardRuntime['session']['doc'] }; ops: readonly Op[]; release(): void } | undefined;
        const current = () => {
            const now = runtime.selection.getSnapshot();
            return !released && !signal.aborted && options.current() && session.doc === doc && session.owner === owner && doc.rev === revision
                && !session.isReadOnly && !session.isGestureActive && now.sheet === sheet && now.focus === focus
                && (font === undefined || runtime.render.text.fonts.epoch === font);
        };
        const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Arrangement became stale or unavailable', 'AbortError'); };
        const release = () => {
            if (released) return; released = true;
            try { paperGrowth?.release(); } finally {
                try { final?.release(); } finally { source?.release(); }
            }
            final = source = undefined; paperGrowth = undefined;
        };
        const plan = (projected: typeof doc, ops: readonly Op[], transaction?: Transaction): BoardArrangementPlan => {
            const frozen = Object.freeze(ops);
            return Object.freeze({ doc: projected, ops: frozen,
                commit() {
                    try {
                        check();
                        if (frozen.length) {
                            if (!transaction) throw new Error('Arrangement transaction is unavailable');
                            const applied = session.apply({ ...transaction, ops: frozen }); applied.release();
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
        try {
            check();
            const roots = await selectedRootsAsync(doc, ids, { signal, current, cooperate }); check();
            const eligible: NodeId[] = [];
            for (const node of roots) {
                if (sheetOf(doc, node.id) !== sheet) throw new Error('Arrangement selection spans another sheet');
                let parent: ParentId = node.parent, inFocus = node.id === focus || parent === focus;
                for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
                    const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Arrangement ancestor is missing');
                    parent = ancestor.parent; inFocus = parent === focus;
                }
                if (!inFocus) throw new Error('Arrangement selection is outside the current focus');
                if (node.kind !== 'opaque' && !isLocked(doc, node)) eligible.push(node.id);
                await tick();
            }
            if (!eligible.length) return plan(doc, []);
            source = await acquireBoardGeometryScope(runtime, eligible, { signal, current, cooperate }); check();
            font = runtime.render.text.fonts.epoch;
            const services: ArrangementServices = { logicalBounds: id => source!.logicalBounds(id), rank: id => source!.rank(id),
                geometry: runtime.render.changeGeometry };
            const transaction = await arrangementTransactionAsync(doc, eligible, action, services, { signal, current, cooperate }); check();
            if (!transaction.ops.length) return plan(doc, []);
            const ops: NodeSetOp[] = [];
            for (const op of transaction.ops) {
                if (op.t !== 'set') throw new Error('Arrangement produced a non-set operation'); ops.push(op); await tick();
            }
            const protectedRoots: { id: NodeId; pose: ReturnType<typeof worldPose> }[] = [], pending: Node[] = [];
            for (const id of eligible) { const node = doc.nodes.get(id); if (!node) throw new Error('Arrangement root disappeared'); pending.push(node); await tick(); }
            while (pending.length) {
                check(); const node = pending.pop()!;
                if (node.locked) { protectedRoots.push({ id: node.id, pose: worldPose(doc, node.id) }); await tick(); continue; }
                if (node.kind === 'group' || node.kind === 'frame') for (const child of childrenOf(doc, node.id)) { pending.push(child); await tick(); }
                await tick();
            }
            const project = () => projectBoardGeometrySets(doc, ops, { signal, current, cooperate });
            let candidate = await project(); check();
            for (const saved of protectedRoots) {
                const node = candidate.nodes.get(saved.id); if (!node) throw new Error('Protected arrangement descendant disappeared');
                const pose = poseInParent(candidate, node, node.parent, saved.pose);
                if (pose.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
                if (pose.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
                if (pose.rotation !== node.rotation) ops.push({ t: 'set', id: node.id, key: 'rotation', value: pose.rotation });
                await tick();
            }
            if (protectedRoots.length) { candidate = await project(); check(); }
            const staged = await acquireBoardGeometryScope(runtime, eligible, { doc: candidate, signal, current, cooperate });
            try {
                for (const id of eligible) {
                    check(); const original = doc.nodes.get(id), node = candidate.nodes.get(id);
                    if (!original || !node) throw new Error('Arrangement root disappeared');
                    const bounds = staged.logicalBounds(id), world = worldPose(candidate, id);
                    const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                        worldBoundsCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) };
                    const pose = poseInParent(doc, original, original.parent, world, geometry);
                    if (pose.page !== node.page) ops.push({ t: 'set', id, key: 'page', value: pose.page });
                    if (pose.x !== node.x) ops.push({ t: 'set', id, key: 'x', value: pose.x });
                    if (pose.y !== node.y) ops.push({ t: 'set', id, key: 'y', value: pose.y });
                    await tick();
                }
                const finalDoc = await project(); check();
                final = await acquireBoardGeometryScope(runtime, eligible, { doc: finalDoc, signal, current, cooperate }); check();
                const frozen: NodeSetOp[] = [];
                for (const op of ops) { frozen.push(Object.freeze(op)); await tick(); }
                // A notebook arrangement that reaches the paper edge grows it in the same step, as every notebook edit does (R-24).
                const growth = await prepareNotebookTransform({ runtime, ids: eligible, preview: { doc: finalDoc, ops: frozen }, signal, current, cooperate });
                if (growth) paperGrowth = growth;
                check(); return plan(growth ? growth.preview.doc : finalDoc, growth ? growth.ops : frozen, transaction);
            } finally { staged.release(); }
        } catch (error) { release(); throw error; }
    }
    async function arrange(ids: readonly NodeId[], action: ArrangementAction, signal?: AbortSignal): Promise<void> {
        const staged = await prepare(ids, action, signal); staged.commit();
    }
    return {
        prepare,
        arrange,
        align: (ids: readonly NodeId[], mode: Align, signal?: AbortSignal) => arrange(ids, { kind: 'align', mode }, signal),
        distribute: (ids: readonly NodeId[], axis: Axis, signal?: AbortSignal) => arrange(ids, { kind: 'distribute', axis }, signal),
        stack: (ids: readonly NodeId[], axis: Axis, signal?: AbortSignal) => arrange(ids, { kind: 'stack', axis }, signal),
        pack: (ids: readonly NodeId[], signal?: AbortSignal) => arrange(ids, { kind: 'pack' }, signal),
    };
}
