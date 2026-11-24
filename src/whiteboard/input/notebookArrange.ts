import { isLocked, selectedRoots } from '../change/commands';
import type { NodeSetOp } from '../change/ops';
import { acquireBoardGeometryScope } from '../commands/geometryScope';
import { arrangementTransaction } from '../geom/arrangement';
import type { ArrangementAction, ArrangementServices } from '../geom/arrangement.types';
import type { BoardRuntime } from '../host/runtime';
import { isSheetParent, sheetOf } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import { projectBoardGeometrySets } from '../model/overlayDoc';
import { prepareNotebookTransform } from './notebookTranslation';
import { yieldToHost } from '../../platform/yieldToHost';

export interface NotebookArrangeOptions {
    readonly runtime: BoardRuntime;
    readonly ids: readonly NodeId[];
    readonly action: ArrangementAction;
    readonly signal: AbortSignal;
    current(): boolean;
    cooperate?(): Promise<void>;
}

/** Use the canonical arrangement transaction, projecting it only to determine
 * page growth and ownership before the single real apply. */
export async function arrangeNotebook(options: NotebookArrangeOptions): Promise<void> {
    const { runtime, signal } = options, session = runtime.session, doc = session.doc;
    if (doc.host.kind !== 'notebook') throw new Error('Notebook arrangement requires notebook paper');
    const owner = session.owner, revision = doc.rev, selection = runtime.selection.getSnapshot();
    const cooperate = options.cooperate ?? yieldToHost;
    const active = () => !signal.aborted && options.current() && runtime.session === session && session.owner === owner
        && session.doc === doc && doc.rev === revision && !session.isReadOnly && !session.isGestureActive
        && runtime.selection.getSnapshot() === selection;
    const check = () => { signal.throwIfAborted(); if (!active()) throw new DOMException('Notebook arrangement became stale', 'AbortError'); };
    check(); const roots = selectedRoots(doc, options.ids), eligible: NodeId[] = [];
    let work = 0, started = performance.now();
    for (const node of roots) {
        check();
        if (sheetOf(doc, node.id) !== selection.sheet) throw new Error('Arrangement selection spans another sheet');
        let parent: ParentId = node.parent, inFocus = node.id === selection.focus || parent === selection.focus;
        for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
            const ancestor = doc.nodes.get(parent as NodeId); if (!ancestor) throw new Error('Arrangement ancestor is missing');
            parent = ancestor.parent; inFocus = parent === selection.focus;
        }
        if (!inFocus) throw new Error('Arrangement selection is outside the current focus');
        if (node.kind !== 'opaque' && !isLocked(doc, node)) eligible.push(node.id);
        if (++work >= 128 || performance.now() - started >= 3) { await cooperate(); check(); work = 0; started = performance.now(); }
    }
    if (!eligible.length) return;
    const scope = await acquireBoardGeometryScope(runtime, eligible, { signal, current: active, cooperate });
    try {
        check();
        const services: ArrangementServices = { logicalBounds: id => scope.logicalBounds(id), rank: id => scope.rank(id), geometry: runtime.render.changeGeometry };
        const transaction = arrangementTransaction(doc, eligible, options.action, services); check();
        if (!transaction.ops.length) return;
        const sets: NodeSetOp[] = [];
        for (const op of transaction.ops) {
            if (op.t !== 'set') throw new Error('Arrangement emitted an unsupported projected operation');
            sets.push(op);
            if (++work >= 128 || performance.now() - started >= 3) { await cooperate(); check(); work = 0; started = performance.now(); }
        }
        const candidate = await projectBoardGeometrySets(doc, sets, { signal, current: active, cooperate }); check();
        const notebook = await prepareNotebookTransform({ runtime, ids: eligible, preview: { doc: candidate, ops: sets }, signal, current: active, cooperate });
        try {
            check(); const applied = session.apply({ ...transaction, ops: notebook?.ops ?? transaction.ops }); applied.release();
        } finally { notebook?.release(); }
    } finally { scope.release(); }
}
