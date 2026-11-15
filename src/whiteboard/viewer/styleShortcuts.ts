import { isLocked } from '../change/commands';
import type { Op } from '../change/ops';
import { BoardStyleCommands } from '../chrome/styleCommands';
import { figureLabelGrowY } from '../text/edit/growth';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { InputToken } from '../input/tool';
import type { Fill } from '../model/styles';

export interface StyleShortcutOptions {
    readonly runtime: BoardRuntime;
    readonly inputToken: InputToken;
    hit(point: Readonly<{ x: number; y: number }>, signal: AbortSignal): Promise<NodeId | null>;
    current(): boolean;
    /** The view's editable gate; style and grid/focus writes are refused while it is false. */
    canMutateView(): boolean;
    registerPending(cancel: () => void): () => void;
    error(error: unknown): void;
    toggleWhiteboardTheme?(): void;
    cooperate?(): Promise<void>;
}

/** Hidden keyboard styles use the same document operations as chrome. They
 * collect recursive group descendants cooperatively before the one apply. */
export function createStyleShortcuts(options: StyleShortcutOptions) {
    const { runtime } = options, session = runtime.session, doc = session.doc, owner = session.owner;
    const cooperate = options.cooperate ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    const controllers = new Set<AbortController>();
    let disposed = false, generation = 0;
    const current = () => !disposed && options.current() && runtime.session === session && session.owner === owner && session.doc === doc;
    const writable = () => current() && options.canMutateView() && !session.isReadOnly && !session.isGestureActive;
    const commands = new BoardStyleCommands(session, () => runtime.selection.getSnapshot().selected, () => runtime.tools.getSnapshot().active.id,
        node => figureLabelGrowY(request => runtime.render.text.layout.measure(request), runtime.render.text.fonts.epoch, node));
    const cancel = () => { generation++; for (const controller of controllers) controller.abort(); controllers.clear(); };
    const change = (color: 'white' | null, fill: Fill | null): boolean => {
        if (!writable()) return false;
        const selection = runtime.selection.getSnapshot(), revision = doc.rev, tool = runtime.tools.getSnapshot().active.id;
        const turn = generation, controller = new AbortController(); controllers.add(controller);
        let unregister: (() => void) | undefined;
        try { unregister = options.registerPending(() => controller.abort()); }
        catch (error) { controllers.delete(controller); options.error(error); return false; }
        const active = () => writable() && !controller.signal.aborted && generation === turn && doc.rev === revision
            && runtime.selection.getSnapshot() === selection && runtime.tools.getSnapshot().active.id === tool;
        void (async () => {
            const next = { ...doc.ui.next }, key = tool === 'highlighter' ? 'highlighterColor' : 'color';
            if (color) next[key] = color;
            if (fill) next.fill = fill;
            const ops: Op[] = [];
            if ((color && next[key] !== doc.ui.next[key]) || (fill && next.fill !== doc.ui.next.fill)) ops.push({ t: 'board', key: 'ui.next', value: next });
            const stack = [...selection.selected], seen = new Set<NodeId>();
            let work = 0, started = performance.now();
            while (stack.length) {
                if (!active()) return;
                const id = stack.pop()!;
                if (seen.has(id)) continue;
                seen.add(id);
                const node = doc.nodes.get(id);
                if (node && !isLocked(doc, node)) {
                    if (node.kind === 'group') {
                        for (const child of doc.children.get(node.id) ?? []) {
                            stack.push(child.id);
                            if (++work >= 256 || performance.now() - started >= 3) { await cooperate(); if (!active()) return; work = 0; started = performance.now(); }
                        }
                    } else {
                        if (color && 'color' in node && node.color !== color) ops.push({ t: 'set', id: node.id, key: 'color', value: color });
                        if (fill && (node.kind === 'figure' || node.kind === 'connector') && node.fill !== fill) {
                            ops.push({ t: 'set', id: node.id, key: 'fill', value: fill });
                        }
                    }
                }
                if (++work >= 256 || performance.now() - started >= 3) { await cooperate(); if (!active()) return; work = 0; started = performance.now(); }
            }
            if (!active() || !ops.length) return;
            const label = color ? 'Change colour' : 'Change fill', content = ops.some(op => op.t === 'set');
            if (content) session.history.open(label);
            try { const applied = session.apply({ origin: 'tool', label, ops }); applied.release(); }
            finally { if (content) session.history.close(); }
        })().catch(error => { if (!controller.signal.aborted && current()) options.error(error); })
            .finally(() => { controllers.delete(controller); unregister?.(); });
        return true;
    };
    const sampleAtPointer = (): boolean => {
        if (!writable()) return false;
        const point = runtime.tools.presentedPointer(options.inputToken);
        if (!point) return false;
        const initial = { x: point.x, y: point.y }, revision = doc.rev, selection = runtime.selection.getSnapshot();
        const turn = generation, controller = new AbortController(); controllers.add(controller);
        let unregister: (() => void) | undefined;
        try { unregister = options.registerPending(() => controller.abort()); }
        catch (error) { controllers.delete(controller); options.error(error); return false; }
        const active = () => {
            const now = runtime.tools.presentedPointer(options.inputToken);
            return writable() && !controller.signal.aborted && generation === turn && doc.rev === revision
                && runtime.selection.getSnapshot() === selection && !!now && now.x === initial.x && now.y === initial.y;
        };
        void options.hit(initial, controller.signal).then(id => {
            if (id && active()) commands.sampleStyle(id);
        }).catch(error => { if (!controller.signal.aborted && current()) options.error(error); })
            .finally(() => { controllers.delete(controller); unregister?.(); });
        return true;
    };
    const flag = (key: 'view.grid' | 'view.focusMode'): boolean => {
        if (!writable()) return false;
        const value = key === 'view.grid' ? !doc.view.grid : !doc.view.focusMode;
        try { const applied = session.apply({ origin: 'tool', label: key === 'view.grid' ? 'Toggle grid' : 'Toggle focus mode',
            ops: [{ t: 'board', key, value }] }); applied.release(); }
        catch (error) { options.error(error); }
        return true;
    };
    const run = (id: string): boolean => {
        // grid and focus are document state too: a view that refuses edits consumes them instead of letting the global route promote them.
        const owned = id.startsWith('style.') || id === 'preferences.grid' || id === 'preferences.focus';
        if (owned && current() && (!options.canMutateView() || session.isReadOnly)) return true;
        switch (id) {
            case 'style.white': return change('white', null);
            case 'style.fill': return change(null, 'fill');
            case 'style.linedFill': return change(null, 'lined-fill');
            case 'style.sample': return sampleAtPointer();
            case 'preferences.grid': return flag('view.grid');
            case 'preferences.focus': return flag('view.focusMode');
            case 'preferences.theme':
                if (!current()) return false;
                if (doc.kind !== 'whiteboard') return true;
                if (!options.toggleWhiteboardTheme) return false;
                try { options.toggleWhiteboardTheme(); } catch (error) { options.error(error); }
                return true;
            default: return false;
        }
    };
    return { run, cancel, dispose() { if (!disposed) { disposed = true; cancel(); } } };
}
