import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import { EditorSelection, type EditorState, type SelectionRange, type StateEffect } from '@codemirror/state';
import {
    SearchQuery,
    closeSearchPanel,
    getSearchQuery,
    replaceAll,
    replaceNext,
    selectMatches,
    setSearchQuery,
} from '@codemirror/search';
import { openContextMenu } from '../utils/contextMenu';
import { copyText, readClipboardText, CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED } from '../utils/clipboard';

/* ── The note's ⌘F box ─────────────────────────────────────────────────────
   CodeMirror's own search panel was a full-width form along the bottom of the
   note: three word buttons, three labelled checkboxes and a second row of
   Replace controls, with no count of what it found. This is the same search —
   CodeMirror's query, highlighter, commands and keys, so ⌘G/F3, the reveal
   scroll and fold-opening all still apply — drawn as the compact box the PDF
   pane floats in its top-right corner (components/PdfFindBar.tsx): a field,
   "3 of 12", ‹ › ×, the three match options as toggles, and Replace behind a
   disclosure in Edit mode.

   It floats: the panel is absolutely placed inside CodeMirror's sticky top
   panel container (cmTheme.ts), so it takes no height from the note and stays
   in the corner however far the note scrolls.

   Unlike CodeMirror's panel, Replace follows the mode LIVE (`update`): that
   one decided once, in its constructor, so every ⌘E had to close and reopen it
   to add or drop the row. Reacting in place keeps the query, the focused
   control and its caret with no rebuild at all. */

/** Matches counted for "3 of 12" before it says "10,000+" instead. Measured
 *  cost on a 400 KB note: a full count of a one-letter query is ~4 ms, so the
 *  cap is about bounding the array, not the time. */
const COUNT_CAP = 10_000;
/** A document edit while the box is open recounts after this pause rather than
 *  on every keystroke: the count is the only part of the box that reads the
 *  whole note. */
const RECOUNT_DELAY_MS = 120;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
}

type ScrollToMatch = (range: SelectionRange, view: EditorView) => StateEffect<unknown>;

interface Count { starts: number[]; ends: number[]; capped: boolean }

function countMatches(state: EditorState, query: SearchQuery): Count {
    const starts: number[] = [], ends: number[] = [];
    if (!query.valid || !query.search) return { starts, ends, capped: false };
    const cursor = query.getCursor(state);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
        if (starts.length === COUNT_CAP) return { starts, ends, capped: true };
        starts.push(next.value.from);
        ends.push(next.value.to);
    }
    return { starts, ends, capped: false };
}

/** Index of the first match starting at or after `pos` (length if none). */
function firstAtOrAfter(starts: readonly number[], pos: number): number {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < pos) lo = mid + 1; else hi = mid; }
    return lo;
}

/** Index of the match the selection sits on, or -1. */
function currentIndex(count: Count, from: number, to: number): number {
    let lo = 0, hi = count.starts.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (count.starts[mid] < from) lo = mid + 1;
        else if (count.starts[mid] > from) hi = mid - 1;
        else return count.ends[mid] === to ? mid : -1;
    }
    return -1;
}

class FindPanel implements Panel {
    readonly dom: HTMLElement;
    readonly top = true;
    private query: SearchQuery;
    private count: Count = { starts: [], ends: [], capped: false };
    private recountTimer: ReturnType<typeof setTimeout> | undefined;
    private issue = '';
    private readonly searchField: HTMLInputElement;
    private readonly replaceField: HTMLInputElement;
    private readonly status: HTMLElement;
    private readonly prev: HTMLButtonElement;
    private readonly next: HTMLButtonElement;
    private readonly caseToggle: HTMLButtonElement;
    private readonly wordToggle: HTMLButtonElement;
    private readonly reToggle: HTMLButtonElement;
    private readonly disclosure: HTMLButtonElement;
    private readonly replaceRow: HTMLElement;
    private replaceOpen = false;
    private issueTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly view: EditorView, private readonly scrollToMatch: ScrollToMatch) {
        this.query = getSearchQuery(view.state);

        this.searchField = el('input', {
            type: 'text', class: 'bme-find-field', name: 'search', 'main-field': 'true',
            placeholder: 'Find in note', 'aria-label': 'Find in note',
            autocomplete: 'off', spellcheck: 'false',
        });
        this.replaceField = el('input', {
            type: 'text', class: 'bme-find-field', name: 'replace',
            placeholder: 'Replace with', 'aria-label': 'Replace with',
            autocomplete: 'off', spellcheck: 'false',
        });
        for (const field of [this.searchField, this.replaceField]) {
            field.addEventListener('input', () => this.commit());
        }

        const toggle = (name: string, label: string, glyph: string, tip: string) => {
            const button = el('button', { type: 'button', class: 'bme-find-toggle', name, 'aria-label': label, 'aria-pressed': 'false', 'data-tooltip': tip }, glyph);
            button.addEventListener('click', () => { button.setAttribute('aria-pressed', String(!this.pressed(button))); this.commit(); });
            return button;
        };
        this.caseToggle = toggle('case', 'Match case', 'Aa', 'Match case');
        this.wordToggle = toggle('word', 'Whole word', 'ab', 'Whole word');
        this.reToggle = toggle('re', 'Regular expression', '.*', 'Regular expression');

        const button = (name: string, label: string, glyph: string, tip: string, run: () => void, className = 'bme-find-button') => {
            const node = el('button', { type: 'button', class: className, name, 'aria-label': label, 'data-tooltip': tip }, glyph);
            node.addEventListener('click', run);
            return node;
        };
        this.prev = button('prev', 'Previous match', '‹', 'Previous match (⇧↩)', () => this.step(-1));
        this.next = button('next', 'Next match', '›', 'Next match (↩)', () => this.step(1));
        const close = button('close', 'Close find', '×', 'Close (Esc)', () => closeSearchPanel(view));
        this.disclosure = button('replace-toggle', 'Show replace', '›', 'Replace', () => this.setReplaceOpen(!this.replaceOpen, true), 'bme-find-button bme-find-disclosure');
        this.disclosure.setAttribute('aria-expanded', 'false');

        this.status = el('span', { class: 'bme-find-status', role: 'status', 'aria-live': 'polite' });

        const fieldBox = el('div', { class: 'bme-find-fieldbox' });
        fieldBox.append(this.searchField, this.caseToggle, this.wordToggle, this.reToggle);
        const main = el('div', { class: 'bme-find-row' });
        main.append(this.disclosure, fieldBox, this.status, this.prev, this.next, close);

        this.replaceRow = el('div', { class: 'bme-find-row bme-find-replace' });
        this.replaceRow.append(
            this.replaceField,
            button('replace', 'Replace', 'Replace', 'Replace this match (↩)', () => replaceNext(view), 'bme-find-text-button'),
            button('replaceAll', 'Replace all', 'All', 'Replace all (⌘↩ / Ctrl+↩)', () => replaceAll(view), 'bme-find-text-button'),
        );

        this.dom = el('div', { class: 'bme-find', role: 'search', 'aria-label': 'Find in note' });
        this.dom.append(main, this.replaceRow);
        this.dom.addEventListener('keydown', event => this.keydown(event));
        // A native listener that stops the event, so the note's own right-click
        // menu (DocumentPane's React onContextMenu on .view-content, whose
        // argument is that everything reaching it is note text) never sees a
        // click in this box — the same arrangement tableEdit's menu uses.
        this.dom.addEventListener('contextmenu', event => this.contextMenu(event));

        this.showQuery(this.query);
        this.recount();
        this.showMode();
    }

    mount(): void {
        // CodeMirror's panel does the same: opening the box puts the keyboard
        // in Find with its text selected. A view rebuilt around an already-open
        // box hands it back (noteSearch.ts returnKeyboard).
        this.searchField.select();
    }

    update(update: ViewUpdate): void {
        let queryChanged = false;
        for (const tr of update.transactions) {
            for (const effect of tr.effects) {
                if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
                    this.showQuery(effect.value);
                    queryChanged = true;
                }
            }
        }
        if (update.startState.readOnly !== update.state.readOnly) this.showMode();
        if (queryChanged) this.recount();
        else if (update.docChanged) this.scheduleRecount();
        else if (update.selectionSet) this.showStatus();
    }

    destroy(): void {
        if (this.recountTimer !== undefined) clearTimeout(this.recountTimer);
        if (this.issueTimer !== undefined) clearTimeout(this.issueTimer);
    }

    private pressed(button: HTMLButtonElement): boolean {
        return button.getAttribute('aria-pressed') === 'true';
    }

    private showQuery(query: SearchQuery): void {
        this.query = query;
        if (this.searchField.value !== query.search) this.searchField.value = query.search;
        if (this.replaceField.value !== query.replace) this.replaceField.value = query.replace;
        this.caseToggle.setAttribute('aria-pressed', String(query.caseSensitive));
        this.wordToggle.setAttribute('aria-pressed', String(query.wholeWord));
        this.reToggle.setAttribute('aria-pressed', String(query.regexp));
        if (query.replace && !this.replaceOpen) this.setReplaceOpen(true, false);
    }

    /** Read the fields into a query. A new search moves to its first match at
     *  or after where the reader is — the current match while refining one —
     *  as the PDF box and every browser's find do. */
    private commit(): void {
        const query = new SearchQuery({
            search: this.searchField.value,
            replace: this.replaceField.value,
            caseSensitive: this.pressed(this.caseToggle),
            wholeWord: this.pressed(this.wordToggle),
            regexp: this.pressed(this.reToggle),
        });
        if (query.eq(this.query)) return;
        const searchChanged = query.search !== this.query.search || query.caseSensitive !== this.query.caseSensitive
            || query.wholeWord !== this.query.wholeWord || query.regexp !== this.query.regexp;
        this.query = query;
        this.issue = '';
        this.view.dispatch({ effects: setSearchQuery.of(query) });
        this.recount();
        if (searchChanged) this.jumpFrom(this.view.state.selection.main.from);
    }

    /** Select the first match starting at or after `from`, wrapping to the top.
     *  From the current match's own start, a match that still fits as the
     *  query grows stays the current one. */
    private jumpFrom(from: number): void {
        const { starts } = this.count;
        if (!starts.length) return;
        const at = firstAtOrAfter(starts, from);
        this.select(at < starts.length ? at : 0);
    }

    /** The next or previous match from the selection, wrapping. The box steps
     *  itself rather than through `findNext`/`findPrevious`: those re-select
     *  all of Find's text whenever Find has the keyboard (`selectSearchInput`),
     *  so a letter typed after ↩ replaced the query instead of refining it —
     *  and typing "apple" as-you-go left "e" in the field (measured). */
    private step(direction: 1 | -1): void {
        if (this.recountTimer !== undefined) this.recount();
        const { starts } = this.count, total = starts.length;
        if (!total) return;
        const { from, to } = this.view.state.selection.main;
        const current = currentIndex(this.count, from, to);
        if (current >= 0) { this.select((current + direction + total) % total); return; }
        const at = firstAtOrAfter(starts, from);
        this.select(direction > 0 ? (at < total ? at : 0) : (at > 0 ? at - 1 : total - 1));
    }

    private select(index: number): void {
        const range = EditorSelection.range(this.count.starts[index], this.count.ends[index]);
        this.view.dispatch({
            selection: EditorSelection.create([range]),
            effects: this.scrollToMatch(range, this.view),
            userEvent: 'select.search',
        });
    }

    private scheduleRecount(): void {
        if (this.recountTimer !== undefined) clearTimeout(this.recountTimer);
        this.recountTimer = setTimeout(() => { this.recountTimer = undefined; this.recount(); }, RECOUNT_DELAY_MS);
    }

    private recount(): void {
        if (this.recountTimer !== undefined) { clearTimeout(this.recountTimer); this.recountTimer = undefined; }
        this.count = countMatches(this.view.state, this.query);
        this.showStatus();
    }

    private showStatus(): void {
        const { query, count } = this;
        const total = count.starts.length;
        const { from, to } = this.view.state.selection.main;
        const index = total ? currentIndex(count, from, to) : -1;
        const many = `${total.toLocaleString('en-US')}${count.capped ? '+' : ''}`;
        this.status.textContent = this.issue
            || (!query.search ? ''
                : !query.valid ? 'Invalid pattern'
                : !total ? 'No results'
                : index >= 0 ? `${(index + 1).toLocaleString('en-US')} of ${many}`
                : `${many} ${total === 1 && !count.capped ? 'match' : 'matches'}`);
        this.prev.disabled = this.next.disabled = !total;
    }

    /** Replace exists only where the note can change. Leaving Edit mode with the
     *  keyboard in the Replace row puts it at the end of Find, not on <body>. */
    private showMode(): void {
        const editable = !this.view.state.readOnly;
        this.disclosure.hidden = !editable;
        const active = this.view.root.activeElement;
        const wasInReplace = active instanceof Node && this.replaceRow.contains(active);
        this.replaceRow.hidden = !editable || !this.replaceOpen;
        if (wasInReplace && this.replaceRow.hidden) {
            this.searchField.focus({ preventScroll: true });
            const end = this.searchField.value.length;
            this.searchField.setSelectionRange(end, end);
        }
    }

    private setReplaceOpen(open: boolean, focus: boolean): void {
        this.replaceOpen = open;
        this.disclosure.classList.toggle('is-open', open);
        this.disclosure.setAttribute('aria-label', open ? 'Hide replace' : 'Show replace');
        this.disclosure.setAttribute('aria-expanded', String(open));
        this.showMode();
        if (focus) (open ? this.replaceField : this.searchField).focus({ preventScroll: true });
    }

    private keydown(event: KeyboardEvent): void {
        if (event.isComposing) return;
        // ⌘G/⇧⌘G and F3 step here too, for the reason `step` gives; the
        // note's own ⌘G (keyboard in the text) stays CodeMirror's findNext.
        const findKey = event.key === 'F3' || (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'g';
        if (findKey) { event.preventDefault(); this.step(event.shiftKey ? -1 : 1); return; }
        // Escape and ⌘F — searchKeymap's 'search-panel' scope.
        if (runScopeHandlers(this.view, event, 'search-panel')) { event.preventDefault(); return; }
        if (event.key !== 'Enter') return;
        if (event.target === this.searchField) {
            event.preventDefault();
            if (event.altKey) selectMatches(this.view);
            else this.step(event.shiftKey ? -1 : 1);
        } else if (event.target === this.replaceField) {
            event.preventDefault();
            (event.metaKey || event.ctrlKey ? replaceAll : replaceNext)(this.view);
        }
    }

    private contextMenu(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        const field = event.target;
        if (!(field instanceof HTMLInputElement)) return;
        const value = field.value, from = field.selectionStart ?? 0, to = field.selectionEnd ?? from;
        const selected = value.slice(from, to);
        // A blocked clipboard is said in the status slot for a few seconds,
        // then the count comes back.
        const tell = (message: string) => {
            this.issue = message;
            this.showStatus();
            if (this.issueTimer !== undefined) clearTimeout(this.issueTimer);
            this.issueTimer = setTimeout(() => { this.issueTimer = undefined; this.issue = ''; this.showStatus(); }, 4000);
        };
        const replace = (text: string) => {
            if (!field.isConnected || field.value !== value) return;
            field.focus();
            field.setSelectionRange(from, to);
            // execCommand keeps the field's own undo history; setRangeText is
            // the fallback where Chrome refuses it.
            if (!document.execCommand('insertText', false, text)) {
                field.setRangeText(text, from, to, 'end');
                this.commit();
            }
        };
        const none = selected ? undefined : 'Nothing is selected';
        openContextMenu({
            x: event.clientX, y: event.clientY, opener: field, label: 'Find field',
            entries: [
                { kind: 'command', id: 'note-find-cut', label: 'Cut', disabled: !selected, reason: none,
                    run: async () => { if (await copyText(selected)) replace(''); else tell(CLIPBOARD_WRITE_BLOCKED); } },
                { kind: 'command', id: 'note-find-copy', label: 'Copy', disabled: !selected, reason: none,
                    run: async () => { if (!await copyText(selected)) tell(CLIPBOARD_WRITE_BLOCKED); } },
                { kind: 'command', id: 'note-find-paste', label: 'Paste',
                    run: async () => { const read = await readClipboardText(); if (!read.ok) tell(CLIPBOARD_READ_BLOCKED); else if (read.text) replace(read.text.replace(/\r?\n/g, ' ')); } },
                { kind: 'command', id: 'note-find-all', label: 'Select all', run: () => { field.focus(); field.select(); } },
            ],
        });
    }
}

/** `search({ createPanel })` for every text document's view. `scrollToMatch`
 *  is the same effect given to `search()`: CodeMirror keeps its config facet
 *  private, so the box is handed it to scroll its own jumps the same way. */
export function findPanel(scrollToMatch: ScrollToMatch): (view: EditorView) => Panel {
    return view => new FindPanel(view, scrollToMatch);
}
