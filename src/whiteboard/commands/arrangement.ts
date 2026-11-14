import { isLocked, selectedRoots } from '../change/commands';
import { poseInParent, worldPose, type ChangeGeometry } from '../change/coordinates';
import type { NodeSetOp } from '../change/ops';
import type { ArrangementAction, ArrangementServices } from '../geom/arrangement.types';
import { arrangementTransactionAsync } from '../geom/arrangementAsync';
import type { Align, Axis } from '../geom/arrange';
import type { BoardRuntime } from '../host/runtime';
import { childrenOf, isSheetParent, sheetOf } from '../model/doc';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import type { NodeId, ParentId } from '../model/ids';
import { acquireBoardGeometryScope } from './geometryScope';

export interface BoardArrangementCommandOptions {
    readonly runtime: BoardRuntime;
    readonly current: () => boolean;
    readonly cooperate?: () => Promise<void>;
}

/** Geometry is prepared before opening the one session transaction, and remains
 * leased through its commit or rollback. Stretch requires the async resize backend. */
export function createBoardArrangementCommands(options: BoardArrangementCommandOptions) {
    const { runtime } = options;
    async function arrange(ids: readonly NodeId[], action: ArrangementAction, signal = new AbortController().signal): Promise<void> {
        const session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
        const selection = runtime.selection.getSnapshot(), { sheet, focus } = selection;
        const check = () => {
            signal.throwIfAborted();
            const now = runtime.selection.getSnapshot();
            if (!options.current() || session.doc !== doc || session.owner !== owner || doc.rev !== revision
                || session.isReadOnly || session.isGestureActive || now.sheet !== sheet || now.focus !== focus) {
                throw new DOMException('Arrangement became stale or unavailable', 'AbortError');
            }
        };
        check();
        const roots = selectedRoots(doc, ids);
        for (const node of roots) {
            if (sheetOf(doc, node.id) !== sheet) throw new Error('Arrangement selection spans another sheet');
            let parent: ParentId = node.parent, inFocus = node.id === focus || parent === focus;
            for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
                const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Arrangement ancestor is missing');
                parent = ancestor.parent; inFocus = parent === focus;
            }
            if (!inFocus) throw new Error('Arrangement selection is outside the current focus');
        }
        // The shared arrangement planner intentionally excludes locked and opaque roots.
        const eligible = roots.filter(node => node.kind !== 'opaque' && !isLocked(doc, node)).map(node => node.id);
        if (!eligible.length) return;
        const scope = await acquireBoardGeometryScope(runtime, eligible, { signal, current: () => {
            const state = runtime.selection.getSnapshot();
            return options.current() && session.doc === doc && session.owner === owner && doc.rev === revision
                && !session.isReadOnly && !session.isGestureActive && state.sheet === sheet && state.focus === focus;
        }, cooperate: options.cooperate });
        try {
            check();
            const services: ArrangementServices = { logicalBounds: id => scope.logicalBounds(id), rank: id => scope.rank(id),
                // Normalization may ask about staged records during builder.push;
                // the original prepared scope stays pinned but is not the draft.
                geometry: runtime.render.changeGeometry };
            const transaction = await arrangementTransactionAsync(doc, eligible, action, services, { signal,
                current: () => { try { check(); return true; } catch { return false; } }, cooperate: options.cooperate });
            check();
            if (!transaction.ops.length) return;
            const ops: NodeSetOp[] = transaction.ops.map(op => { if (op.t !== 'set') throw new Error('Arrangement produced a non-set operation'); return op; });
            const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
            const protectedRoots: { id: NodeId; pose: ReturnType<typeof worldPose> }[] = [], pending = eligible.map(id => doc.nodes.get(id)!);
            let visited = 0;
            while (pending.length) {
                check(); const node = pending.pop()!;
                if (++visited % 256 === 0) { await cooperate(); check(); }
                if (node.locked) { protectedRoots.push({ id: node.id, pose: worldPose(doc, node.id) }); continue; }
                if (node.kind === 'group' || node.kind === 'frame') for (const child of childrenOf(doc, node.id)) pending.push(child);
            }
            const project = () => projectBoardGeometrySets(doc, ops, { signal, current: () => {
                try { check(); return true; } catch { return false; }
            }, cooperate });
            let candidate = await project(); check();
            for (const saved of protectedRoots) {
                const node = candidate.nodes.get(saved.id); if (!node) throw new Error('Protected arrangement descendant disappeared');
                const pose = poseInParent(candidate, node, node.parent, saved.pose);
                if (pose.x !== node.x) ops.push({ t: 'set', id: node.id, key: 'x', value: pose.x });
                if (pose.y !== node.y) ops.push({ t: 'set', id: node.id, key: 'y', value: pose.y });
                if (pose.rotation !== node.rotation) ops.push({ t: 'set', id: node.id, key: 'rotation', value: pose.rotation });
                if (++visited % 256 === 0) { await cooperate(); check(); }
            }
            if (protectedRoots.length) { candidate = await project(); check(); }
            const staged = await acquireBoardGeometryScope(runtime, eligible, { doc: candidate, signal, cooperate,
                current: () => { try { check(); return true; } catch { return false; } } });
            try {
                for (const id of eligible) {
                    check(); const original = doc.nodes.get(id)!, node = candidate.nodes.get(id)!;
                    const bounds = staged.logicalBounds(id), world = worldPose(candidate, id);
                    const geometry: ChangeGeometry = { resolvedTip: (d, connector, terminal) => runtime.render.changeGeometry.resolvedTip(d, connector, terminal),
                        worldBoundsCenter: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) };
                    const pose = poseInParent(doc, original, original.parent, world, geometry);
                    if (pose.page !== node.page) ops.push({ t: 'set', id, key: 'page', value: pose.page });
                    if (pose.x !== node.x) ops.push({ t: 'set', id, key: 'x', value: pose.x });
                    if (pose.y !== node.y) ops.push({ t: 'set', id, key: 'y', value: pose.y });
                }
                const finalDoc = await project(); check();
                const final = await acquireBoardGeometryScope(runtime, eligible, { doc: finalDoc, signal, cooperate,
                    current: () => { try { check(); return true; } catch { return false; } } });
                try { check(); const applied = session.apply({ ...transaction, ops }); applied.release(); }
                finally { final.release(); }
            } finally { staged.release(); }
        } finally { scope.release(); }
    }
    return {
        arrange,
        align: (ids: readonly NodeId[], mode: Align, signal?: AbortSignal) => arrange(ids, { kind: 'align', mode }, signal),
        distribute: (ids: readonly NodeId[], axis: Axis, signal?: AbortSignal) => arrange(ids, { kind: 'distribute', axis }, signal),
        stack: (ids: readonly NodeId[], axis: Axis, signal?: AbortSignal) => arrange(ids, { kind: 'stack', axis }, signal),
        pack: (ids: readonly NodeId[], signal?: AbortSignal) => arrange(ids, { kind: 'pack' }, signal),
    };
}
