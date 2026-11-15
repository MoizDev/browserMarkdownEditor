import type { Point } from '../../platform/render/camera';
import { isLocked } from '../change/commands';
import type { BoardRuntime } from '../host/runtime';
import type { BoardInputView } from '../input/attach';
import type { ToolStateSnapshot } from '../input/gesture';
import type { NodeId } from '../model/ids';
import { createAccessibilityOrder } from './accessibilityOrder';
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
    readonly contextMenu: (event: MouseEvent) => void;
    readonly error: (error: unknown) => void;
}

/** One bounded screen-reader mirror and one visual keyboard cursor per attached view. */
export function createBoardAccessibilityDom(options: BoardAccessibilityDomOptions) {
    if (options.engine.session !== options.runtime.session) throw new Error('Accessibility requires the existing board session');
    const root = document.createElement('section');
    root.setAttribute('aria-label', 'Whiteboard accessibility');
    root.style.cssText = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0';
    const status = document.createElement('div');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'assertive'); status.setAttribute('aria-atomic', 'true');
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
    const enterCanvas = document.createElement('button');
    enterCanvas.type = 'button'; enterCanvas.textContent = 'Move focus to canvas'; enterCanvas.hidden = true;
    enterCanvas.style.cssText = 'position:absolute;left:8px;top:8px;z-index:20;pointer-events:auto;clip-path:inset(50%);';
    options.overlay.append(enterCanvas);
    const canvasFocus = () => { enterCanvas.style.clipPath = 'none'; enterCanvas.style.outline = '2px solid #75b7ff'; };
    const canvasBlur = () => { enterCanvas.style.clipPath = 'inset(50%)'; enterCanvas.style.outline = ''; };
    const enter = () => { if (active()) options.surface.focus({ preventScroll: true }); };
    enterCanvas.addEventListener('focus', canvasFocus); enterCanvas.addEventListener('blur', canvasBlur); enterCanvas.addEventListener('click', enter);
    const cursor = document.createElement('div');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = 'position:absolute;left:0;top:0;width:12px;height:12px;border:2px solid #75b7ff;border-radius:50%;box-shadow:0 0 0 1px #fff;transform:translate(-50%,-50%);pointer-events:none;display:none;z-index:1';
    options.overlay.append(cursor);
    const exitPenMode = document.createElement('button');
    exitPenMode.type = 'button'; exitPenMode.textContent = 'Exit pen mode';
    exitPenMode.setAttribute('aria-label', 'Exit pen mode');
    exitPenMode.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2;pointer-events:auto;padding:5px 9px;border:1px solid #75b7ff;border-radius:5px;background:var(--background-primary,#25262a);color:var(--text-normal,#fff);font:inherit';
    exitPenMode.hidden = true; options.overlay.append(exitPenMode);
    const rows = new Map<NodeId, { item: HTMLLIElement; button: HTMLButtonElement }>();
    let disposed = false, scheduled: (() => void) | undefined, activate: (() => void) | undefined;
    let lastTool = '', lastSelection = '', lastCursorActive = false, lastAnnouncement = '', announcementVersion = 0;
    let repeated: (() => void) | undefined;
    const active = () => !disposed && options.current() && options.visible();
    const report = (error: unknown) => { try { options.error(error); } catch { /* A reporting failure cannot block cleanup. */ } };
    const announce = (message: string): boolean => {
        if (!active() || !message) return false;
        repeated?.(); repeated = undefined; announcementVersion++;
        lastAnnouncement = message; status.textContent = message;
        return true;
    };
    const repeat = (): boolean => {
        if (!active() || !lastAnnouncement) return false;
        repeated?.();
        const message = lastAnnouncement, version = ++announcementVersion;
        status.textContent = '';
        repeated = options.schedule(() => {
            repeated = undefined;
            if (active() && version === announcementVersion) status.textContent = message;
        });
        return true;
    };
    const order = createAccessibilityOrder({ runtime: options.runtime, current: active, schedule: options.schedule, error: report });
    const cursorClick = () => { if (active()) activate?.(); };
    const exitPen = () => {
        if (!active()) return;
        options.runtime.tools.setPenMode(false);
    };
    const menu = (event: MouseEvent) => {
        if (!active()) return;
        event.preventDefault(); options.contextMenu(event);
    };
    cursorButton.addEventListener('click', cursorClick); root.addEventListener('contextmenu', menu); enterCanvas.addEventListener('contextmenu', menu);
    exitPenMode.addEventListener('click', exitPen); exitPenMode.addEventListener('contextmenu', menu);
    const dropRows = () => { for (const row of rows.values()) row.item.remove(); rows.clear(); };
    const sync = () => {
        scheduled = undefined;
        if (!active()) { order.cancel(); root.hidden = true; enterCanvas.hidden = true; exitPenMode.hidden = true; cursor.style.display = 'none'; dropRows(); return; }
        root.hidden = false; enterCanvas.hidden = false; exitPenMode.hidden = !options.runtime.tools.penMode;
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
            lastSelection = selection; order.cancel();
            if (snapshot.selectedCount > 1) announce(`${snapshot.selectedCount} shapes selected.`);
            else if (snapshot.selectedCount === 1 && snapshot.focusedId) {
                const id = snapshot.focusedId as NodeId, focused = snapshot.items.find(item => item.id === id);
                const node = options.runtime.session.doc.nodes.get(id);
                const names: Readonly<Record<string, string>> = { stroke: 'Stroke', figure: 'Figure', text: 'Text', sticky: 'Note',
                    connector: 'Arrow', polyline: 'Line', frame: 'Frame', group: 'Group', picture: 'Picture', clip: 'Video',
                    linkcard: 'Bookmark', embed: 'Embed', opaque: 'Object' };
                const type = node ? names[node.kind] ?? 'Object' : 'Object', label = focused?.label?.trim() || type;
                const description = label.toLocaleLowerCase() === type.toLocaleLowerCase() ? type : `${label}, ${type}`;
                const ticket = ++announcementVersion;
                order.describe(id, (position, total) => {
                    if (active() && ticket === announcementVersion) announce(position && total ? `${description}. ${position} of ${total}.` : `${description} selected.`);
                });
            }
        }
    };
    const refresh = () => {
        if (disposed) return;
        if (!active()) { scheduled?.(); scheduled = undefined; repeated?.(); repeated = undefined; announcementVersion++; sync(); return; }
        // Input pauses may cancel their queued frame callbacks. Replace the
        // old request so reconnecting cannot leave this mirror permanently empty.
        scheduled?.(); scheduled = options.schedule(sync);
    };
    const unsubscribe = options.engine.accessibility.subscribe(refresh);
    const unsubscribePenMode = options.runtime.tools.subscribePenMode(enabled => {
        if (active()) {
            const wasFocused = document.activeElement === exitPenMode;
            exitPenMode.hidden = !enabled;
            if (!enabled && wasFocused) options.surface.focus({ preventScroll: true });
            announce(enabled ? 'Pen mode enabled.' : 'Pen mode disabled.');
        }
        else exitPenMode.hidden = true;
    }, report);
    const a11y: BoardInputView['a11y'] = {
        toolState(snapshot: ToolStateSnapshot) {
            if (!active()) return;
            const names: Readonly<Record<string, string>> = { pen: 'Draw', highlighter: 'Highlight', eraser: 'Eraser', select: 'Select',
                hand: 'Hand', connector: 'Arrow', polyline: 'Line', sticky: 'Note', text: 'Text', frame: 'Frame', laser: 'Laser', figure: 'Figure' };
            const name = names[snapshot.active.id] ?? snapshot.active.id;
            const tool = `${name}${snapshot.active.variant ? `, ${snapshot.active.variant}` : ''}${snapshot.locked ? ', locked' : ''}`;
            if (tool !== lastTool) { lastTool = tool; announce(`${tool}.`); }
        },
        repeatAnnouncement: repeat,
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
        announce, repeat,
        refresh,
        dispose() {
            if (disposed) return;
            disposed = true; scheduled?.(); scheduled = undefined; repeated?.(); repeated = undefined;
            announcementVersion++; lastAnnouncement = ''; order.dispose(); unsubscribe(); unsubscribePenMode(); activate = undefined;
            cursorButton.removeEventListener('click', cursorClick); root.removeEventListener('contextmenu', menu);
            enterCanvas.removeEventListener('contextmenu', menu); enterCanvas.removeEventListener('focus', canvasFocus);
            enterCanvas.removeEventListener('blur', canvasBlur); enterCanvas.removeEventListener('click', enter);
            exitPenMode.removeEventListener('click', exitPen); exitPenMode.removeEventListener('contextmenu', menu);
            dropRows(); enterCanvas.remove(); exitPenMode.remove(); cursor.remove(); root.remove();
        },
    };
}
