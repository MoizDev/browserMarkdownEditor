import { captureReadingSelection } from './tableReadingSelection';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import type { ChangeDesc, Extension, SelectionRange, Text } from '@codemirror/state';
import { forceParsing } from '@codemirror/language';

export interface ScrollAnchor {
    pos: number;
    offset: number;
}

/** Shape guard for a stored anchor — localStorage is user-editable. */
export function isScrollAnchor(value: unknown): value is ScrollAnchor {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const { pos, offset } = value as Record<string, unknown>;
    return Number.isSafeInteger(pos) && (pos as number) >= 0 && Number.isFinite(offset);
}

function topEdgeHeight(view: EditorView): number {
    return view.scrollDOM.getBoundingClientRect().top - view.documentTop;
}

function anchorHeight(view: EditorView, anchor: ScrollAnchor): number {
    const pos = Math.min(anchor.pos, view.state.doc.length);
    const block = view.lineBlockAt(pos);
    if (block.from !== pos) return block.top;
    const floor = block.from === 0 ? -view.documentPadding.top : 0;
    return block.top + Math.max(floor, Math.min(anchor.offset, Math.max(0, block.height - 1)));
}

function nudge(view: EditorView, delta: number): void {
    if (Math.abs(delta) > 1) view.scrollDOM.scrollTop += delta;
}

interface MeasureRequest<T> {
    key: unknown;
    read(view: EditorView): T;
    write(value: T, view: EditorView): void;
}

export function captureScrollAnchor(view: EditorView, key: string, save: (anchor: ScrollAnchor) => void): void {
    const request: MeasureRequest<ScrollAnchor> = {
        key,
        read: (v) => {
            const target = v.plugin(scrollAnchorPlugin)?.target;
            const edge = topEdgeHeight(v) + (target?.kind === 'word' ? distanceToTarget(v, target, true) : 0);
            const block = v.lineBlockAtHeight(edge);
            return { pos: block.from, offset: edge - block.top };
        },
        write: (anchor) => save(anchor),
    };
    view.requestMeasure(request);
}

export function mapScrollAnchor(anchor: ScrollAnchor, changes: ChangeDesc): ScrollAnchor {
    // A stored anchor may lie past a note shortened on disk; mapPos throws on it.
    const pos = changes.mapPos(Math.min(anchor.pos, changes.length), -1);
    return pos === anchor.pos ? anchor : { pos, offset: anchor.offset };
}

const READER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'dragover', 'drop'] as const;
const SCROLL_KEYS = new Set([' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

type HoldTarget =
    | { kind: 'top'; anchor: ScrollAnchor }
    | { kind: 'word'; anchor: WordReadingAnchor; inBlock: number }
    | {
        kind: 'centre';
        pos: number;
        inBlock: number | null;
    };

export const revealMatch = StateEffect.define<{ from: number; to: number }>({
    map: (value, mapping) => ({ from: mapping.mapPos(value.from), to: mapping.mapPos(value.to) }),
});

const isReveal = (e: StateEffect<unknown>): e is StateEffect<{ from: number; to: number }> => e.is(revealMatch);

/** `@codemirror/search`'s `scrollToMatch`. Module-level: it is baked into every
 *  EditorState, which outlives the pane that built it (AGENTS.md). */
export const revealMatchEffect = (range: SelectionRange): StateEffect<unknown> =>
    revealMatch.of({ from: range.from, to: range.to });

const revealScroll = EditorState.transactionExtender.of((tr) => {
    const effects = tr.effects
        .filter(isReveal)
        .map((e) => EditorView.scrollIntoView(e.value.from, { y: 'center' }));
    return effects.length > 0 ? { effects } : null;
});

function centreHeight(view: EditorView, target: Extract<HoldTarget, { kind: 'centre' }>, measuring: boolean): number {
    const pos = Math.min(target.pos, view.state.doc.length);
    const block = view.lineBlockAt(pos);
    if (measuring) {
        const rect = view.coordsAtPos(pos, 1);
        if (rect) {
            const half = view.scrollDOM.clientHeight / 2;
            const top = rect.top - view.documentTop;
            const mid = rect.bottom - rect.top > half * 2 ? top + half : (top + rect.bottom - view.documentTop) / 2;
            target.inBlock = mid - block.top;
        }
    }
    return block.top + (target.inBlock ?? Math.min(block.height, view.defaultLineHeight) / 2);
}

function distanceToTarget(view: EditorView, target: HoldTarget, measuring: boolean): number {
    const edge = topEdgeHeight(view);
    if (target.kind === 'top') return anchorHeight(view, target.anchor) - edge;
    if (target.kind === 'word') {
        const block = view.lineBlockAt(target.anchor.pos);
        if (measuring) {
            const rect = view.coordsAtPos(target.anchor.pos, 1);
            if (rect) target.inBlock = rect.top - view.documentTop - block.top;
        }
        return block.top + target.inBlock - target.anchor.viewportOffset - edge;
    }
    return centreHeight(view, target, measuring) - view.scrollDOM.clientHeight / 2 - edge;
}

class ScrollAnchorHold {
    private held: HoldTarget | null = null;
    private revision = 0;
    private captures = new Set<(anchor: WordReadingAnchor | null) => void>();
    private readonly view: EditorView;
    private readonly release = (event: Event): void => {
        if (event instanceof KeyboardEvent && event.target === this.view.scrollDOM && !SCROLL_KEYS.has(event.key)) return;
        this.revision++;
        this.target = null;
    };
    private readonly resize = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.view.requestMeasure());

    private readonly pin: MeasureRequest<number> = {
        key: this,
        read: (view) => (this.held ? distanceToTarget(view, this.held, true) : 0),
        write: (delta, view) => { if (this.held) nudge(view, delta); },
    };

    constructor(view: EditorView) {
        this.view = view;
        for (const type of READER_INPUT) {
            view.dom.addEventListener(type, this.release, { capture: true, passive: true });
        }
    }

    get target(): HoldTarget | null {
        return this.held;
    }

    set target(target: HoldTarget | null) {
        if ((this.held == null) !== (target == null)) {
            if (target) this.resize?.observe(this.view.contentDOM);
            else this.resize?.disconnect();
        }
        this.held = target;
    }

    hold(anchor: ScrollAnchor): void {
        const target: HoldTarget = { kind: 'top', anchor };
        const delta = distanceToTarget(this.view, target, false);
        this.target = target;
        nudge(this.view, delta);
        this.view.requestMeasure(this.pin);
    }

    captureWord(): Promise<WordReadingAnchor | null> {
        if (this.held?.kind === 'word' && this.held.anchor.doc === this.view.state.doc) {
            return Promise.resolve({ ...this.held.anchor, inBlock: this.held.inBlock,
                selection: this.view.state.selection, nativeSelection: captureReadingSelection(this.view) });
        }
        const revision = this.revision;
        const doc = this.view.state.doc;
        return new Promise(resolve => {
            this.captures.add(resolve);
            this.view.requestMeasure({
                read: view => {
                    if (revision !== this.revision || view.state.doc !== doc) return null;
                    const box = view.scrollDOM.getBoundingClientRect();
                    const content = view.contentDOM.getBoundingClientRect();
                    const style = getComputedStyle(view.contentDOM);
                    const x = Math.max(box.left + 2, content.left + parseFloat(style.paddingLeft || '0') + 2);
                    const y = box.top + Math.min(view.defaultLineHeight / 2, box.height / 2);
                    const point = view.posAtCoords({ x, y });
                    if (point == null) return null;
                    const word = boundedReadingWord(view.state, point);
                    const pos = word?.from ?? point;
                    const rect = view.coordsAtPos(pos, 1);
                    if (!rect || rect.bottom <= box.top || rect.top > box.top + view.defaultLineHeight) return null;
                    const line = doc.lineAt(pos), block = view.lineBlockAt(pos);
                    return {
                        doc, pos, wordTo: word?.to ?? pos,
                        quote: word ? view.state.sliceDoc(pos, word.to) : '',
                        before: view.state.sliceDoc(Math.max(0, pos - 64), pos),
                        after: view.state.sliceDoc(pos, Math.min(doc.length, pos + 64)),
                        intraLine: pos - line.from,
                        viewportOffset: rect.top - box.top,
                        inBlock: rect.top - view.documentTop - block.top,
                        selection: view.state.selection,
                        nativeSelection: captureReadingSelection(view),
                        revision,
                    } satisfies WordReadingAnchor;
                },
                write: anchor => {
                    this.captures.delete(resolve);
                    resolve(revision === this.revision && this.view.state.doc === doc ? anchor : null);
                },
            });
        });
    }
    restoreWord(anchor: WordReadingAnchor): void {
        if (anchor.doc !== this.view.state.doc || anchor.revision !== this.revision) return;
        if (!this.view.state.selection.eq(anchor.selection)) {
            this.view.dispatch({ selection: anchor.selection });
        }
        this.target = { kind: 'word', anchor, inBlock: anchor.inBlock };
        anchor.nativeSelection?.();
        this.view.requestMeasure(this.pin);
    }
    cancelWord(): void {
        this.revision++;
        if (this.held?.kind === 'word') this.target = null;
    }

    update(update: ViewUpdate): void {
        for (const tr of update.transactions) {
            if (this.held && tr.docChanged) {
                if (this.held.kind === 'word') {
                    this.cancelWord();
                    continue;
                }
                this.target = this.held.kind === 'top'
                    ? { kind: 'top', anchor: mapScrollAnchor(this.held.anchor, tr.changes) }
                    : { ...this.held, pos: tr.changes.mapPos(this.held.pos, 1) };
            }
            const reveal = tr.effects.find(isReveal);
            if (reveal) {
                this.target = { kind: 'centre', pos: reveal.value.from, inBlock: null };
                this.view.requestMeasure(this.pin);
                continue;
            }
            if (tr.scrollIntoView) this.target = null;
        }
        if (!this.held) return;
        if (update.docChanged || update.heightChanged || update.geometryChanged || update.viewportChanged) {
            this.view.requestMeasure(this.pin);
        }
    }

    settle(update: ViewUpdate): void {
        if (!this.held || update.transactions.length > 0) return;
        if (update.heightChanged || update.geometryChanged || update.viewportChanged) {
            nudge(this.view, distanceToTarget(this.view, this.held, false));
        }
    }

    destroy(): void {
        this.revision++;
        for (const resolve of this.captures) resolve(null);
        this.captures.clear();
        this.target = null;
        for (const type of READER_INPUT) {
            this.view.dom.removeEventListener(type, this.release, { capture: true });
        }
    }
}

const scrollAnchorPlugin = ViewPlugin.fromClass(ScrollAnchorHold, {
    provide: (plugin) => EditorView.updateListener.of((update) => update.view.plugin(plugin)?.settle(update)),
});

export const scrollAnchorTracking: Extension = [scrollAnchorPlugin, revealScroll];

export function holdScrollAnchor(view: EditorView, anchor: ScrollAnchor): void {
    view.plugin(scrollAnchorPlugin)?.hold(anchor);
}

export function isHoldingScrollAnchor(view: EditorView): boolean {
    return view.plugin(scrollAnchorPlugin)?.target?.kind === 'top';
}

function boundedReadingWord(state: EditorState, point: number): { from: number; to: number } | null {
    const from = Math.max(0, point - 128), to = Math.min(state.doc.length, point + 128);
    const local = state.sliceDoc(from, to), relative = point - from;
    for (const match of local.matchAll(/[\p{L}\p{N}\p{M}_’']+/gu)) {
        const end = match.index + match[0].length;
        if (match.index > relative) break;
        if (end < relative) continue;
        if ((match.index === 0 && from > 0) || (end === local.length && to < state.doc.length)) return null;
        return { from: from + match.index, to: from + end };
    }
    return null;
}

export interface WordReadingAnchor {
    readonly doc: Text;
    readonly pos: number;
    readonly wordTo: number;
    readonly quote: string;
    readonly before: string;
    readonly after: string;
    readonly intraLine: number;
    readonly viewportOffset: number;
    readonly inBlock: number;
    readonly selection: EditorSelection;
    readonly nativeSelection: (() => void) | null;
    readonly revision: number;
}
export function captureWordReadingAnchor(view: EditorView): Promise<WordReadingAnchor | null> {
    return view.plugin(scrollAnchorPlugin)?.captureWord() ?? Promise.resolve(null);
}
export function restoreWordReadingAnchor(view: EditorView, anchor: WordReadingAnchor): void {
    view.plugin(scrollAnchorPlugin)?.restoreWord(anchor);
}
export function cancelWordReadingAnchor(view: EditorView): void {
    view.plugin(scrollAnchorPlugin)?.cancelWord();
}

const REVEAL_PARSE_MARGIN = 3000;
const REVEAL_PARSE_BUDGET = 100;

export function parseForReveal(view: EditorView, to: number): void {
    const { doc } = view.state;
    forceParsing(view, Math.min(doc.length, doc.lineAt(Math.min(to, doc.length)).to + REVEAL_PARSE_MARGIN), REVEAL_PARSE_BUDGET);
}

if (import.meta.hot) {
    (import.meta.hot as unknown as { decline(): void }).decline();
}
