import type { Point } from '../../platform/render/camera';
import { isLocked } from '../change/commands';
import type { BoardRuntime } from '../host/runtime';
import type { BoardInputView } from '../input/attach';
import type { ToolStateSnapshot } from '../input/gesture';
import type { NodeId } from '../model/ids';
import type { ViewerAccessibilitySnapshot, ViewerEngine } from './types';

export interface BoardAccessibilityDomOptions {
    readonly runtime: BoardRuntime;
    readonly engine: ViewerEngine;
    readonly surface: HTMLElement;
    readonly overlay: HTMLElement;
    readonly current: () => boolean;
    readonly visible: () => boolean;
    readonly schedule: (callback: () => void) => () => void;
    readonly reveal: (id: NodeId | null) => void;
    readonly error: (error: unknown) => void;
}

/** One bounded screen-reader mirror and one visual keyboard cursor per attached view. */
export function createBoardAccessibilityDom(options: BoardAccessibilityDomOptions) {
    if (options.engine.session !== options.runtime.session) throw new Error('Accessibility requires the existing board session');
    const root = document.createElement('section');
    root.setAttribute('aria-label', 'Whiteboard accessibility');
    root.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';
    const status = document.createElement('div');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    const cursorButton = document.createElement('button');
    cursorButton.type = 'button'; cursorButton.textContent = 'Use keyboard drawing cursor';
    cursorButton.setAttribute('aria-label', 'Use keyboard drawing cursor');
    const description = document.createElement('p');
    description.textContent = 'Move the cursor with arrow keys. Press Enter to start or finish, and Escape to cancel or leave cursor mode.';
    const heading = document.createElement('h2'); heading.textContent = 'Board objects';
    const summary = document.createElement('p');
    const list = document.createElement('ul'); list.setAttribute('aria-label', 'Board objects');
    root.append(status, cursorButton, description, heading, summary, list);
    options.overlay.append(root);
    const cursor = document.createElement('div');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = 'position:absolute;left:0;top:0;width:12px;height:12px;border:2px solid #75b7ff;border-radius:50%;box-shadow:0 0 0 1px #fff;transform:translate(-50%,-50%);pointer-events:none;display:none;z-index:1';
    options.overlay.append(cursor);
    const rows = new Map<NodeId, { item: HTMLLIElement; button: HTMLButtonElement }>();
    let disposed = false, scheduled: (() => void) | undefined, activate: (() => void) | undefined;
    let lastTool = '', lastSelection = '', lastCursorActive = false;
    const active = () => !disposed && options.current() && options.visible();
    const report = (error: unknown) => { try { options.error(error); } catch { /* A reporting failure cannot block cleanup. */ } };
    const announce = (message: string) => { if (active()) status.textContent = message; };
    const cursorClick = () => { if (active()) activate?.(); };
    cursorButton.addEventListener('click', cursorClick);
    const dropRows = () => { for (const row of rows.values()) row.item.remove(); rows.clear(); };
    const sync = () => {
        scheduled = undefined;
        if (!active()) { root.hidden = true; cursor.style.display = 'none'; dropRows(); return; }
        root.hidden = false;
        let snapshot: ViewerAccessibilitySnapshot;
        try { snapshot = options.engine.accessibility.getSnapshot(); }
        catch (error) { report(error); return; }
        summary.textContent = `${snapshot.sheetName || 'Sheet'}: ${snapshot.total} objects, ${snapshot.selectedCount} selected. Showing ${snapshot.items.length}.`;
        const keep = new Set<NodeId>();
        let position: ChildNode | null = list.firstChild;
        for (const item of snapshot.items) {
            const id = item.id as NodeId; keep.add(id);
            let row = rows.get(id);
            if (!row) {
                const li = document.createElement('li'), button = document.createElement('button');
                button.type = 'button';
                button.addEventListener('click', () => {
                    const doc = options.runtime.session.doc, node = doc.nodes.get(id);
                    if (!active() || !node || isLocked(doc, node)) return;
                    options.runtime.selection.replace([id]);
                    options.reveal(id);
                });
                li.append(button); row = { item: li, button }; rows.set(id, row);
            }
            const text = item.label || 'Untitled object', node = options.runtime.session.doc.nodes.get(id);
            const locked = !!node && isLocked(options.runtime.session.doc, node);
            if (row.button.textContent !== text) row.button.textContent = text;
            row.button.setAttribute('aria-label', `${text}, ${node?.kind ?? 'object'}${locked ? ', locked' : ''}`);
            row.button.setAttribute('aria-disabled', String(locked));
            row.button.setAttribute('aria-pressed', String(item.selected));
            if (row.item !== position) list.insertBefore(row.item, position);
            position = row.item.nextSibling;
        }
        for (const [id, row] of rows) if (!keep.has(id)) { row.item.remove(); rows.delete(id); }
        const selection = `${snapshot.focusedId ?? ''}:${snapshot.selectedCount}`;
        if (selection !== lastSelection) {
            lastSelection = selection;
            const focused = snapshot.items.find(item => item.id === snapshot.focusedId);
            announce(focused ? `${focused.label || 'Object'} selected. ${snapshot.selectedCount} selected.`
                : snapshot.selectedCount ? `${snapshot.selectedCount} objects selected.` : 'Selection cleared.');
        }
    };
    const refresh = () => {
        if (disposed) return;
        if (!active()) { scheduled?.(); scheduled = undefined; sync(); return; }
        if (!scheduled) scheduled = options.schedule(sync);
    };
    const unsubscribe = options.engine.accessibility.subscribe(refresh);
    const a11y: BoardInputView['a11y'] = {
        toolState(snapshot: ToolStateSnapshot) {
            if (!active()) return;
            const tool = `${snapshot.active.id}${snapshot.active.variant ? `, ${snapshot.active.variant}` : ''}${snapshot.locked ? ', locked' : ''}`;
            if (tool !== lastTool) { lastTool = tool; announce(`Tool: ${tool}.`); }
        },
        bindKeyboardCursor(callback) {
            activate = callback;
            return () => { if (activate === callback) activate = undefined; };
        },
        keyboardCursor(point: Point | null, gesture: boolean) {
            if (!active() || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
                cursor.style.display = 'none'; lastCursorActive = false; return;
            }
            cursor.style.left = `${point.x}px`; cursor.style.top = `${point.y}px`; cursor.style.display = 'block';
            cursor.style.background = gesture ? '#75b7ff' : 'transparent';
            if (gesture !== lastCursorActive) { lastCursorActive = gesture; announce(gesture ? 'Drawing gesture started.' : 'Drawing gesture ended.'); }
        },
    };
    refresh();
    return {
        a11y,
        refresh,
        dispose() {
            if (disposed) return;
            disposed = true; scheduled?.(); scheduled = undefined; unsubscribe(); activate = undefined;
            cursorButton.removeEventListener('click', cursorClick); dropRows(); cursor.remove(); root.remove();
        },
    };
}
