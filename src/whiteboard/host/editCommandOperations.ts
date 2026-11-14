import { isLocked, selectedRoots } from '../change/commands';
import { planDelete } from '../commands/delete';
import { createBoardSelectionCommands } from '../commands/selection';
import { childrenOf, hasOpaqueDescendant } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { Node } from '../model/nodes';
import { selectAllAtFocus, type SelectionSnapshot } from '../selection';
import type { BoardRuntime } from './runtime';

type State = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };
type Operation = { state(): State; run(): void | Promise<void> };
const enabled: State = Object.freeze({ enabled: true });
const disabled = (reason: string): State => ({ enabled: false, reason });

/** Commands use the session's selection and transaction authority, not a pane-local copy. */
export function createEditCommandOperations(options: {
    readonly runtime: BoardRuntime;
    readonly current: () => boolean;
    readonly frameName: () => string;
}) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    const commands = createBoardSelectionCommands({ runtime, current: options.current });
    const unavailable = (): State | undefined => {
        if (!options.current()) return disabled('Board session has ended');
        if (session.isReadOnly) return disabled(session.readOnlyReason ?? 'Board is read-only');
        if (session.isGestureActive) return disabled('Finish the current gesture first');
        return undefined;
    };
    let cached: { snapshot: SelectionSnapshot; revision: number; roots: Node[]; all: readonly NodeId[];
        problem?: string; structural?: string; ungroup?: string; lock?: string; unlocked: boolean } | undefined;
    const eligibility = () => {
        const snapshot = runtime.selection.getSnapshot();
        if (cached?.snapshot === snapshot && cached.revision === doc.rev) return cached;
        let roots: Node[] = [], problem: string | undefined, structural: string | undefined;
        let ungroup: string | undefined, lock: string | undefined;
        try { roots = selectedRoots(doc, snapshot.selected); }
        catch { problem = 'Selection is no longer available'; }
        for (const node of roots) {
            if (node.kind === 'opaque' || hasOpaqueDescendant(doc, node.id)) structural ??= 'Opaque content cannot be restructured';
            if (isLocked(doc, node)) structural ??= 'Locked content cannot be restructured';
            if (node.kind === 'opaque') lock ??= 'Opaque nodes cannot be unlocked';
            const parent = doc.nodes.get(node.parent as NodeId);
            if (parent && isLocked(doc, parent)) lock ??= 'A locked ancestor prevents changing the lock';
            if (node.kind !== 'group') ungroup ??= 'Select groups to ungroup';
            else {
                const pending = [...childrenOf(doc, node.id)];
                while (pending.length) {
                    const child = pending.pop()!;
                    if (child.kind === 'opaque' || child.locked) { ungroup ??= 'Locked or opaque descendants prevent ungrouping'; break; }
                    pending.push(...childrenOf(doc, child.id));
                }
            }
        }
        return cached = { snapshot, revision: doc.rev, roots, problem, structural, ungroup, lock,
            all: selectAllAtFocus(doc, snapshot.sheet, snapshot.focus),
            unlocked: [...doc.nodes.values()].some(node => node.locked && node.kind !== 'opaque') };
    };
    const selectionState = (minimum: number, reason?: 'structural' | 'ungroup' | 'lock'): State => {
        const blocked = unavailable(); if (blocked) return blocked;
        const data = eligibility();
        if (data.problem) return disabled(data.problem);
        if (data.roots.length < minimum) return disabled(minimum === 2 ? 'Select at least two items' : 'Select an item');
        const why = reason && data[reason];
        return why ? disabled(why) : enabled;
    };
    const requireState = (state: State) => { if (!state.enabled) throw new Error(state.reason); };
    const selected = () => [...runtime.selection.getSnapshot().selected];
    const operation = (state: () => State, action: () => void | Promise<void>): Operation => ({
        state, run() { requireState(state()); return action(); },
    });
    const structural = () => selectionState(1, 'structural');
    const deleteState = (): State => {
        const state = selectionState(1);
        if (!state.enabled) return state;
        for (const node of eligibility().roots) {
            if (node.kind === 'opaque' || hasOpaqueDescendant(doc, node.id)) return disabled('Opaque content cannot be deleted');
            if (isLocked(doc, node)) return disabled('Locked content cannot be deleted');
        }
        return enabled;
    };
    const deleteSelection = async () => {
        const before = runtime.selection.getSnapshot(), revision = doc.rev, ids = [...before.selected];
        const lease = await runtime.render.pinChangeGeometry(ids, new AbortController().signal);
        try {
            requireState(deleteState());
            if (doc.rev !== revision || runtime.selection.getSnapshot() !== before) throw new DOMException('Selection changed', 'AbortError');
            session.history.open('Delete');
            let builder: ReturnType<typeof session.begin> | undefined, open = true;
            try {
                builder = session.begin('tool', 'Delete');
                planDelete(doc, builder, before.sheet, ids, runtime.render.changeGeometry);
                const applied = builder.commit(); builder = undefined;
                try { runtime.selection.reconcile(doc); } finally { applied.release(); }
                session.history.close(); open = false;
            } catch (error) {
                try { builder?.abort(); } finally { if (open) session.history.cancel(); }
                throw error;
            }
        } finally { lease.release(); }
    };
    return {
        undo: operation(() => unavailable() ?? (session.history.canUndo ? enabled : disabled('Nothing to undo')), () => session.history.undo()),
        redo: operation(() => unavailable() ?? (session.history.canRedo ? enabled : disabled('Nothing to redo')), () => session.history.redo()),
        selectAll: operation(() => unavailable() ?? (eligibility().all.length ? enabled : disabled('Nothing to select')),
            () => { const snapshot = runtime.selection.getSnapshot(); runtime.selection.replace(selectAllAtFocus(doc, snapshot.sheet, snapshot.focus)); }),
        delete: operation(deleteState, deleteSelection),
        group: operation(() => selectionState(2, 'structural'), () => commands.group(selected()).then(() => {})),
        ungroup: operation(() => { const state = selectionState(1, 'structural'); return state.enabled ? selectionState(1, 'ungroup') : state; },
            () => commands.ungroup(selected()).then(() => {})),
        frameSelection: operation(structural, () => commands.frameSelection(selected(), options.frameName()).then(() => {})),
        toggleLocked: operation(() => selectionState(1, 'lock'), () => commands.toggleLocked(selected())),
        sendBack: operation(structural, () => commands.reorderSelection(selected(), 'back')),
        sendBackward: operation(structural, () => commands.reorderSelection(selected(), 'backward')),
        bringForward: operation(structural, () => commands.reorderSelection(selected(), 'forward')),
        bringFront: operation(structural, () => commands.reorderSelection(selected(), 'front')),
        unlockAll: operation(() => unavailable() ?? (eligibility().unlocked ? enabled : disabled('No locked items to unlock')),
            () => commands.unlockAll()),
    };
}
