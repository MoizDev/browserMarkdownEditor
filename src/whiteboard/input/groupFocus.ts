import { isLocked } from '../change/commands';
import type { Vec2 } from '../geom/path';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId, ParentId } from '../model/ids';
import type { SelectionSnapshot } from '../selection';
import { isCancellation } from '../../platform/workers/envelope';
import { yieldToHost } from '../../platform/yieldToHost';

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

export interface LeaveGroupOptions {
    readonly runtime: BoardRuntime;
    readonly point: Vec2;
    /** Surface px per world unit, so the probe reaches what the point query's 8 px margin reaches. */
    readonly zoom: () => number;
    readonly current: () => boolean;
    readonly hold: () => () => void;
    readonly registerPending: (cancel: () => void) => () => void;
    readonly error: (error: unknown) => void;
}

/** A press on empty canvas outside the focused group's bounds leaves its focus layer (catalogue S§4.6, S§22). The bounds test is
 * the scene's broad phase: any indexed node under the point whose ancestry reaches the group keeps the focus. A press inside
 * the group's bounds keeps it, so empty space between a group's children still works. */
export function leaveGroupAtPoint(options: LeaveGroupOptions): void {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner, revision = doc.rev;
    const before = runtime.selection.getSnapshot();
    if (!options.current() || before.focus === before.sheet || !doc.nodes.get(before.focus as NodeId)) return;
    const groupId = before.focus as NodeId, scene = runtime.scene;
    if (!scene || !scene.ready) return;
    const controller = new AbortController(), release = options.hold();
    let unregister: (() => void) | undefined;
    const validOwner = () => options.current() && session.owner === owner && session.doc === doc && doc.rev === revision
        && runtime.selection.getSnapshot() === before;
    try { unregister = options.registerPending(() => controller.abort()); }
    catch (error) { release(); throw error; }
    void (async () => {
        const cursor = scene.spatialCursor({ sheetId: before.sheet, purpose: 'selectable', includeLocked: true,
            request: { kind: 'point', x: options.point.x, y: options.point.y, maxDistance: 8 / options.zoom() } });
        let inside = false;
        try {
            for (;;) {
                controller.signal.throwIfAborted();
                if (!validOwner()) return;
                const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 256 }, ref => {
                    if (inside) return;
                    const resolved = scene.resolveSpatial(ref);
                    if (!resolved) return;
                    let parent: ParentId | undefined = doc.nodes.get(resolved.id)?.parent;
                    for (let depth = 0; parent !== undefined && depth < 64; depth++) {
                        if (parent === groupId) { inside = true; return; }
                        parent = doc.nodes.get(parent as NodeId)?.parent;
                    }
                });
                if (inside || status === 'complete') break;
                if (status !== 'pending') return;
                await yieldToHost();
            }
        } finally { cursor.cancel(); }
        if (!inside && validOwner()) runtime.selection.setFocus(before.sheet);
    })().catch(error => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) options.error(error);
    }).finally(() => {
        try { unregister?.(); } finally { unregister = undefined; release(); }
    });
}
