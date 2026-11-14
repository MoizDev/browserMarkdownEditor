import { selectableAtFocus } from '../selection';
import { planDelete } from '../commands/delete';
import { createBoardSelectionCommands, type SelectionOrder } from '../commands/selection';
import { createBoardArrangementCommands } from '../commands/arrangement';
import { arrangeNotebook } from '../input/notebookArrange';
import type { Align, Axis } from '../geom/arrange';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';

export interface SelectionCommandDriverOptions {
    readonly runtime: BoardRuntime;
    readonly zoom: () => number;
    current(): boolean;
    /** The view's editable gate; document commands are refused while it is false. */
    canMutateView(): boolean;
    registerPending(cancel: () => void): () => void;
    error(error: unknown): void;
    keptLocked?(ids: readonly NodeId[]): void;
    cooperate?(): Promise<void>;
}

/** Keyboard, menu and accessibility routes can share these exact semantic
 * commands. Work is serialized and never opens a transaction before geometry. */
export function createSelectionCommandDriver(options: SelectionCommandDriverOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const live = () => !disposed && options.current() && runtime.session === session && session.owner === owner && session.doc === doc;
    const writable = () => live() && options.canMutateView() && !session.isReadOnly && !session.isGestureActive;
    const selection = createBoardSelectionCommands({ runtime, current: writable, zoom: options.zoom, cooperate });
    const arrangement = createBoardArrangementCommands({ runtime, current: writable, cooperate });
    const controllers = new Set<AbortController>();
    let disposed = false, epoch = 0, tail: Promise<void> = Promise.resolve();
    const cancel = () => { epoch++; for (const controller of controllers) controller.abort(); controllers.clear(); };
    type Work = (ids: readonly NodeId[], signal: AbortSignal, active: () => boolean) => Promise<void>;
    const schedule = (work: Work): boolean => {
        if (!writable()) return false;
        const snapshot = runtime.selection.getSnapshot(), ids = [...snapshot.selected], turn = epoch, controller = new AbortController();
        controllers.add(controller);
        let unregister: (() => void) | undefined;
        try { unregister = options.registerPending(() => controller.abort()); }
        catch (error) { controllers.delete(controller); options.error(error); return false; }
        const active = () => !controller.signal.aborted && turn === epoch && writable() && runtime.selection.getSnapshot() === snapshot;
        tail = tail.catch(() => {}).then(async () => { if (active()) await work(ids, controller.signal, active); })
            .catch(error => { if (!controller.signal.aborted && live()) options.error(error); })
            .finally(() => { controllers.delete(controller); unregister?.(); });
        return true;
    };
    const selectAll = (): boolean => {
        if (!live() || session.isGestureActive) return false;
        const snapshot = runtime.selection.getSnapshot(), revision = doc.rev, turn = epoch, controller = new AbortController();
        controllers.add(controller);
        let unregister: (() => void) | undefined;
        try { unregister = options.registerPending(() => controller.abort()); }
        catch (error) { controllers.delete(controller); options.error(error); return false; }
        const active = () => live() && !controller.signal.aborted && epoch === turn && doc.rev === revision
            && !session.isGestureActive && runtime.selection.getSnapshot() === snapshot;
        void (async () => {
            const children = doc.children.get(snapshot.focus) ?? [], ids: NodeId[] = [];
            for (let i = 0; i < children.length; i++) {
                if (!active()) return;
                const id = children[i].id;
                if (selectableAtFocus(doc, id, snapshot.focus, snapshot.sheet) === id) ids.push(id);
                if ((i & 255) === 255) { await cooperate(); if (!active()) return; }
            }
            if (active()) runtime.selection.replace(ids);
        })().catch(error => { if (active()) options.error(error); })
            .finally(() => { controllers.delete(controller); unregister?.(); });
        return true;
    };
    const remove = async (ids: readonly NodeId[], signal: AbortSignal, active: () => boolean) => {
        const state = runtime.selection.getSnapshot(), revision = doc.rev;
        const lease = await runtime.render.pinChangeGeometry(ids, signal, doc, active);
        try {
            signal.throwIfAborted();
            if (!active() || doc.rev !== revision || runtime.selection.getSnapshot() !== state) throw new DOMException('Delete target changed', 'AbortError');
            session.history.open('Delete');
            let builder: ReturnType<typeof session.begin> | undefined, open = true;
            try {
                builder = session.begin('tool', 'Delete');
                const result = planDelete(doc, builder, state.sheet, ids, runtime.render.changeGeometry);
                const applied = builder.commit(); builder = undefined;
                try { runtime.selection.reconcile(doc); } finally { applied.release(); }
                session.history.close(); open = false;
                if (result.kept.length) options.keptLocked?.(result.kept);
            } catch (error) {
                try { builder?.abort(); } finally { if (open) session.history.cancel(); }
                throw error;
            }
        } finally { lease.release(); }
    };
    const alignments: Readonly<Record<string, Align>> = { 'align.left': 'left', 'align.center': 'center', 'align.right': 'right',
        'align.top': 'top', 'align.middle': 'middle', 'align.bottom': 'bottom' };
    const orders: Readonly<Record<string, SelectionOrder>> = { 'arrange.back': 'back', 'arrange.backward': 'backward',
        'arrange.forward': 'forward', 'arrange.front': 'front' };
    const owned = (id: string): boolean => id === 'delete' || id === 'group' || id === 'ungroup' || id === 'lock' || id === 'frame.toggle'
        || id === 'distribute.horizontal' || id === 'distribute.vertical' || Object.hasOwn(alignments, id) || Object.hasOwn(orders, id);
    const run = (id: string): boolean => {
        if (id === 'select.all') return selectAll();
        // A view that refuses edits consumes these document commands so the host's global route cannot promote them.
        if (!writable()) return owned(id) && live() && (!options.canMutateView() || session.isReadOnly);
        const count = runtime.selection.getSnapshot().selected.length;
        if (!count) return false;
        if (id === 'delete') return schedule(remove);
        if (id === 'group') return count < 2 ? false : schedule((ids, signal) => selection.group(ids, signal).then(() => {}));
        if (id === 'ungroup') return schedule((ids, signal) => selection.ungroup(ids, signal).then(() => {}));
        if (id === 'lock') return schedule((ids, signal) => selection.toggleLocked(ids, signal));
        if (id === 'frame.toggle') return schedule((ids, signal) => {
            const allFrames = ids.every(value => doc.nodes.get(value)?.kind === 'frame');
            return allFrames ? selection.removeFrames(ids, signal).then(() => {}) : selection.frameSelection(ids, '', signal).then(() => {});
        });
        if (Object.hasOwn(orders, id)) return schedule((ids, signal) => selection.reorderSelection(ids, orders[id], signal));
        if (Object.hasOwn(alignments, id)) return count < 2 ? false : schedule((ids, signal, active) => doc.kind === 'notebook'
            ? arrangeNotebook({ runtime, ids, action: { kind: 'align', mode: alignments[id] }, signal, current: active, cooperate })
            : arrangement.align(ids, alignments[id], signal));
        if (id === 'distribute.horizontal' || id === 'distribute.vertical') {
            const axis: Axis = id.endsWith('horizontal') ? 'horizontal' : 'vertical';
            return count < 3 ? false : schedule((ids, signal, active) => doc.kind === 'notebook'
                ? arrangeNotebook({ runtime, ids, action: { kind: 'distribute', axis }, signal, current: active, cooperate })
                : arrangement.distribute(ids, axis, signal));
        }
        return false;
    };
    return { run, cancel, dispose() { if (!disposed) { disposed = true; cancel(); } } };
}
