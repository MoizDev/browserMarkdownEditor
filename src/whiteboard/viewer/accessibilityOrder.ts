import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import { selectableAtFocus } from '../selection';

export interface AccessibilityOrderOptions {
    readonly runtime: BoardRuntime;
    current(): boolean;
    schedule(callback: () => void): () => void;
    error(error: unknown): void;
}

/** Count eligible siblings without materializing an unbounded accessibility
 * mirror. A newer selection cancels the old scan before it can announce. */
export function createAccessibilityOrder(options: AccessibilityOrderOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    let disposed = false, generation = 0, unschedule: (() => void) | undefined;
    const cancel = () => { generation++; unschedule?.(); unschedule = undefined; };
    const describe = (id: NodeId, complete: (position: number | null, total: number) => void) => {
        cancel();
        if (disposed || !options.current()) return;
        const state = runtime.selection.getSnapshot(), revision = doc.rev, children = doc.children.get(state.focus), turn = generation;
        if (!children) { complete(null, 0); return; }
        let index = 0, count = 0, position: number | null = null;
        const active = () => !disposed && options.current() && runtime.session === session && session.owner === owner && session.doc === doc
            && doc.rev === revision && runtime.selection.getSnapshot() === state && doc.children.get(state.focus) === children && generation === turn;
        const step = () => {
            unschedule = undefined;
            if (!active()) return;
            try {
                const deadline = performance.now() + 3;
                let work = 0;
                while (index < children.length && work++ < 256 && performance.now() < deadline) {
                    const node = children[index++];
                    if (selectableAtFocus(doc, node.id, state.focus, state.sheet) !== node.id) continue;
                    count++;
                    if (node.id === id) position = count;
                }
                if (!active()) return;
                if (index < children.length) unschedule = options.schedule(step);
                else complete(position, count);
            } catch (error) { if (active()) options.error(error); }
        };
        unschedule = options.schedule(step);
    };
    return { describe, cancel, dispose() { if (!disposed) { cancel(); disposed = true; } } };
}
