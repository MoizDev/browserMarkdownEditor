import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { countEditorWidget } from './editorPerf';
import type { DecorationSet } from '@codemirror/view';
import { MapMode, StateEffect, StateField } from '@codemirror/state';
import type { EditorSelection, EditorState, Extension, Range, Text, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { Tree } from '@lezer/common';
import { analyzeDoc, mathSkipsRange } from './latexSource';

interface HeadingSection {
    from: number;
    lineTo: number;
    level: number;
    end: number;
    closed: boolean;
}

function headingLevel(name: string): number {
    if (name.length !== 11 || !name.startsWith('ATXHeading')) return 0;
    const level = name.charCodeAt(10) - 48;
    return level >= 1 && level <= 6 ? level : 0;
}

const sectionMemo = new WeakMap<Text, { tree: Tree; value: readonly HeadingSection[] }>();

function headingSections(state: EditorState): readonly HeadingSection[] {
    const tree = syntaxTree(state);
    const hit = sectionMemo.get(state.doc);
    if (hit && hit.tree === tree) return hit.value;

    const { doc } = state;
    const sections: HeadingSection[] = [];
    const cursor = tree.cursor();
    if (cursor.firstChild()) {
        const analysis = analyzeDoc(state);
        const open: number[] = [];
        let lastFrom = 0;
        let lastTo = 0;
        const sectionEnd = (terminator: number | null) =>
            lastTo === terminator && lastTo > lastFrom ? lastTo - 1 : doc.lineAt(lastTo).to;
        const close = (index: number, end: number, closed: boolean) => {
            const section = sections[index];
            section.end = Math.max(end, section.lineTo);
            section.closed = closed;
        };

        do {
            const level = headingLevel(cursor.name);
            if (level && !mathSkipsRange(analysis, cursor.from, cursor.to)) {
                const line = doc.lineAt(cursor.from);
                const end = sectionEnd(line.from);
                while (open.length && sections[open[open.length - 1]].level >= level) {
                    close(open.pop()!, end, true);
                }
                open.push(sections.length);
                sections.push({ from: line.from, lineTo: line.to, level, end: line.to, closed: false });
            }
            lastFrom = cursor.from;
            lastTo = cursor.to;
        } while (cursor.nextSibling());

        const end = sectionEnd(null);
        const complete = tree.length >= doc.length;
        for (const index of open) close(index, end, complete);
    }

    sectionMemo.set(state.doc, { tree, value: sections });
    return sections;
}

function sectionAt(sections: readonly HeadingSection[], pos: number): HeadingSection | null {
    let lo = 0, hi = sections.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sections[mid].from < pos) lo = mid + 1;
        else hi = mid;
    }
    return lo < sections.length && sections[lo].from === pos ? sections[lo] : null;
}

function isEmpty(section: HeadingSection): boolean {
    return section.end <= section.lineTo;
}

const setHeadingFold = StateEffect.define<{ pos: number; folded: boolean }>({
    map: (value, mapping) => {
        const pos = mapping.mapPos(value.pos, 1, MapMode.TrackAfter);
        return pos === null ? undefined : { pos, folded: value.folded };
    },
});

const isReading = (state: EditorState): boolean => !state.facet(EditorView.editable);

function toggleFoldAt(view: EditorView, dom: HTMLElement, widget: 'toggle' | 'pill'): void {
    let pos: number;
    try {
        pos = view.posAtDOM(dom);
    } catch {
        return;
    }
    const { state } = view;
    const value = state.field(headingFoldField, false);
    if (!value) return;
    if (widget === 'pill') {
        const sections = headingSections(state);
        const hit = value.folded.find((p) => {
            const section = sectionAt(sections, p);
            return section !== null && section.closed && section.lineTo <= pos && pos <= section.end;
        });
        if (hit !== undefined) {
            view.dispatch({ effects: [setHeadingFold.of({ pos: hit, folded: false }), ...holdHeading(view, hit)] });
        }
        return;
    }
    const lineFrom = state.doc.lineAt(pos).from;
    view.dispatch({
        effects: [
            setHeadingFold.of({ pos: lineFrom, folded: !value.folded.includes(lineFrom) }),
            ...holdHeading(view, lineFrom),
        ],
    });
}

function holdHeading(view: EditorView, lineFrom: number): StateEffect<unknown>[] {
    const rect = view.coordsAtPos(lineFrom, 1);
    if (!rect) return [];
    const offset = rect.top - view.scrollDOM.getBoundingClientRect().top;
    return [EditorView.scrollIntoView(lineFrom, { y: 'start', yMargin: Math.max(0, offset) })];
}

const CHEVRON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

const ELLIPSIS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';

function dressToggle(button: HTMLElement, folded: boolean): void {
    const label = folded ? 'Expand section' : 'Collapse section';
    button.setAttribute('aria-expanded', String(!folded));
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
}

class HeadingFoldToggle extends WidgetType {
    constructor(readonly folded: boolean) {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
    }

    override eq(other: HeadingFoldToggle): boolean {
        return other.folded === this.folded;
    }

    override toDOM(view: EditorView): HTMLElement {
        const anchor = document.createElement('span');
        anchor.className = 'cm-heading-fold-anchor';
        const pin = document.createElement('span');
        pin.className = 'cm-heading-fold-pin';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cm-heading-fold-toggle';
        button.tabIndex = -1;
        button.innerHTML = CHEVRON;
        dressToggle(button, this.folded);
        button.onmousedown = (e) => e.preventDefault();
        // Reads nothing from `this`: updateDOM keeps this DOM alive across
        // widget instances, so the one that built it may be long gone.
        button.onclick = (e) => {
            e.preventDefault();
            toggleFoldAt(view, anchor, 'toggle');
        };
        pin.appendChild(button);
        anchor.appendChild(pin);
        return anchor;
    }

    override updateDOM(dom: HTMLElement): boolean {
        const button = dom.querySelector('.cm-heading-fold-toggle');
        if (!(button instanceof HTMLElement)) return false;
        dressToggle(button, this.folded);
        return true;
    }

    override ignoreEvent(): boolean {
        return true;
    }
}

class HeadingFoldPlaceholder extends WidgetType {
    constructor() {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
    }

    override eq(): boolean {
        return true;
    }

    override toDOM(view: EditorView): HTMLElement {
        const pill = document.createElement('span');
        pill.className = 'cm-heading-fold-placeholder';
        pill.innerHTML = ELLIPSIS;
        pill.dataset.tooltip = 'Expand section';
        pill.setAttribute('role', 'button');
        pill.setAttribute('aria-label', 'Expand section');
        pill.onmousedown = (e) => e.preventDefault();
        pill.onclick = (e) => {
            e.preventDefault();
            toggleFoldAt(view, pill, 'pill');
        };
        return pill;
    }

    override ignoreEvent(): boolean {
        return true;
    }
}

const FOLDABLE_LINE = Decoration.line({ class: 'cm-heading-foldable' });
const TOGGLE_OPEN = Decoration.widget({ widget: new HeadingFoldToggle(false), side: -1 });
const TOGGLE_FOLDED = Decoration.widget({ widget: new HeadingFoldToggle(true), side: -1 });
const FOLD_REPLACE = Decoration.replace({ widget: new HeadingFoldPlaceholder() });

const NO_FOLDS: readonly number[] = [];

interface HeadingFoldValue {
    readonly folded: readonly number[];
    readonly deco: DecorationSet;
    readonly reveal: EditorSelection | null;
}

function build(state: EditorState, folded: readonly number[]): DecorationSet {
    if (!isReading(state)) return Decoration.none;
    const sections = headingSections(state);
    if (sections.length === 0) return Decoration.none;
    const isFolded = new Set(folded);
    const ranges: Range<Decoration>[] = [];
    let hiddenUntil = -1;
    for (const section of sections) {
        if (section.from <= hiddenUntil || !section.closed || isEmpty(section)) continue;
        const collapsed = isFolded.has(section.from);
        ranges.push(FOLDABLE_LINE.range(section.from));
        ranges.push((collapsed ? TOGGLE_FOLDED : TOGGLE_OPEN).range(section.from));
        if (collapsed) {
            ranges.push(FOLD_REPLACE.range(section.lineTo, section.end));
            hiddenUntil = section.end;
        }
    }
    return Decoration.set(ranges, true);
}

function mapFolds(folded: readonly number[], tr: Transaction): readonly number[] {
    let changed = false;
    let lost: number[] | null = null;
    const next: number[] = [];
    for (const pos of folded) {
        const mapped = tr.changes.mapPos(pos, 1, MapMode.TrackAfter);
        if (mapped === null) {
            (lost ??= []).push(pos);
            changed = true;
        } else if (tr.newDoc.lineAt(mapped).from !== mapped) {
            changed = true;
        } else {
            if (mapped !== pos) changed = true;
            next.push(mapped);
        }
    }
    if (!changed) return folded;
    if (lost) next.push(...reanchorFolds(tr, lost));
    next.sort((a, b) => a - b);
    return next.filter((pos, i) => i === 0 || pos !== next[i - 1]);
}

function reanchorFolds(tr: Transaction, lost: readonly number[]): number[] {
    const before = tr.startState.doc;
    const wanted = new Set(lost.map(pos => before.lineAt(pos).text));
    const removed = new Map<string, number[]>();
    const added = new Map<string, number[]>();
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        collectWholeLines(before, fromA, toA, wanted, removed);
        collectWholeLines(tr.newDoc, fromB, toB, wanted, added);
    });
    const out: number[] = [];
    for (const pos of lost) {
        const text = before.lineAt(pos).text;
        const index = removed.get(text)?.indexOf(pos) ?? -1;
        const target = index < 0 ? undefined : added.get(text)?.[index];
        if (target !== undefined) out.push(target);
    }
    return out;
}

function collectWholeLines(doc: Text, from: number, to: number, wanted: ReadonlySet<string>, into: Map<string, number[]>): void {
    for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
        if (line.from >= from && line.to <= to && wanted.has(line.text)) {
            let list = into.get(line.text);
            if (!list) into.set(line.text, list = []);
            list.push(line.from);
        }
        if (line.to >= to || line.number === doc.lines) return;
    }
}

function withFold(folded: readonly number[], pos: number, on: boolean): readonly number[] {
    const index = folded.indexOf(pos);
    if ((index >= 0) === on) return folded;
    return on ? [...folded, pos].sort((a, b) => a - b) : folded.filter(p => p !== pos);
}

function pruneFolds(state: EditorState, folded: readonly number[]): readonly number[] {
    const sections = headingSections(state);
    const parsedTo = syntaxTree(state).length;
    const next = folded.filter((pos) => {
        if (state.doc.lineAt(pos).to > parsedTo) return true;
        const section = sectionAt(sections, pos);
        return section !== null && !(section.closed && isEmpty(section));
    });
    return next.length === folded.length ? folded : next;
}

function unfoldAround(state: EditorState, folded: readonly number[], selection: EditorSelection): readonly number[] {
    const sections = headingSections(state);
    const next = folded.filter((pos) => {
        const section = sectionAt(sections, pos);
        if (!section || isEmpty(section)) return true;
        const hides = (x: number) => x > section.lineTo && x < section.end;
        return !selection.ranges.some(r => hides(r.from) || hides(r.to));
    });
    return next.length === folded.length ? folded : next;
}

function revealUnsettled(state: EditorState, folded: readonly number[], reveal: EditorSelection): boolean {
    if (folded.length === 0) return false;
    let reach = 0;
    for (const range of reveal.ranges) reach = Math.max(reach, range.to);
    const sections = headingSections(state);
    const parsedTo = syntaxTree(state).length;
    return folded.some((pos) => {
        if (pos >= reach) return false;
        const section = sectionAt(sections, pos);
        return section ? !section.closed : state.doc.lineAt(pos).to > parsedTo;
    });
}

function updateFolds(value: HeadingFoldValue, tr: Transaction): HeadingFoldValue {
    let folded = value.folded;
    if (tr.docChanged && folded.length > 0) folded = mapFolds(folded, tr);
    for (const effect of tr.effects) {
        if (effect.is(setHeadingFold)) folded = withFold(folded, effect.value.pos, effect.value.folded);
    }

    const { state } = tr;
    if (!isReading(state)) {
        return folded === value.folded && value.deco === Decoration.none && value.reveal === null
            ? value
            : { folded, deco: Decoration.none, reveal: null };
    }

    const modeFlip = !isReading(tr.startState);
    const treeAdvanced = syntaxTree(state) !== syntaxTree(tr.startState);
    const structural = tr.docChanged || treeAdvanced || modeFlip;
    if (folded.length > 0 && (structural || folded !== value.folded)) folded = pruneFolds(state, folded);

    // A click never expands anything. It cannot land inside a DRAWN fold, and
    // one landing in the visible text of a section still open at the parse's
    // edge — collapsed, but not drawn yet — was deleting that collapse from the
    // note for good (measured). Every other selection is a reveal.
    let reveal = value.reveal;
    if (tr.selection) reveal = tr.isUserEvent('select.pointer') ? null : tr.selection;
    else if (reveal && tr.docChanged) reveal = reveal.map(tr.changes);
    if (reveal) {
        if (folded.length > 0) folded = unfoldAround(state, folded, reveal);
        if (!revealUnsettled(state, folded, reveal)) reveal = null;
    }

    if (folded === value.folded && !structural) {
        return reveal === value.reveal ? value : { folded, deco: value.deco, reveal };
    }
    return { folded, deco: build(state, folded), reveal };
}

export const headingFoldField = StateField.define<HeadingFoldValue>({
    create: state => ({ folded: NO_FOLDS, deco: build(state, NO_FOLDS), reveal: null }),
    update: updateFolds,
    provide: field => EditorView.decorations.from(field, value => value.deco),
});

export type HeadingKey = [text: string, occurrence: number];

export function isHeadingKeyList(value: unknown): value is HeadingKey[] {
    return Array.isArray(value) && value.every(key =>
        Array.isArray(key) && key.length === 2 && typeof key[0] === 'string'
        && Number.isInteger(key[1]) && key[1] >= 0);
}

export function sameHeadingKeys(stored: unknown, keys: readonly HeadingKey[]): boolean {
    if (stored === undefined) return keys.length === 0;
    return isHeadingKeyList(stored) && stored.length === keys.length
        && stored.every(([text, occurrence], i) => text === keys[i][0] && occurrence === keys[i][1]);
}

export function foldedHeadingKeys(state: EditorState): HeadingKey[] {
    const folded = state.field(headingFoldField, false)?.folded ?? NO_FOLDS;
    if (folded.length === 0) return [];
    const { doc } = state;
    const lines = folded.map(pos => doc.lineAt(pos));
    const seen = new Map<string, number>(lines.map(line => [line.text, 0]));
    const occurrence = new Map<number, number>();
    const targets = new Set(lines.map(line => line.number));
    const last = lines[lines.length - 1].number;
    let number = 1;
    for (const iter = doc.iterLines(1, last + 1); !iter.next().done; number++) {
        const count = seen.get(iter.value);
        if (count === undefined) continue;
        if (targets.has(number)) occurrence.set(number, count);
        seen.set(iter.value, count + 1);
    }
    return lines.map((line): HeadingKey => [line.text, occurrence.get(line.number) ?? 0]);
}

function resolveHeadingKeys(doc: Text, keys: readonly HeadingKey[]): readonly number[] {
    if (keys.length === 0) return NO_FOLDS;
    const wanted = new Map<string, Set<number>>();
    for (const [text, occurrence] of keys) {
        let set = wanted.get(text);
        if (!set) wanted.set(text, set = new Set());
        set.add(occurrence);
    }
    const seen = new Map<string, number>();
    const out: number[] = [];
    let pos = 0;
    for (const iter = doc.iterLines(); !iter.next().done && out.length < keys.length;) {
        const text = iter.value;
        const want = wanted.get(text);
        if (want) {
            const count = seen.get(text) ?? 0;
            if (want.has(count)) out.push(pos);
            seen.set(text, count + 1);
        }
        pos += text.length + 1;
    }
    return out;
}

export function headingFold(keys: readonly HeadingKey[]): Extension {
    return headingFoldField.init((state) => {
        const folded = resolveHeadingKeys(state.doc, keys);
        return { folded, deco: build(state, folded), reveal: null };
    });
}

// A hot swap would mint a second headingFoldField while every cached
// EditorState still holds the first, so DocumentPane's listener and the
// persistence would silently stop finding it. Force a full reload in dev
// instead, as livePreview.ts does (`import.meta.hot` is undefined in production).
if (import.meta.hot) {
    (import.meta.hot as unknown as { decline(): void }).decline();
}
