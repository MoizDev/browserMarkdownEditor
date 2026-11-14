import type { CaretIndex, CaretPosition, CaretStop, TextPaint } from '../paint';
import { sliceRichText, type RichFragment } from '../richText';
import { moveCaret } from './caret';
import { TextEditController, type EditTransactions } from './controller';
import { clientBounds, type TextTransform } from './geometry';
import { linkUrl, type ToggleMark } from './format';
import { EditHost, type EditSelection, type TextChange } from './host';
import { handleEditKey } from './keys';
import { TextPointerSelection, type TextPointer } from './pointer';
import { selectBlock, selectWord, wordBoundary } from './selection';
import type { NodeId } from '../../model/ids';
import type { HistoryController } from '../../change/historyTypes';
import { TypingHistory } from './typingHistory';
import type { Rect } from '../../../platform/types';

export interface EditLayout {
    readonly paint: TextPaint;
    readonly caret: CaretIndex;
    readonly localToClient: TextTransform;
    readonly clientToLocal: TextTransform;
}
export interface EditSessionServices extends Omit<EditTransactions, 'typing' | 'completeTyping' | 'markTransformation' | 'rememberTransformation'> {
    readonly history: HistoryController;
    plainText(): string;
    alive(): boolean;
    layout(): EditLayout;
    composition(change: TextChange | null): void;
    compositionFormat(event: Event): void;
    command(name: string, selection: EditSelection): void;
    inList(offset: number): boolean;
    changed(selection: EditSelection): void;
    reportError(error: unknown): void;
    autoScroll(x: number, y: number): void;
    stopAutoScroll(): void;
    touchHandles(show: boolean): void;
    menu(x: number, y: number): void;
    openLink(url: string): void;
    isStandaloneText(): boolean;
    /** The creation step token for a text node created by this edit session. */
    readonly creationToken?: number;
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
    private readonly typingHistory: TypingHistory;
    private selection: EditSelection;
    private affinity: CaretPosition['affinity'];
    private goalX: number | undefined;
    private lastActivity = performance.now();
    private formats: readonly { from: number; to: number; style: string; thickness: string }[] = [];
    private compositionSelection: EditSelection | null = null;
    private compositionRange: { from: number; to: number } | null = null;
    private closed = false;

    constructor(container: HTMLElement, label: string, private readonly id: NodeId, private readonly key: 'text' | 'label', selection: EditSelection,
        private readonly services: EditSessionServices, private readonly mac: boolean, forceFallback = false) {
        this.selection = selection;
        this.typingHistory = new TypingHistory(services.history, next => this.restoreSelection(next));
        this.controller = new TextEditController(id, key, {
            apply: transaction => services.apply(transaction), readText: () => services.readText(),
            setSelection: next => { this.selection = next; services.setSelection(next); }, marksAt: offset => services.marksAt(offset),
            fragment: (from, text, marks) => services.fragment(from, text, marks),
            format: (mark, from, to) => services.format(mark, from, to),
            link: (url, from, to) => services.link(url, from, to),
            typing: (kind, before, after, change) => this.typingHistory.begin(kind, before, after, change),
            completeTyping: (kind, after) => this.typingHistory.complete(kind, after),
            markTransformation: () => this.typingHistory.mark(),
            rememberTransformation: (mark, before) => this.typingHistory.remember(mark, before),
        });
        this.pointer = new TextPointerSelection({
            selection: () => this.selection,
            setSelection: next => this.select(next),
            hit: (x, y) => { const layout = services.layout(); const p = point(layout.clientToLocal, x, y); return layout.caret.hitTest(p.x, p.y).offset; },
            word: offset => selectWord(services.plainText(), offset),
            block: offset => selectBlock(services.plainText(), offset),
            autoScroll: (x, y) => services.autoScroll(x, y),
            stopAutoScroll: () => services.stopAutoScroll(),
            touchHandles: show => services.touchHandles(show),
            menu: (x, y) => services.menu(x, y),
            followLink: (x, y) => {
                const layout = services.layout();
                const local = point(layout.clientToLocal, x, y);
                for (const line of layout.caret.lines) for (const cluster of line.clusters) {
                    const box = cluster.bounds;
                    if (local.x < box.x || local.x > box.x + box.width || local.y < box.y || local.y > box.y + box.height) continue;
                    const value = sliceRichText(services.readText(), cluster.src[0], cluster.src[1]).blocks[0]?.runs[0]?.marks.link;
                    const url = value ? linkUrl(value) : null;
                    if (!url) return false;
                    services.openLink(url);
                    return true;
                }
                return false;
            },
        });
        this.host = new EditHost(container, label, {
            snapshot: () => ({ text: services.readText(), selection: this.selection }),
            change: change => this.replace(change, 'typing'),
            selection: next => this.select(next),
            composition: change => {
                if (change) {
                    this.compositionSelection ??= this.selection;
                    this.compositionRange = { from: change.from, to: change.from + change.text.length };
                    this.selection = change.selection;
                } else {
                    this.formats = [];
                    this.compositionRange = null;
                    if (this.compositionSelection) this.selection = this.compositionSelection;
                    this.compositionSelection = null;
                }
                services.composition(change);
                services.changed(this.selection);
            },
            compositionFormat: event => {
                const update = event as Event & { getTextFormats?: () => readonly { rangeStart: number; rangeEnd: number; underlineStyle: string; underlineThickness: string }[] };
                const base = this.host.textOffsetBase;
                this.formats = (update.getTextFormats?.() ?? []).map(format => ({ from: base + format.rangeStart, to: base + format.rangeEnd, style: format.underlineStyle, thickness: format.underlineThickness }));
                services.compositionFormat(event);
                services.changed(this.selection);
            },
            commitComposition: change => this.replace(change, 'composition'),
            keydown: event => this.keydown(event),
            contextMenu: (x, y) => services.menu(x, y),
            characterBounds: (start, end) => {
                const layout = services.layout();
                return layout.caret.characterBounds(start, end).map(rect => clientBounds(rect, layout.localToClient));
            },
        }, forceFallback);
    }

    private replace(change: TextChange, kind: 'typing' | 'composition' | 'boundary'): void {
        this.lastActivity = performance.now();
        try { this.selection = this.controller.replace(change, kind, this.selection); }
        catch (error) { this.services.reportError(error); return; }
        this.affinity = undefined;
        this.goalX = undefined;
        this.services.changed(this.selection);
    }

    private select(next: EditSelection, moving = false): void {
        if (!moving && next.anchor === this.selection.anchor && next.focus === this.selection.focus) return;
        this.lastActivity = performance.now();
        this.typingHistory.invalidateRule();
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
        if (!event.isComposing && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
            event.preventDefault(); event.stopPropagation();
            const layout = this.services.layout();
            const caret = layout.caret.caret({ offset: this.selection.focus, affinity: this.affinity });
            const at = point(layout.localToClient, caret.x, caret.bottom);
            this.services.menu(at.x, at.y);
            return;
        }
        handleEditKey(event, {
            text: () => this.services.plainText(), selection: () => this.selection,
            setSelection: selection => this.select(selection, true), replace: change => { this.replace(change, 'typing'); this.host.sync(); },
            move: (offset, direction) => this.move(offset, direction),
            collapse: (selection, direction) => {
                const index = this.services.layout().caret;
                const a = index.caret({ offset: selection.anchor });
                const b = index.caret({ offset: selection.focus, affinity: this.affinity });
                const first = a.line < b.line || (a.line === b.line && a.x <= b.x) ? a : b;
                const last = first === a ? b : a;
                const stop = direction === 'left' ? first : last;
                this.affinity = stop.affinity;
                this.goalX = undefined;
                return stop.offset;
            },
            command: command => {
                const marks: Readonly<Record<string, ToggleMark>> = { bold: 'b', italic: 'i', underline: 'u', strike: 's', code: 'code', highlight: 'hl' };
                const mark = marks[command];
                if (mark) {
                    try { this.controller.toggleMark(mark, this.selection); this.services.changed(this.selection); }
                    catch (error) { this.services.reportError(error); }
                    this.host.sync();
                } else {
                    if (command === 'undo' || command === 'redo' || command === 'finish') this.typingHistory.close();
                    this.services.command(command, this.selection);
                }
            },
            inList: () => this.services.inList(this.selection.focus),
            undoTransformation: () => this.typingHistory.undoTransformation(),
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
        const rects = selection.length ? selection : [{ x: stop.x, y: stop.top, width: 0, height: stop.bottom - stop.top }];
        const client = rects.map(rect => clientBounds(rect, layout.localToClient));
        const bounds = client.reduce((union, rect) => {
            const left = Math.min(union.left, rect.left), top = Math.min(union.top, rect.top);
            const right = Math.max(union.right, rect.right), bottom = Math.max(union.bottom, rect.bottom);
            return new DOMRect(left, top, right - left, bottom - top);
        });
        this.host.updateBounds(clientBounds({ x: 0, y: 0, width: layout.paint.box.w, height: layout.paint.box.h }, layout.localToClient), bounds);
    }

    chrome(now: number, reducedMotion: boolean, devicePixelRatio: number): {
        selection: readonly Rect[]; caret: Rect | null;
        composition: readonly { rect: Rect; style: string; thickness: string }[];
        handles: { anchor: { x: number; y: number }; focus: { x: number; y: number } };
    } {
        const layout = this.services.layout();
        const selection = layout.caret.selection(Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus));
        const stop = layout.caret.caret({ offset: this.selection.focus, affinity: this.affinity });
        const active = now - this.lastActivity;
        const visible = reducedMotion || active < 530 || Math.floor(active / 530) % 2 === 0;
        const scale = Math.hypot(layout.localToClient.a, layout.localToClient.b) * Math.max(devicePixelRatio, 0.01);
        const caret = visible && this.selection.anchor === this.selection.focus
            ? { x: stop.x, y: stop.top, width: 1.5 / Math.max(scale, 0.0001), height: stop.bottom - stop.top } : null;
        const formats = this.formats.length ? this.formats : this.compositionRange ? [{ ...this.compositionRange, style: 'solid', thickness: 'thin' }] : [];
        const composition = formats.flatMap(format => layout.caret.selection(format.from, format.to).map(rect => ({ rect, style: format.style, thickness: format.thickness })));
        const anchor = layout.caret.caret({ offset: this.selection.anchor });
        const focus = layout.caret.caret({ offset: this.selection.focus, affinity: this.affinity });
        const handles = { anchor: point(layout.localToClient, anchor.x, anchor.bottom), focus: point(layout.localToClient, focus.x, focus.bottom) };
        return { selection, caret, composition, handles };
    }

    externalChange(): void { this.typingHistory.close(); this.sync(); }
    getSelection(): EditSelection { return this.selection; }
    selectAll(): void { this.select({ anchor: 0, focus: this.services.plainText().length }); }
    restoreSelection(selection: EditSelection): void { this.select(selection); this.sync(); }

    copySelection(): RichFragment {
        return sliceRichText(this.services.readText(), Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus));
    }

    deleteSelection(): void {
        const from = Math.min(this.selection.anchor, this.selection.focus), to = Math.max(this.selection.anchor, this.selection.focus);
        if (from === to) return;
        this.typingHistory.close();
        this.services.history.open('Cut text');
        try { this.replace({ from, to, text: '', selection: { anchor: from, focus: from } }, 'boundary'); this.host.sync(); }
        finally { this.services.history.close(); }
    }

    replaceSelection(fragment: RichFragment): void {
        const from = Math.min(this.selection.anchor, this.selection.focus), to = Math.max(this.selection.anchor, this.selection.focus);
        const length = fragment.blocks.reduce((sum, block) => sum + block.runs.reduce((n, run) => n + run.text.length, 0), 0) + Math.max(0, fragment.blocks.length - 1);
        const next = { anchor: from + length, focus: from + length };
        this.typingHistory.close();
        this.services.history.open('Paste text');
        try {
            this.services.apply({ origin: 'paste', label: 'Paste text', ops: [{ t: 'splice', id: this.id, key: this.key, from, to, insert: fragment }] });
            this.select(next);
        } catch (error) { this.services.reportError(error); }
        finally { this.services.history.close(); }
    }

    applyLink(url: string, selection: EditSelection): boolean {
        let applied: boolean;
        try { applied = this.controller.applyLink(url, selection); }
        catch (error) { this.services.reportError(error); return false; }
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
        this.typingHistory.dispose();
        this.pointer.dispose(); this.host.dispose();
        if (this.services.alive() && this.services.isStandaloneText() && !this.services.plainText().trim()) {
            const history = this.services.history;
            const tokens = this.typingHistory.stepTokens;
            try {
                const last = tokens[tokens.length - 1];
                if (last === undefined || !history.reopenLast(last)) history.open('Delete empty text');
                let deleted = false;
                try { this.services.apply({ origin: 'tool', label: 'Delete empty text', ops: [{ t: 'delete', id: this.id }] }); deleted = true; }
                finally {
                    const deletion = history.close();
                    if (deleted && this.services.creationToken !== undefined && deletion !== null) {
                        history.forgetCreatedNode(this.id, this.services.creationToken, [...tokens, deletion]);
                    }
                }
            } catch (error) { this.services.reportError(error); }
        }
        this.services.finish();
    }
}
