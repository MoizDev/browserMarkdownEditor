import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { MapMode, StateEffect, StateField } from '@codemirror/state';
import type { EditorSelection, EditorState, Extension, Range, Text, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { Tree } from '@lezer/common';
import { analyzeDoc, mathSkipsRange } from './latexSource';

/* ── Collapsible heading sections (Reading mode only) ─────────────────────────
   A heading's section runs to the next heading of the same or a higher level.
   Collapsing one replaces everything after the heading's own line with a "…"
   pill; nothing is ever written to the file.

   OUTSIDE livePreviewCompartment, and a module-level singleton, on purpose.
   Every createLivePreviewPlugin call mints a NEW StateField and ⌘E reconfigures
   that compartment, which discards the field's value — so fold state held there
   would be forgotten on every mode switch. This field is added once, in
   DocumentPane's createTabState, and survives ⌘E and state-cache adoption as it
   is; nothing has to be re-stated when a pane adopts a cached state.

   Mode is READ FROM THE STATE, never passed in: reading ⇔ `!editable`, the facet
   DocumentPane's readOnlyCompartment holds. The reconfigure transaction that
   flips it runs this field's update (CodeMirror carries the old value through
   the intermediate state, then updates it), so the flip is an ordinary rebuild.
   Edit mode emits Decoration.none and costs a keystroke only the mapping of the
   few folded positions — no tree walk, no build.

   WHY THE FOLD WINS over every live-preview widget it covers, without either
   field knowing about the other (@codemirror/state SpanCursor.next): meeting a
   point (replace) decoration, the cursor forward()s every set past that point's
   END, dropping each range that ends inside it — so every point that STARTS
   inside the fold (table, image, math, mermaid, a copy button, a HIDE, a hidden
   line's line decoration) is skipped, in any set. A point that ends exactly
   where the fold starts — the HIDE of `## Title **bold**`'s trailing `**` — is
   met first and forwards only to its own end, which the fold outlives, so both
   are drawn. The one hazard is the converse: a live-preview point starting
   BEFORE a heading's line end and ending after it would be met first and
   swallow or overlap the fold. Nothing does today, because a heading inside a
   math region is not a heading here (mathSkipsRange).

   Fold state is heading-line START positions, mapped with MapMode.TrackAfter
   and assoc 1: Enter at the start of a heading carries the fold down with it,
   editing the heading's text keeps it, and deleting or replacing its first
   character drops it rather than letting it slide onto the next heading —
   unless the same edit re-inserted that exact line (a line moved past it with
   Alt-↑/↓, a dropped file), which carries the fold across (reanchorFolds). A
   position that is no longer a top-level heading is pruned ONLY in reading mode
   and ONLY where the parse covers its line: an edit-mode keystroke never prunes
   (so `##B` → `## B` while editing keeps the fold), and a partial parse on a
   large note never drops one.

   Persisted by DocumentPane as HeadingKeys — the exact raw heading line plus
   how many earlier lines are identical — which resolve exactly for an unchanged
   file, need no tree, and let a heading renamed on disk simply lose its state. */

/** One top-level ATX heading and the range its section hides when collapsed. */
interface HeadingSection {
    /** Start of the heading's line — the fold key. */
    from: number;
    /** End of the heading's line — where the hidden range starts. */
    lineTo: number;
    level: number;
    /** End of the hidden range: the line end of the section's last block, so the
     *  author's blank lines before the next heading stay visible. `=== lineTo`
     *  when nothing but blank lines follows the heading. */
    end: number;
    /** False only for a section still open when a PARTIAL parse ran out: where it
     *  ends is not known yet, so it gets no arrow, prunes nothing, and cannot be
     *  what a click on screen was aimed at. */
    closed: boolean;
}

/** `ATXHeading1`…`ATXHeading6` → 1-6; anything else (setext included) → 0. */
function headingLevel(name: string): number {
    if (name.length !== 11 || !name.startsWith('ATXHeading')) return 0;
    const level = name.charCodeAt(10) - 48;
    return level >= 1 && level <= 6 ? level : 0;
}

/* Memoized on (doc, tree) identity, exactly like analyzeDoc and for the same
   reasons: both are immutable, and a split puts several documents on screen. */
const sectionMemo = new WeakMap<Text, { tree: Tree; value: readonly HeadingSection[] }>();

/**
 * Every top-level heading's section, sorted by `from`.
 *
 * From the syntax tree, never a line scan — `# x` in a fenced block is not a
 * heading — and from the Document's DIRECT children only, so it costs one step
 * per top-level block. That also settles what a heading in a blockquote or a
 * list is: content, with no arrow, that never ends a section.
 */
function headingSections(state: EditorState): readonly HeadingSection[] {
    const tree = syntaxTree(state);
    const hit = sectionMemo.get(state.doc);
    if (hit && hit.tree === tree) return hit.value;

    const { doc } = state;
    const sections: HeadingSection[] = [];
    const cursor = tree.cursor();
    if (cursor.firstChild()) {
        const analysis = analyzeDoc(state);
        /** Indices into `sections` of the headings still open, outermost first. */
        const open: number[] = [];
        let lastFrom = 0;
        let lastTo = 0;
        // The line end of the last block seen before `terminator` (the closing
        // heading's line start, or null at the end of the parse). A block runs
        // to its last line's end — except an unclosed fence at the end of the
        // note, which runs to the document's end, often an empty line's START:
        // that empty line is the block's, and stepping back off it left a stray
        // code-panel row under the collapsed heading (measured). The only `to`
        // that must be stepped back is one sitting on the closing heading's own
        // line, which would otherwise be hidden with the section.
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

/** The section whose heading line starts at `pos`, by binary search. */
function sectionAt(sections: readonly HeadingSection[], pos: number): HeadingSection | null {
    let lo = 0, hi = sections.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sections[mid].from < pos) lo = mid + 1;
        else hi = mid;
    }
    return lo < sections.length && sections[lo].from === pos ? sections[lo] : null;
}

/** Has the section anything to hide? A heading with only blank lines under it
 *  has no arrow — but only once its end is known. */
function isEmpty(section: HeadingSection): boolean {
    return section.end <= section.lineTo;
}

const setHeadingFold = StateEffect.define<{ pos: number; folded: boolean }>({
    map: (value, mapping) => {
        const pos = mapping.mapPos(value.pos, 1, MapMode.TrackAfter);
        // `undefined` is how an effect says "removed by this mapping".
        return pos === null ? undefined : { pos, folded: value.folded };
    },
});

const isReading = (state: EditorState): boolean => !state.facet(EditorView.editable);

/**
 * Collapse or expand the section of the heading a widget belongs to.
 *
 * The position is found from the DOM at CLICK time and never remembered:
 * CodeMirror hands a widget's DOM to any later widget that compares `eq`, at
 * whatever position that one sits — every toggle in a note is one of two
 * interchangeable values. The toggle sits at its heading line's start. The
 * pill spans the whole hidden range, so it expands the collapsed section whose
 * range its position touches, whichever edge the DOM lookup reports.
 */
function toggleFoldAt(view: EditorView, dom: HTMLElement, widget: 'toggle' | 'pill'): void {
    let pos: number;
    try {
        pos = view.posAtDOM(dom);
    } catch {
        return; // detached mid-click
    }
    const { state } = view;
    const value = state.field(headingFoldField, false);
    if (!value) return;
    if (widget === 'pill') {
        // Only a DRAWN fold can own the pill: an open (unparsed-to-the-end)
        // section around it is folded but not drawn, and expanding that
        // instead would leave the clicked one shut. Ascending, so a nested
        // collapsed section sharing its parent's end loses to the parent —
        // the only one of the two actually drawn.
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

/**
 * Keep the clicked heading where it is on screen. Collapsing near the end of a
 * note shortens it and the browser clamps the scroll; expanding it again then
 * left CodeMirror's scroll anchor below the section, and the heading just
 * clicked was thrown off screen — scrollTop 1667 → 2986 of 2986, the heading no
 * longer even drawn (measured). Pinned to its current offset, the click is the
 * only thing that moves: what follows the heading opens or closes beneath it.
 */
function holdHeading(view: EditorView, lineFrom: number): StateEffect<unknown>[] {
    const rect = view.coordsAtPos(lineFrom, 1);
    if (!rect) return [];
    const offset = rect.top - view.scrollDOM.getBoundingClientRect().top;
    return [EditorView.scrollIntoView(lineFrom, { y: 'start', yMargin: Math.max(0, offset) })];
}

// Lucide's chevron-down, as a string: widgets build raw DOM, not React (the
// same outline style copyCodeWidget.ts uses). A constant — no note text in it.
const CHEVRON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

// Lucide's ellipsis, for the pill. Drawn rather than typed: a "…" glyph sits on
// the text baseline, so it can never be centred in its pill (index.css).
const ELLIPSIS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';

function dressToggle(button: HTMLElement, folded: boolean): void {
    const label = folded ? 'Expand section' : 'Collapse section';
    button.setAttribute('aria-expanded', String(!folded));
    button.setAttribute('aria-label', label);
    button.title = label;
}

/**
 * The arrow in the margin left of a foldable heading.
 *
 * A zero-width inline-block anchor, cap-height tall and standing on the
 * baseline, holds an absolutely positioned button — so the arrow centres on the
 * heading's capitals on its FIRST row at every level and however the heading
 * wraps, and adds no width to the text.
 */
class HeadingFoldToggle extends WidgetType {
    constructor(readonly folded: boolean) {
        super();
    }

    override eq(other: HeadingFoldToggle): boolean {
        return other.folded === this.folded;
    }

    override toDOM(view: EditorView): HTMLElement {
        const anchor = document.createElement('span');
        anchor.className = 'cm-heading-fold-anchor';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cm-heading-fold-toggle';
        // Mouse-only: a long note would otherwise put a tab stop on every heading.
        button.tabIndex = -1;
        button.innerHTML = CHEVRON;
        dressToggle(button, this.folded);
        // A click toggles; it must not also move the selection to the heading.
        button.onmousedown = (e) => e.preventDefault();
        // Reads nothing from `this`: updateDOM keeps this DOM alive across
        // widget instances, so the one that built it may be long gone.
        button.onclick = (e) => {
            e.preventDefault();
            toggleFoldAt(view, anchor, 'toggle');
        };
        anchor.appendChild(button);
        return anchor;
    }

    /** Re-dressed in place rather than rebuilt, so the chevron's rotation
     *  animates instead of jumping. */
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

/** The "…" pill after a collapsed heading's text — a second way to expand it. */
class HeadingFoldPlaceholder extends WidgetType {
    override eq(): boolean {
        return true;
    }

    override toDOM(view: EditorView): HTMLElement {
        const pill = document.createElement('span');
        pill.className = 'cm-heading-fold-placeholder';
        pill.innerHTML = ELLIPSIS;
        pill.title = 'Expand section';
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

/* Positionless and immutable, so one instance backs every heading (the house
   rule livePreview's HIDE/BOLD follow): equal instances also let CodeMirror's
   decoration diff skip the DOM entirely on a rebuild that changed nothing. */
const FOLDABLE_LINE = Decoration.line({ class: 'cm-heading-foldable' });
// side -1: drawn before livePreview's HIDE of the `# ` prefix at the same
// position (a widget's side sorts before a non-inclusive replace's start).
const TOGGLE_OPEN = Decoration.widget({ widget: new HeadingFoldToggle(false), side: -1 });
const TOGGLE_FOLDED = Decoration.widget({ widget: new HeadingFoldToggle(true), side: -1 });
const FOLD_REPLACE = Decoration.replace({ widget: new HeadingFoldPlaceholder() });

const NO_FOLDS: readonly number[] = [];

interface HeadingFoldValue {
    /** Heading-line starts, sorted and unique. Its IDENTITY moves only when its
     *  contents do: the rebuild and the persistence listener both test by it. */
    readonly folded: readonly number[];
    readonly deco: DecorationSet;
    /** The last non-pointer selection (a search jump, ⌘F), for as long as a
     *  later parse could still show it to be inside a collapsed section. */
    readonly reveal: EditorSelection | null;
}

function build(state: EditorState, folded: readonly number[]): DecorationSet {
    if (!isReading(state)) return Decoration.none;
    const sections = headingSections(state);
    if (sections.length === 0) return Decoration.none;
    const isFolded = new Set(folded);
    const ranges: Range<Decoration>[] = [];
    // Nothing is emitted inside a collapsed ancestor: SpanCursor would skip it
    // anyway (see the top of the file), and skipping it here saves the DOM work.
    // A nested section's own fold survives in `folded` regardless.
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

/** Map folded positions through an edit; same array back when nothing moved. */
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
            // Text typed in front of the `#`: the line is not a heading any more.
            changed = true;
        } else {
            if (mapped !== pos) changed = true;
            next.push(mapped);
        }
    }
    if (!changed) return folded;
    if (lost) next.push(...reanchorFolds(tr, lost));
    // Mapping is monotonic, but a re-anchored fold can land anywhere, and two
    // folds can land on one line.
    next.sort((a, b) => a - b);
    return next.filter((pos, i) => i === 0 || pos !== next[i - 1]);
}

/**
 * Folds whose heading line an edit deleted, carried to an identical line the
 * SAME edit inserted: the n-th deleted copy of that exact text goes to the n-th
 * inserted copy. CodeMirror's Alt-↑/↓ moves a neighbouring line past a heading
 * by deleting the heading and re-inserting it on the other side, and dropping a
 * file on the pane replaces every line — neither is the heading being deleted,
 * the only thing the user decided may forget a collapse. A heading line deleted
 * outright has no inserted twin, so it is still forgotten and never slides
 * onto another; across a whole-file replace, copies pair by occurrence — the
 * same rule a stored key resolves by when the note is reopened. Runs only when
 * a fold was lost, over the changed lines alone.
 */
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

/** The starts of lines lying wholly inside [from, to] whose text is wanted,
 *  appended per text in document order. */
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

/** Reading mode only: drop positions that are provably no longer foldable. */
function pruneFolds(state: EditorState, folded: readonly number[]): readonly number[] {
    const sections = headingSections(state);
    const parsedTo = syntaxTree(state).length;
    const next = folded.filter((pos) => {
        // Past the parse, nothing is known yet — keep it.
        if (state.doc.lineAt(pos).to > parsedTo) return true;
        const section = sectionAt(sections, pos);
        return section !== null && !(section.closed && isEmpty(section));
    });
    return next.length === folded.length ? folded : next;
}

/**
 * A reveal landing strictly inside a hidden range expands every section hiding
 * it. Strictly: the pill's two edges are where a click on the collapsed
 * heading's line lands, and select-all (0…length) is not a reason to expand
 * anything. A section still open at the parse's edge counts with the end parsed
 * so far — its real end can only lie further on, so "inside" never reverses.
 */
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

/**
 * Could a later parse still put `reveal` inside a collapsed section? Only while
 * a collapsed heading before it has a section whose end is not known yet. A
 * search opens a note with only its first ~3000 characters parsed, so a match
 * below that sat "outside" every section, stayed collapsed-over, and was hidden
 * the moment the parse caught up (measured); held until then, it is decided in
 * the same update that first draws the fold.
 */
function revealUnsettled(state: EditorState, folded: readonly number[], reveal: EditorSelection): boolean {
    if (folded.length === 0) return false;
    let reach = 0;
    for (const range of reveal.ranges) reach = Math.max(reach, range.to);
    const sections = headingSections(state);
    const parsedTo = syntaxTree(state).length;
    return folded.some((pos) => {
        if (pos >= reach) return false;
        const section = sectionAt(sections, pos);
        // No section at a parsed line: not a heading at all (a stale key the
        // next prune drops), so there is nothing for the parse to reveal.
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
    // Markdown parses asynchronously: the tree advancing is a rebuild, exactly
    // as it is for livePreview, or sections past the first parsed prefix would
    // never get their arrows.
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

/* ── Persistence keys ── */

/** A collapsed heading as stored: its exact line text, and how many earlier
 *  lines of the note read identically. */
export type HeadingKey = [text: string, occurrence: number];

/** localStorage is user-editable: anything else reads as "nothing collapsed". */
export function isHeadingKeyList(value: unknown): value is HeadingKey[] {
    return Array.isArray(value) && value.every(key =>
        Array.isArray(key) && key.length === 2 && typeof key[0] === 'string'
        && Number.isInteger(key[1]) && key[1] >= 0);
}

/** Does the stored value already say exactly `keys`? (Nothing stored ≡ none.) */
export function sameHeadingKeys(stored: unknown, keys: readonly HeadingKey[]): boolean {
    if (stored === undefined) return keys.length === 0;
    return isHeadingKeyList(stored) && stored.length === keys.length
        && stored.every(([text, occurrence], i) => text === keys[i][0] && occurrence === keys[i][1]);
}

/** The state's collapsed headings, as keys. One pass over the lines up to the
 *  last collapsed heading. */
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

/** Keys → heading-line starts in `doc`, sorted. A key naming no line is dropped. */
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

/**
 * The collapsible-headings extension for one document, starting with the
 * sections `keys` name collapsed. Resolved before the first state exists, so
 * every restored fold whose section the opening parse (the note's first ~3000
 * characters) already closes is drawn before the scroll position is restored;
 * one further down is drawn when the background parse reaches its end. A key
 * that resolves to a line that is not a foldable heading draws nothing, and the
 * first reading-mode rebuild whose parse covers it prunes it.
 */
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
    // `decline()` is no longer in Vite's ViteHotContext type but is still a
    // runtime no-op method; the cast is type-only.
    (import.meta.hot as unknown as { decline(): void }).decline();
}
