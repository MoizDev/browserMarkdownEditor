import { isLocked, selectedRoots } from '../change/commands';
import type { ArrangementAction, ArrangementServices } from '../geom/arrangement.types';
import { arrangementTransaction } from '../geom/arrangement';
import type { Align, Axis } from '../geom/arrange';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, sheetOf } from '../model/doc';
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
            const transaction = arrangementTransaction(doc, eligible, action, services);
            check();
            if (!transaction.ops.length) return;
            const applied = session.apply(transaction);
            applied.release();
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
