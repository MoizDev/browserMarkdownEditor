import { isLocked, selectedRoots } from '../change/commands';
import { createBoardArrangementCommands } from '../commands/arrangement';
import type { Align, Axis } from '../geom/arrange';
import { isSheetParent, sheetOf } from '../model/doc';
import type { NodeId, ParentId } from '../model/ids';
import type { SelectionSnapshot } from '../selection';
import type { BoardRuntime } from './runtime';

type State = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };
type Operation = { state(): State; run(): Promise<void> };
const enabled: State = Object.freeze({ enabled: true });
const disabled = (reason: string): State => ({ enabled: false, reason });

/** UI operations delegate geometry, transaction and receipt ownership to the arrangement backend. */
export function createArrangementCommandOperations(options: {
    readonly runtime: BoardRuntime;
    readonly current: () => boolean;
    /** This view's own editable state; a mutating arrangement re-checks it at run time, not only when shown. */
    readonly canWrite: () => boolean;
}) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    const commands = createBoardArrangementCommands(options);
    let cached: { selection: SelectionSnapshot; revision: number; count: number; problem?: string } | undefined;
    const eligibility = () => {
        const selection = runtime.selection.getSnapshot();
        if (cached?.selection === selection && cached.revision === doc.rev) return cached;
        let count = 0, problem: string | undefined;
        try {
            for (const node of selectedRoots(doc, selection.selected)) {
                if (sheetOf(doc, node.id) !== selection.sheet) { problem = 'Selection spans another sheet'; break; }
                let parent: ParentId = node.parent, inFocus = node.id === selection.focus || parent === selection.focus;
                for (let depth = 0; !inFocus && !isSheetParent(doc, parent) && depth < 64; depth++) {
                    const ancestor = doc.nodes.get(parent as NodeId);
                    if (!ancestor) { problem = 'Selection parent is unavailable'; break; }
                    parent = ancestor.parent; inFocus = parent === selection.focus;
                }
                if (problem) break;
                if (!inFocus) { problem = 'Selection is outside the current focus'; break; }
                if (node.kind !== 'opaque' && !isLocked(doc, node)) count++;
            }
        } catch { problem = 'Selection is no longer available'; }
        return cached = { selection, revision: doc.rev, count, problem };
    };
    const state = (minimum: number): State => {
        if (!options.current()) return disabled('Board session has ended');
        if (session.isReadOnly) return disabled(session.readOnlyReason ?? 'Board is read-only');
        if (!options.canWrite()) return disabled('Board view is read-only');
        if (session.isGestureActive) return disabled('Finish the current gesture first');
        const eligible = eligibility();
        if (eligible.problem) return disabled(eligible.problem);
        if (eligible.count < minimum) return disabled(`Select at least ${minimum} unlocked, supported items`);
        return enabled;
    };
    const operation = (minimum: number, run: (ids: readonly NodeId[]) => Promise<void>): Operation => ({
        state: () => state(minimum),
        run() {
            const available = state(minimum);
            if (!available.enabled) return Promise.reject(new Error(available.reason));
            return run([...runtime.selection.getSnapshot().selected]);
        },
    });
    const align = (mode: Align) => operation(2, ids => commands.align(ids, mode));
    const distribute = (axis: Axis) => operation(3, ids => commands.distribute(ids, axis));
    const stack = (axis: Axis) => operation(2, ids => commands.stack(ids, axis));
    return {
        alignLeft: align('left'), alignHorizontal: align('center'), alignRight: align('right'),
        alignTop: align('top'), alignVertical: align('middle'), alignBottom: align('bottom'),
        distributeHorizontal: distribute('horizontal'), distributeVertical: distribute('vertical'),
        stackHorizontal: stack('horizontal'), stackVertical: stack('vertical'),
        pack: operation(2, ids => commands.pack(ids)),
    };
}
