import type { CaretIndex, CaretPosition, CaretStop, TextPaint } from '../paint';
import type { RichText } from '../richText';
import { moveCaret } from './caret';
import { TextEditController, type EditTransactions } from './controller';
import { clientBounds, type TextTransform } from './geometry';
import type { ToggleMark } from './format';
import { EditHost, type EditSelection, type TextChange } from './host';
import { handleEditKey } from './keys';
import { TextPointerSelection, type TextPointer } from './pointer';
import { selectBlock, selectWord, wordBoundary } from './selection';
import type { NodeId } from '../../model/ids';
import type { Rect } from '../../../platform/types';

export interface EditLayout {
    readonly paint: TextPaint;
    readonly caret: CaretIndex;
    readonly localToClient: TextTransform;
    readonly clientToLocal: TextTransform;
}
export interface EditSessionServices extends EditTransactions {
    readText(): RichText;
    plainText(): string;
    alive(): boolean;
    layout(): EditLayout;
    composition(change: TextChange | null): void;
    compositionFormat(event: Event): void;
    command(name: string, selection: EditSelection): void;
    inList(offset: number): boolean;
    changed(selection: EditSelection): void;
    autoScroll(x: number, y: number): void;
    touchHandles(show: boolean): void;
    menu(x: number, y: number): void;
    finish(): void;
}

function point(transform: TextTransform, x: number, y: number): { x: number; y: number } {
    return { x: transform.a * x + transform.c * y + transform.e, y: transform.b * x + transform.d * y + transform.f };
}

// One session per editing pane. The host owns the input endpoint, while the
// session's model/history and TX-3 layout stay shared with the board view.
export class TextEditSession {
    readonly host: EditHost;
    readonly pointer: TextPointerSelection;
    readonly controller: TextEditController;
    private selection: EditSelection;
    private affinity: CaretPosition['affinity'];
    private goalX: number | undefined;
    private lastActivity = performance.now();
    private closed = false;

    constructor(container: HTMLElement, label: string, id: NodeId, key: 'text' | 'label', selection: EditSelection,
        private readonly services: EditSessionServices, private readonly mac: boolean, forceFallback = false) {
        this.selection = selection;
        this.controller = new TextEditController(id, key, services);
        this.pointer = new TextPointerSelection({
            selection: () => this.selection,
            setSelection: next => this.select(next),
            hit: (x, y) => { const layout = services.layout(); const p = point(layout.clientToLocal, x, y); return layout.caret.hitTest(p.x, p.y).offset; },
            word: offset => selectWord(services.plainText(), offset),
            block: offset => selectBlock(services.plainText(), offset),
            autoScroll: (x, y) => services.autoScroll(x, y),
            touchHandles: show => services.touchHandles(show),
            menu: (x, y) => services.menu(x, y),
        });
        this.host = new EditHost(container, label, {
            snapshot: () => ({ text: services.readText(), selection: this.selection }),
            change: change => this.replace(change, 'typing'),
            selection: next => this.select(next),
            composition: change => services.composition(change),
            compositionFormat: event => services.compositionFormat(event),
            commitComposition: change => this.replace(change, 'composition'),
            keydown: event => this.keydown(event),
            characterBounds: (start, end) => {
                const layout = services.layout();
                return layout.caret.characterBounds(start, end).map(rect => clientBounds(rect, layout.localToClient));
            },
        }, forceFallback);
    }

    private replace(change: TextChange, kind: 'typing' | 'composition' | 'boundary'): void {
        this.lastActivity = performance.now();
        this.controller.replace(change, kind, this.selection);
        this.selection = change.selection;
        this.affinity = undefined;
        this.goalX = undefined;
        this.services.changed(this.selection);
    }

    private select(next: EditSelection, moving = false): void {
        this.lastActivity = performance.now();
        this.selection = next;
        if (!moving) { this.affinity = undefined; this.goalX = undefined; }
        this.controller.setStoredMarks(null);
        this.services.setSelection(next);
        this.services.changed(next);
        this.host.sync();
    }

    private move(offset: number, direction: 'left' | 'right' | 'up' | 'down' | 'line-start' | 'line-end' | 'word-left' | 'word-right'): number {
        const layout = this.services.layout();
        const position = { offset, affinity: this.affinity };
        let stop: CaretStop;
        if (direction === 'word-left' || direction === 'word-right') {
            const step = direction === 'word-left' ? -1 : 1;
            const text = this.services.plainText();
            const current = layout.caret.caret(position);
            const next = moveCaret(layout.caret, current, step < 0 ? 'left' : 'right');
            const logicalStep = next.offset < current.offset ? -1 : 1;
            const boundary = wordBoundary(text, offset, logicalStep);
            let visual = current;
            for (let n = 0; n <= text.length; n++) {
                const candidate = moveCaret(layout.caret, visual, step < 0 ? 'left' : 'right');
                if (candidate === visual) break;
                visual = candidate;
                if (visual.offset === boundary || (logicalStep < 0 ? visual.offset < boundary : visual.offset > boundary)) break;
            }
            stop = visual;
        } else {
            if (direction === 'up' || direction === 'down') this.goalX ??= layout.caret.caret(position).x;
            else this.goalX = undefined;
            stop = moveCaret(layout.caret, position, direction, this.goalX);
        }
        this.affinity = stop.affinity;
        return stop.offset;
    }

    private keydown(event: KeyboardEvent): void {
        handleEditKey(event, {
            text: () => this.services.plainText(), selection: () => this.selection,
            setSelection: selection => this.select(selection, true), replace: change => { this.replace(change, 'typing'); this.host.sync(); },
            move: (offset, direction) => this.move(offset, direction),
            command: command => {
                const marks: Readonly<Record<string, ToggleMark>> = { bold: 'b', italic: 'i', underline: 'u', strike: 's', code: 'code', highlight: 'hl' };
                const mark = marks[command];
                if (mark) { this.controller.toggleMark(mark, this.selection); this.services.changed(this.selection); this.host.sync(); }
                else this.services.command(command, this.selection);
            },
            inList: () => this.services.inList(this.selection.focus),
        }, this.mac);
    }

    sync(): void {
        if (this.closed) return;
        if (!this.services.alive()) { this.close(false); return; }
        this.host.sync();
        const layout = this.services.layout();
        const { a, b, c, d, e, f } = layout.localToClient;
        const container = this.host.element.parentElement?.getBoundingClientRect();
        Object.assign(this.host.element.style, { left: '0px', top: '0px', width: `${layout.paint.box.w}px`, height: `${layout.paint.box.h}px`, transformOrigin: '0 0', transform: `matrix(${a},${b},${c},${d},${e - (container?.left ?? 0)},${f - (container?.top ?? 0)})` });
        const stop = layout.caret.caret({ offset: this.selection.focus, affinity: this.affinity });
        const selection = layout.caret.selection(Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus));
        const rect = selection[0] ?? { x: stop.x, y: stop.top, width: 0, height: stop.bottom - stop.top };
        this.host.updateBounds(clientBounds({ x: 0, y: 0, width: layout.paint.box.w, height: layout.paint.box.h }, layout.localToClient), clientBounds(rect, layout.localToClient));
    }

    chrome(now: number, reducedMotion: boolean, devicePixelRatio: number): { selection: readonly Rect[]; caret: Rect | null } {
        const layout = this.services.layout();
        const selection = layout.caret.selection(Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus));
        const stop = layout.caret.caret({ offset: this.selection.focus, affinity: this.affinity });
        const active = now - this.lastActivity;
        const visible = reducedMotion || active < 530 || Math.floor(active / 530) % 2 === 0;
        const scale = Math.hypot(layout.localToClient.a, layout.localToClient.b) * Math.max(devicePixelRatio, 0.01);
        const caret = visible && this.selection.anchor === this.selection.focus
            ? { x: stop.x, y: stop.top, width: 1.5 / Math.max(scale, 0.0001), height: stop.bottom - stop.top } : null;
        return { selection, caret };
    }

    applyLink(url: string, selection: EditSelection): boolean {
        const applied = this.controller.applyLink(url, selection);
        if (applied) { this.selection = selection; this.services.changed(selection); this.host.focus(); }
        return applied;
    }

    pointerDown(pointer: TextPointer, handle?: 'anchor' | 'focus'): void { this.pointer.down(pointer, handle); }
    pointerMove(pointer: TextPointer): void { this.pointer.move(pointer); }
    pointerUp(id: number): void { this.pointer.up(id); }
    focus(): void { this.sync(); this.host.focus(); }
    close(commitComposition = true): void {
        if (this.closed) return;
        this.host.finishComposition(commitComposition);
        this.closed = true;
        this.pointer.dispose(); this.host.dispose(); this.services.finish();
    }
}
