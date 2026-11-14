import type { Block, RichText } from '../richText';
import { isGraphemeBoundary } from '../graphemes';
import { richTextWindow, type TextWindow } from './window';

interface TextUpdate extends Event {
    readonly updateRangeStart: number;
    readonly updateRangeEnd: number;
    readonly text: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
}
interface EditContextLike extends EventTarget {
    updateText(start: number, end: number, text: string): void;
    updateSelection(start: number, end: number): void;
    updateControlBounds(rect: DOMRect): void;
    updateSelectionBounds(rect: DOMRect): void;
    updateCharacterBounds(start: number, rects: DOMRect[]): void;
}
type EditContextConstructor = new () => EditContextLike;

export interface EditSelection { readonly anchor: number; readonly focus: number }
export interface EditSnapshot { readonly text: RichText; readonly selection: EditSelection }
export interface TextChange {
    readonly from: number;
    readonly to: number;
    readonly text: string;
    readonly selection: EditSelection;
}
export interface EditHostCallbacks {
    snapshot(): EditSnapshot;
    change(change: TextChange): void;
    selection(selection: EditSelection): void;
    composition(change: TextChange | null): void;
    compositionFormat?(event: Event): void;
    commitComposition(change: TextChange): void;
    keydown(event: KeyboardEvent): void;
    contextMenu(x: number, y: number): void;
    characterBounds(start: number, end: number): DOMRect[];
}

function difference(base: TextWindow, value: string, selection: EditSelection): TextChange {
    let from = 0;
    while (from < base.text.length && from < value.length && base.text[from] === value[from]) from++;
    let oldEnd = base.text.length, newEnd = value.length;
    while (oldEnd > from && newEnd > from && base.text[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
    while (from > 0 && (!isGraphemeBoundary(base.text, from) || !isGraphemeBoundary(value, from))) from--;
    while ((oldEnd < base.text.length || newEnd < value.length)
        && (!isGraphemeBoundary(base.text, oldEnd) || !isGraphemeBoundary(value, newEnd))) {
        oldEnd = Math.min(base.text.length, oldEnd + 1);
        newEnd = Math.min(value.length, newEnd + 1);
    }
    return { from: base.start + from, to: base.start + oldEnd, text: value.slice(from, newEnd), selection };
}

// The element takes platform input, but the canvas remains the only visible
// text. The caller owns transactions and supplies the current model snapshot.
export class EditHost {
    readonly element: HTMLDivElement | HTMLTextAreaElement;
    private readonly context: EditContextLike | null;
    private readonly mirror: HTMLDivElement | null;
    private readonly callbacks: EditHostCallbacks;
    private mirrorBlocks: readonly Block[] = [];
    private window: TextWindow = { start: 0, end: 0, text: '' };
    private composing = false;
    private pending: TextChange | null = null;
    private compositionBase: TextWindow | null = null;
    private readonly cleanup: (() => void)[] = [];

    constructor(container: HTMLElement, label: string, callbacks: EditHostCallbacks, forceFallback = false) {
        this.callbacks = callbacks;
        const constructor = (globalThis as typeof globalThis & { EditContext?: EditContextConstructor }).EditContext;
        this.context = !forceFallback && constructor ? new constructor() : null;
        if (this.context) {
            const host = document.createElement('div');
            (host as HTMLDivElement & { editContext: EditContextLike }).editContext = this.context;
            const mirror = document.createElement('div');
            Object.assign(mirror.style, { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'pre' });
            host.append(mirror);
            this.mirror = mirror;
            this.element = host;
            this.listen(this.context, 'textupdate', event => this.onTextUpdate(event as TextUpdate));
            this.listen(this.context, 'characterboundsupdate', event => {
                const range = event as Event & { rangeStart: number; rangeEnd: number };
                this.context?.updateCharacterBounds(range.rangeStart, callbacks.characterBounds(this.window.start + range.rangeStart, this.window.start + range.rangeEnd));
            });
            this.listen(this.context, 'textformatupdate', event => callbacks.compositionFormat?.(event));
            this.listen(this.context, 'compositionstart', () => this.startComposition());
            this.listen(this.context, 'compositionend', () => this.endComposition());
        } else {
            const textarea = document.createElement('textarea');
            textarea.spellcheck = false;
            this.mirror = null;
            this.element = textarea;
            this.listen(textarea, 'input', () => this.onFallbackInput(textarea));
            this.listen(textarea, 'compositionstart', () => this.startComposition());
            this.listen(textarea, 'compositionend', () => {
                this.pending = difference(this.compositionBase ?? this.window, textarea.value,
                    { anchor: this.window.start + textarea.selectionStart, focus: this.window.start + textarea.selectionEnd });
                this.endComposition();
            });
            this.listen(textarea, 'select', () => {
                const backward = textarea.selectionDirection === 'backward';
                callbacks.selection({ anchor: this.window.start + (backward ? textarea.selectionEnd : textarea.selectionStart), focus: this.window.start + (backward ? textarea.selectionStart : textarea.selectionEnd) });
            });
        }
        this.element.className = 'wb-edit-host';
        this.element.tabIndex = -1;
        this.element.setAttribute('role', 'textbox');
        this.element.setAttribute('aria-multiline', 'true');
        this.element.setAttribute('aria-label', label);
        Object.assign(this.element.style, { position: 'absolute', opacity: '0', pointerEvents: 'none' });
        this.listen(this.element, 'keydown', event => callbacks.keydown(event as KeyboardEvent));
        this.listen(this.element, 'contextmenu', event => {
            event.preventDefault();
            const mouse = event as MouseEvent;
            callbacks.contextMenu(mouse.clientX, mouse.clientY);
        });
        container.append(this.element);
        this.sync();
    }

    private listen(target: EventTarget, name: string, listener: EventListener): void {
        target.addEventListener(name, listener);
        this.cleanup.push(() => target.removeEventListener(name, listener));
    }

    private onTextUpdate(event: TextUpdate): void {
        const start = this.window.start;
        const value = this.window.text.slice(0, event.updateRangeStart) + event.text + this.window.text.slice(event.updateRangeEnd);
        const change = difference(this.window, value, { anchor: start + event.selectionStart, focus: start + event.selectionEnd });
        if (this.composing) {
            this.window = { start, end: start + value.length, text: value };
            this.pending = this.compositionChange(value, change.selection);
            this.callbacks.composition(this.pending);
        } else {
            try {
                if (change.from === change.to && !change.text) this.callbacks.selection(change.selection);
                else this.callbacks.change(change);
            }
            finally {
                this.window = { ...this.window, end: this.window.start + value.length, text: value };
                this.sync();
            }
        }
    }

    private onFallbackInput(element: HTMLTextAreaElement): void {
        const value = element.value;
        const change = difference(this.window, value, { anchor: this.window.start + element.selectionStart, focus: this.window.start + element.selectionEnd });
        if (this.composing) { this.pending = change; this.callbacks.composition(change); }
        else {
            try {
                if (change.from === change.to && !change.text) this.callbacks.selection(change.selection);
                else this.callbacks.change(change);
            } finally { this.sync(); }
        }
    }

    private startComposition(): void {
        this.composing = true;
        this.pending = null;
        this.compositionBase = this.window;
    }

    private compositionChange(value: string, selection: EditSelection): TextChange {
        return difference(this.compositionBase ?? this.window, value, selection);
    }

    private endComposition(): void {
        this.composing = false;
        const pending = this.pending;
        this.pending = null;
        this.compositionBase = null;
        this.callbacks.composition(null);
        if (pending && (pending.from !== pending.to || pending.text.length > 0)) this.callbacks.commitComposition(pending);
        this.sync();
    }

    sync(): void {
        if (this.composing) return;
        const { text, selection } = this.callbacks.snapshot();
        const next = richTextWindow(text, selection.anchor, selection.focus, this.window);
        if (this.context) {
            if (this.window.text !== next.text) this.context.updateText(0, this.window.text.length, next.text);
            this.context.updateSelection(Math.min(selection.anchor, selection.focus) - next.start, Math.max(selection.anchor, selection.focus) - next.start);
        } else {
            const textarea = this.element as HTMLTextAreaElement;
            if (textarea.value !== next.text) textarea.value = next.text;
            textarea.setSelectionRange(Math.min(selection.anchor, selection.focus) - next.start, Math.max(selection.anchor, selection.focus) - next.start, selection.anchor > selection.focus ? 'backward' : 'forward');
        }
        this.window = next;
        if (this.mirror) {
            if (this.mirrorBlocks.length !== text.blocks.length) {
                const fragment = document.createDocumentFragment();
                for (const block of text.blocks) {
                    const paragraph = document.createElement('p');
                    paragraph.append(document.createTextNode(block.runs.length === 1 ? block.runs[0].text : block.runs.map(run => run.text).join('')));
                    fragment.append(paragraph);
                }
                this.mirror.replaceChildren(fragment);
            } else {
                for (let i = 0; i < text.blocks.length; i++) {
                    if (text.blocks[i] !== this.mirrorBlocks[i]) {
                        const runs = text.blocks[i].runs;
                        this.mirror.children[i].firstChild!.textContent = runs.length === 1 ? runs[0].text : runs.map(run => run.text).join('');
                    }
                }
            }
            this.mirrorBlocks = text.blocks;
            const point = (offset: number): [Node, number] => {
                let remaining = Math.max(0, offset);
                for (const paragraph of this.mirror!.children) {
                    const node = paragraph.firstChild!;
                    const length = node.textContent?.length ?? 0;
                    if (remaining <= length) return [node, remaining];
                    remaining -= length + 1;
                }
                const last = this.mirror!.lastChild?.firstChild ?? this.mirror!;
                return [last, last.textContent?.length ?? 0];
            };
            const [anchorNode, anchorOffset] = point(selection.anchor);
            const [focusNode, focusOffset] = point(selection.focus);
            if (document.activeElement === this.element) document.getSelection()?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
        }
    }

    get textOffsetBase(): number { return this.window.start; }

    updateBounds(control: DOMRect, selection: DOMRect): void {
        this.context?.updateControlBounds(control);
        this.context?.updateSelectionBounds(selection);
    }

    focus(): void { this.element.focus({ preventScroll: true }); this.sync(); }
    finishComposition(commit: boolean): void {
        if (!this.composing) return;
        if (!commit) {
            this.composing = false;
            this.pending = null;
            this.compositionBase = null;
            this.callbacks.composition(null);
            return;
        }
        this.endComposition();
    }
    dispose(): void { for (const remove of this.cleanup) remove(); this.element.remove(); }
}
