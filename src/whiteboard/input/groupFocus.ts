import { isLocked } from '../change/commands';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { SelectionSnapshot } from '../selection';
import { isCancellation } from '../../platform/workers/envelope';

export interface GroupFocusOptions {
    readonly runtime: BoardRuntime;
    readonly point: Vec2;
    readonly current: () => boolean;
    readonly hit: (point: Vec2, signal: AbortSignal) => Promise<NodeId | null>;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly error: (error: unknown) => void;
}

/** Enter a selected group only after the real point query proves both the
 * outer group and its child. Selection scope changes never create history. */
export function enterGroupAtPoint(options: GroupFocusOptions): boolean {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const before = runtime.selection.getSnapshot(), group = before.active ? doc.nodes.get(before.active) : undefined;
    if (!options.current() || !group || group.kind !== 'group' || isLocked(doc, group)
        || before.selected.length !== 1 || before.selected[0] !== group.id) return false;
    const controller = new AbortController(), release = options.hold();
    let unregister: (() => void) | undefined, entered: SelectionSnapshot | undefined, committed = false;
    const validOwner = () => options.current() && session.owner === owner && session.doc === doc;
    const restore = () => {
        if (!committed && entered && validOwner() && runtime.selection.getSnapshot() === entered) {
            runtime.selection.restore(doc, before.sheet, before.selected, before.focus, before.active);
        }
    };
    const cancel = () => { controller.abort(); restore(); };
    try { unregister = options.registerPending(cancel); }
    catch (error) { release(); throw error; }
    void (async () => {
        const check = (selection: SelectionSnapshot) => {
            controller.signal.throwIfAborted();
            if (!validOwner() || doc.rev !== revision || runtime.selection.getSnapshot() !== selection) {
                throw new DOMException('Group entry became stale', 'AbortError');
            }
        };
        check(before);
        const outer = await options.hit(options.point, controller.signal); check(before);
        if (outer !== group.id) return;
        runtime.selection.setScope(group.id, []); entered = runtime.selection.getSnapshot(); check(entered);
        const child = await options.hit(options.point, controller.signal); check(entered);
        if (!child || child === group.id) return;
        runtime.selection.setScope(group.id, [child]); committed = true;
    })().catch(error => {
        if (!controller.signal.aborted && !isCancellation(error)) options.error(error);
    }).finally(() => {
        try { restore(); } finally { try { unregister?.(); } finally { release(); } }
    }).catch(options.error);
    return true;
}
