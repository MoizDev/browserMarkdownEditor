import { acquireBoardGeometryScope } from '../commands/geometryScope';
import type { BoardRuntime } from '../host/runtime';
import { hasOpaqueDescendant } from '../model/doc';
import type { NodeId } from '../model/ids';
import { selectFirstChild, selectNext, selectParent, selectableAtFocus } from '../selection';

export type NavigationDirection = 'left' | 'right' | 'up' | 'down';
export interface SelectionNavigationOptions {
    readonly runtime: BoardRuntime;
    readonly current: () => boolean;
    /** Cancels the preceding reveal before projecting the new selected node. */
    readonly reveal: (id: NodeId | null) => void;
    readonly error: (error: unknown) => void;
    readonly cooperate?: () => Promise<void>;
}

/** Navigation changes session selection only; camera movement belongs to the shared reveal owner. */
export function createSelectionNavigation(options: SelectionNavigationOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    let serial = 0, disposed = false, controller: AbortController | undefined;
    const stopSelection = runtime.selection.subscribe(() => { serial++; controller?.abort(); });
    const active = () => !disposed && options.current() && session.doc === doc;
    const revealCurrent = () => options.reveal(runtime.selection.getSnapshot().active);
    return {
        next(direction: 1 | -1): boolean {
            if (!active()) return false;
            return selectNext(doc, runtime.selection, direction, id => options.reveal(id));
        },
        child(): boolean { if (!active() || !selectFirstChild(doc, runtime.selection)) return false; revealCurrent(); return true; },
        parent(): boolean { if (!active() || !selectParent(doc, runtime.selection)) return false; revealCurrent(); return true; },
        async cardinal(direction: NavigationDirection): Promise<boolean> {
            if (!active()) return false;
            if (!['left', 'right', 'up', 'down'].includes(direction)) throw new RangeError('Invalid selection navigation direction');
            controller?.abort(); controller = new AbortController(); const signal = controller.signal, turn = ++serial;
            const state = runtime.selection.getSnapshot(), owner = session.owner, revision = doc.rev, scene = runtime.scene, font = runtime.render.text.fonts.epoch;
            if (!state.active) return selectNext(doc, runtime.selection, 1, id => options.reveal(id));
            if (!scene?.ready || scene.revision !== revision) return false;
            const current = () => !signal.aborted && turn === serial && active() && session.owner === owner && doc.rev === revision
                && runtime.selection.getSnapshot() === state && runtime.render.text.fonts.epoch === font && scene.ready && scene.revision === revision;
            const check = () => { signal.throwIfAborted(); if (!current()) throw new DOMException('Navigation source changed', 'AbortError'); };
            const candidates = new Set<NodeId>(), axis = direction === 'left' || direction === 'right' ? 'y' : 'x';
            const cursor = scene.spatialCursor({ sheetId: state.sheet, purpose: 'selectable', request: { kind: 'strip', axis, value: 0 } });
            try {
                for (;;) {
                    check(); const status = cursor.resume({ deadline: performance.now() + 3, maxVisits: 256 }, ref => {
                        const hit = scene.resolveSpatial(ref); if (!hit) throw new DOMException('Navigation candidate expired', 'AbortError');
                        const id = selectableAtFocus(doc, hit.id, state.focus, state.sheet), node = id ? doc.nodes.get(id) : undefined;
                        if (id && id !== state.active && node && node.kind !== 'opaque' && !hasOpaqueDescendant(doc, id)) candidates.add(id);
                    });
                    if (status === 'complete') break;
                    if (status !== 'pending') throw new DOMException('Navigation query expired', 'AbortError');
                    await cooperate();
                }
            } finally { cursor.cancel(); }
            check(); if (!candidates.size) return false;
            const scope = await acquireBoardGeometryScope(runtime, [state.active, ...candidates], { signal, current, cooperate });
            try {
                check(); const source = scope.logicalBounds(state.active), sx = source.x + source.width / 2, sy = source.y + source.height / 2;
                let best: { id: NodeId; distance: number; side: number; rank: number } | undefined;
                for (const id of candidates) {
                    check(); const b = scope.logicalBounds(id), dx = b.x + b.width / 2 - sx, dy = b.y + b.height / 2 - sy;
                    const forward = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
                    if (!(forward > 0)) continue;
                    const side = Math.abs(axis === 'x' ? dx : dy), distance = Math.hypot(dx, dy), rank = scope.rank(id);
                    if (!best || distance < best.distance || (distance === best.distance && (side < best.side || (side === best.side && rank > best.rank))))
                        best = { id, distance, side, rank };
                }
                check(); if (!best) return false;
                runtime.selection.replace([best.id]); options.reveal(best.id); return true;
            } finally { scope.release(); }
        },
        cancel() { serial++; controller?.abort(); controller = undefined; options.reveal(null); },
        dispose() { if (disposed) return; disposed = true; serial++; controller?.abort(); controller = undefined; stopSelection(); options.reveal(null); },
    };
}
