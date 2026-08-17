import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { openContextMenu } from '../utils/contextMenu';
import type { ContextMenuEntry } from '../utils/contextMenu';
import {
    CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED, copyText, readClipboardText,
} from '../utils/clipboard';
import {
    blankRowText, blankTableText, delimiterCellText, escapeNewPipes, parseTableLayout,
    protectTrailingBackslash, tableLayoutAt,
} from './tableModel';
import type { RowSpan, TableLayout } from './tableModel';
// A deliberate cycle: tableWidget imports this module's session functions and
// this module imports its two DOM readers back. It exists so that "leaving a
// cell re-renders it" — an HTML path — stays in tableWidget beside the CELL_HTML
// allowlist, rather than a SECOND innerHTML sink being opened here. The rule
// that keeps it safe: neither side may touch the other's exports at MODULE
// EVALUATION time. Every use on both sides is inside a function body, and it
// must stay that way.
import { restoreRenderedCell, tableModelOf } from './tableWidget';

/* ── Editing a table through its cells ────────────────────────────────────
 *
 * Every cell of a rendered table is a contenteditable="plaintext-only" island
 * (tableWidget.ts), and this module is what happens inside one: the keyboard
 * contract, the write-back, the row and column commands, and the cell's own
 * context menu.
 *
 * Two rules run through all of it.
 *
 * WRITE THROUGH, NEVER BUFFER. Every input event dispatches a document change
 * immediately, so the document stays the single source of truth and autosave,
 * ⌘S, vault search, the graph, tab switching and pane unmount all keep working
 * with no new code. There is nowhere safe to flush a buffered edit FROM: a pane
 * unmount destroys the widget, and destroy() runs inside a CodeMirror update
 * where dispatching throws.
 *
 * SURGICAL, NEVER RECONSTRUCTED. A write replaces the narrowest span that
 * actually changed — one cell, one line, one segment per line. Nothing here
 * ever rewrites a table the user already has, which is what makes their
 * hand-aligned padding, their alignment colons and their `\|` escapes survive
 * an edit to the cell beside them byte for byte. Rebuilding from a parsed grid
 * would also DELETE data: a body row with more cells than the header is
 * truncated on render, and a serializing writer would write that truncation
 * back to the file on the first keystroke.
 *
 * The session is module-level rather than per-pane because it is per-DOCUMENT
 * state that outlives any React pane: the widget's handlers are attached to an
 * element CodeMirror pools and re-dresses, and anything they reach has to be
 * stable for the app's life.
 */

/** The cell currently being typed in, if any. One at a time, by construction:
 *  focus is what starts a session and losing it is what ends one. */
interface Session {
    dom: HTMLElement;
    view: EditorView;
    cell: HTMLElement;
    /** Rendered indices — the header is row 0 and the delimiter is not a row. */
    row: number;
    col: number;
    /** The table source this session's next dispatch will produce. Published
     *  BEFORE the dispatch; see publishExpected. */
    expected: string;
    /** Caret offset within the cell's text, for the focus repair below. */
    offset: number;
}
let session: Session | null = null;

export function activeCellSession(): { dom: HTMLElement; expected: string } | null {
    return session ? { dom: session.dom, expected: session.expected } : null;
}

/**
 * How this module tells the user something failed — a refused clipboard read in
 * a cell, and nothing else today. Wired ONCE by App to `tell`. A module-level
 * setter, not a prop or a facet: it must be stable for the app's life (a
 * widget's handlers outlive the pane that built them) and src/editor/ must not
 * learn about React. Defaults to a console.warn so a caller that runs before
 * App mounts is never silent.
 */
let notify: (message: string) => void = (message) => { console.warn(message); };

export function setTableNotify(next: (message: string) => void): void {
    notify = next;
}

/**
 * "Read-only" in this app is EditorView.editable and nothing else.
 *
 * Reading mode is `readOnlyCompartment.of(EditorView.editable.of(mode !==
 * 'read'))`, despite the compartment's name; EditorState.readOnly is never set
 * anywhere in src/, so testing it alone is always false — and
 * EditorView.editable.of(false) does NOT block a programmatic dispatch, so a
 * command guarded that way would really edit a document the user is only
 * reading. This is the lists.ts:425 predicate, and every guard here uses it.
 */
function canWrite(view: EditorView): boolean {
    return !view.state.readOnly && view.state.facet(EditorView.editable);
}

/**
 * Where this table sits in the CURRENT document.
 *
 * Never a remembered position: the widget knows its own contents and not where
 * they are, and by the time a key is pressed the document above it may have
 * moved. posAtDOM throws for a detached node, which is the same treatment
 * imageWidget's embedAt gives it.
 */
function locate(view: EditorView, dom: HTMLElement): TableLayout | null {
    let pos: number;
    try {
        pos = view.posAtDOM(dom);
    } catch {
        return null;
    }
    return parseTableLayout(view.state.doc, pos);
}

/** The table's rendered shape, read off the widget's own model. */
function shapeOf(dom: HTMLElement): { rows: number; columns: number } | null {
    const model = tableModelOf(dom);
    return model ? { rows: model.cellText.length, columns: model.columns } : null;
}

function cellElement(dom: HTMLElement, row: number, col: number): HTMLElement | null {
    return dom.querySelector(`.cm-table-cell[data-row="${row}"][data-col="${col}"]`);
}

/* ── The caret, inside a cell ─────────────────────────────────────────────
   CodeMirror's own caret is not drawn here — view.hasFocus is false while a
   cell holds focus, so .cm-cursor stays hidden and there is no double caret.
   What shows is the browser's native caret, which drawSelection's own theme
   restores for any focused element inside .cm-content. So all this code has to
   do is keep a DOM Range in the right place. */

/** How many characters into the cell a DOM position is. */
function offsetOf(cell: HTMLElement, node: Node, offset: number): number {
    const measure = document.createRange();
    measure.selectNodeContents(cell);
    try {
        measure.setEnd(node, offset);
    } catch {
        return (cell.textContent ?? '').length;
    }
    return measure.toString().length;
}

function caretOffset(cell: HTMLElement): number {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return (cell.textContent ?? '').length;
    const range = selection.getRangeAt(0);
    if (!cell.contains(range.endContainer)) return (cell.textContent ?? '').length;
    return offsetOf(cell, range.endContainer, range.endOffset);
}

function placeCaret(cell: HTMLElement, offset: number): void {
    const range = document.createRange();
    let remaining = Math.max(0, offset);
    let target: Text | null = null;
    let last: Text | null = null;
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        last = text;
        if (remaining <= text.length) { target = text; break; }
        remaining -= text.length;
    }
    if (target) { range.setStart(target, remaining); range.collapse(true); }
    else if (last) { range.setStart(last, last.length); range.collapse(true); }
    else { range.selectNodeContents(cell); range.collapse(false); }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

/** Put the caret where a horizontal coordinate points, so arrowing down into a
 *  table lands under the column the caret was already in. */
function placeCaretAtX(cell: HTMLElement, x: number): void {
    const rect = cell.getBoundingClientRect();
    const at = Math.min(Math.max(x, rect.left + 1), Math.max(rect.left + 1, rect.right - 1));
    const range = document.caretRangeFromPoint?.(at, rect.top + rect.height / 2) ?? null;
    if (range && cell.contains(range.startContainer)) {
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
    }
    placeCaret(cell, (cell.textContent ?? '').length);
}

/**
 * Put focus back in the cell after a write — the MECHANISM, not a safety net.
 *
 * Measured: a dispatch that changes the table's source blurs the focused cell
 * to BODY, even though the <td> element is the same node and is still
 * connected and updateDOM returned true. Chromium blurs it during CodeMirror's
 * re-attach. Without this repair the table is one you can type exactly one
 * character into: the first keystroke lands, focus goes to the body, and every
 * one after it goes nowhere. (Re-measured in this app's real extension stack:
 * with the repair, a five-character burst reaches the document and the file;
 * without it, only the first character does.)
 */
function repairFocus(current: Session): void {
    if (document.activeElement === current.cell) return;
    // The cell can genuinely be gone: typing `-` into every header cell makes
    // the header row itself a valid separator line, which parseGrid rejects by
    // design, so the whole table stops being decorated and the widget is
    // destroyed mid-write-back. Focusing a detached node would silently do
    // nothing; saying so is better than relying on that.
    if (!current.cell.isConnected) return;
    current.cell.focus({ preventScroll: true });
    placeCaret(current.cell, Math.min(current.offset, (current.cell.textContent ?? '').length));
}

/* ── Beginning and ending a session ──────────────────────────────────────── */

function beginCellEdit(view: EditorView, dom: HTMLElement, cell: HTMLElement): void {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    const layout = locate(view, dom);
    if (!layout) return;

    // The focused cell shows its RAW SOURCE — `a \| b`, not the unescaped
    // `a | b` the rendered cell shows. That is what the rest of the live
    // preview already does (put the caret on a bold word and the `**` appear),
    // applied at cell granularity, and it is what makes an untouched cell a
    // byte-identical no-op on the way out.
    const span = layout.rows[row]?.cells[col];
    const raw = span ? view.state.sliceDoc(span.from, span.to) : '';
    // Only when it differs — the common case is a cell with no inline markdown,
    // where rewriting the text node would throw away the caret the click just
    // placed and drop it at the end of the cell instead.
    if ((cell.textContent ?? '') !== raw) {
        cell.textContent = raw;
        placeCaret(cell, raw.length);
    }
    cell.classList.add('cm-table-cell-editing');

    session = {
        dom, view, cell, row, col,
        expected: view.state.sliceDoc(layout.from, layout.to),
        offset: caretOffset(cell),
    };

    // Park the document selection on the table's own start, so every other
    // reader of state.selection sees something sane while the real caret is in
    // a cell. Legal because a boundary is never "strictly inside", and safe
    // because CodeMirror does not move the DOM selection while focus is off the
    // contentDOM.
    const main = view.state.selection.main;
    if (!main.empty || main.from !== layout.from) {
        view.dispatch({ selection: { anchor: layout.from } });
    }
}

export function endCellEdit(): void {
    const ending = session;
    if (!ending) return;
    // Cleared first: restoring the cell must not be able to re-enter this.
    session = null;
    ending.cell.classList.remove('cm-table-cell-editing');
    restoreRenderedCell(ending.dom, ending.cell);
}

/**
 * Every dispatch that changes this table's source WHILE A SESSION IS LIVE
 * publishes its expected result first.
 *
 * updateDOM refuses the session's own element to any widget whose text is not
 * the one this edit just wrote. During the dispatch the source has changed but
 * `expected` would still hold the previous value, so the guard fires, CodeMirror
 * finds no reusable tile, builds a fresh one through toDOM, and destroys the
 * old one — which endCellEdit turns into the cell being torn out from under the
 * caret mid-word.
 *
 * The structural commands do NOT use this. They end the session instead: a
 * published `expected` sends updateDOM down its "our own write-back, touch
 * nothing" branch, and a table that just gained a row would never be redrawn.
 */
function publishExpected(dom: HTMLElement, next: string): void {
    if (session && session.dom === dom) session.expected = next;
}

/* ── The write-back ──────────────────────────────────────────────────────── */

function writeBack(): void {
    const current = session;
    if (!current) return;
    const { view, cell } = current;

    const raw = cell.textContent ?? '';
    const { text, map } = escapeNewPipes(raw);
    let offset = caretOffset(cell);
    if (text !== raw) {
        // Escaped BEFORE the dispatch, so the DOM and the document agree —
        // which is what makes the identity check below exact. Only what the
        // reader can undo by typing goes in here: `|` became `\|` because they
        // typed a `|`, and a pasted newline became a space. The trailing-
        // backslash guard is deliberately NOT part of this (see `written`
        // below) — it is not something a keystroke can take back, so a cell
        // holding it could not be edited out of that state at all.
        cell.textContent = text;
        offset = map(offset);
        placeCaret(cell, offset);
    }
    current.offset = offset;

    let layout = locate(view, current.dom);
    if (!layout) return;
    if (!layout.rows[current.row]) return;

    // A cell the source does not back — a body row shorter than the header,
    // which renders as empty.
    if (current.col >= layout.rows[current.row].cells.length) {
        layout = widenRow(view, current.dom, layout, current.row);
        if (!layout) return;
        repairFocus(current);
        cell.removeAttribute('data-pad');
    }

    const span = layout.rows[current.row]?.cells[current.col];
    if (!span) return;

    // TRIMMED on the way into the document, though not in the DOM.
    //
    // A cell's span excludes the padding either side of it, because that
    // padding is the writer's and this feature never reformats it. So writing
    // the DOM's text verbatim would re-insert whatever whitespace it currently
    // carries ON TOP of the padding already in the file — and it compounds,
    // because the DOM keeps that whitespace for the rest of the session. Typing
    // `a b c` into `| a |` left `| a b c   |`: one extra space per space
    // keystroke, invisible in the rendered table (GFM trims cells) and there in
    // the user's file for good. The DOM keeps `text` untrimmed so the caret map
    // and the caret itself are undisturbed mid-word; only what lands in the
    // document is trimmed, which also makes a trailing-space keystroke the
    // no-op transaction it should be.
    //
    // The trailing-backslash guard therefore has to run HERE, on the trimmed
    // string, rather than inside escapeNewPipes: the trim is precisely what
    // strips the whitespace that would otherwise hide an odd backslash run from
    // it (`escapeNewPipes('cmd \ ').text.trim()` is `cmd \`, which escapes the
    // row's closing pipe and costs an unpadded table a whole column). And it is
    // applied to `written` alone, never to the DOM: the transformation is
    // idempotent, so a cell carrying its result became a fixed point — typing
    // `\` gave `\\` and no Backspace could ever remove it, because the next
    // input event re-escaped what had just been deleted. `abutsPipe` is the only
    // case that needs it at all; anywhere else the character after the span is a
    // space, and `\ ` is not an escape.
    const abutsPipe = span.to === layout.rows[current.row].pipes[current.col + 1];
    const trimmed = text.trim();
    const written = abutsPipe ? protectTrailingBackslash(trimmed) : trimmed;
    if (view.state.sliceDoc(span.from, span.to) === written) return;

    publishExpected(current.dom, sourceAfter(view, layout, [{ from: span.from, to: span.to, insert: written }]));
    // input.type so history() groups consecutive keystrokes exactly as typing
    // in the document does — which is what makes one ⌘Z undo one burst.
    view.dispatch({ changes: { from: span.from, to: span.to, insert: written }, userEvent: 'input.type' });
    repairFocus(current);

    // Deliberately NOT calling updateTabContent and NOT flushing: the pane's own
    // update listener fires on any docChanged, and the 1 s save debounce is also
    // the asset-diff undo grace period.
}

/**
 * Widen a row the header has outgrown, so a cell the source does not back can
 * be written to at all.
 *
 * Its OWN transaction, on purpose: it is a structural change to the line, and
 * folding it into the character the user just typed would make one ⌘Z undo
 * both. Two spaces per cell, like blankRowText and insertColumn — which is what
 * puts the empty cell's caret position one space in, so the first character
 * typed into it lands as `| X |`.
 *
 * Returns the RE-LOCATED layout, because every offset in the old one is stale
 * the moment this dispatches.
 */
function widenRow(view: EditorView, dom: HTMLElement, layout: TableLayout, row: number): TableLayout | null {
    const line = layout.rows[row];
    if (!line) return null;
    const missing = layout.columns - line.cells.length;
    if (missing <= 0) return layout;
    const at = line.pipes[line.pipes.length - 1] + 1;
    const pad = '  |'.repeat(missing);
    publishExpected(dom, sourceAfter(view, layout, [{ from: at, insert: pad }]));
    view.dispatch({ changes: { from: at, insert: pad }, userEvent: 'input.type' });
    return locate(view, dom);
}

/** One change, in document offsets. */
interface Edit { from: number; to?: number; insert?: string }

/** What the table's source becomes once `changes` (ascending, non-overlapping)
 *  are applied — the string a live session has to publish before dispatching. */
function sourceAfter(view: EditorView, layout: TableLayout, changes: Edit[]): string {
    const source = view.state.sliceDoc(layout.from, layout.to);
    let out = '';
    let at = 0;
    for (const change of changes) {
        const from = Math.max(at, Math.min(source.length, change.from - layout.from));
        const to = Math.max(from, Math.min(source.length, (change.to ?? change.from) - layout.from));
        out += source.slice(at, from) + (change.insert ?? '');
        at = to;
    }
    return out + source.slice(at);
}

/* ── Focus ──────────────────────────────────────────────────────────────── */

export function focusTableCell(
    dom: HTMLElement,
    row: number,
    col: number,
    where: 'start' | 'end' | { x: number },
): boolean {
    const cell = cellElement(dom, row, col);
    if (!cell) return false;
    // focus() fires focusin synchronously, which is what begins the session and
    // swaps the cell to its raw source — so the caret is placed afterwards.
    cell.focus({ preventScroll: true });
    if (where === 'start') placeCaret(cell, 0);
    else if (where === 'end') placeCaret(cell, (cell.textContent ?? '').length);
    else placeCaretAtX(cell, where.x);
    if (session && session.cell === cell) session.offset = caretOffset(cell);
    return document.activeElement === cell;
}

/** Focus a cell of the table starting at `from`, after an edit has rebuilt it. */
function focusAfterEdit(view: EditorView, from: number, row: number, col: number): void {
    const dom = tableDomAt(view, from);
    if (dom) focusTableCell(dom, row, col, 'start');
}

/** Leave the table entirely, with the caret in the document beside it. */
function leaveTable(view: EditorView, dom: HTMLElement, side: 'from' | 'to'): void {
    const layout = locate(view, dom);
    endCellEdit();
    if (layout) view.dispatch({ selection: { anchor: side === 'from' ? layout.from : layout.to } });
    view.focus();
}

export function tableDomAt(view: EditorView, from: number): HTMLElement | null {
    for (const node of Array.from(view.contentDOM.querySelectorAll('.cm-table-widget'))) {
        const dom = node as HTMLElement;
        try {
            if (view.posAtDOM(dom) === from) return dom;
        } catch {
            // Detached between the query and the read — not the one we want.
        }
    }
    return null;
}

/* ── Structural commands ─────────────────────────────────────────────────
   Each is ONE transaction whose changes are sorted ascending, and each ends
   the edit session first (see publishExpected). None of them confirms: a
   deletion here is a text edit and one ⌘Z undoes it, while `ask` is reserved
   for operations that move a FILE. */

/** The table's lines in document order — header, delimiter, then body rows. */
function linesOf(layout: TableLayout): { span: RowSpan; delimiter: boolean }[] {
    return [
        { span: layout.rows[0], delimiter: false },
        { span: layout.delimiter, delimiter: true },
        ...layout.rows.slice(1).map(span => ({ span, delimiter: false })),
    ];
}

export function insertRow(view: EditorView, dom: HTMLElement, afterRow: number): boolean {
    if (!canWrite(view)) return false;
    // Precondition, and the reason tableMenuEntries disables "Insert row above"
    // on the header: GFM cannot express a row above the header at all.
    if (afterRow < 0) return false;
    const layout = locate(view, dom);
    if (!layout || afterRow >= layout.rows.length) return false;

    // A row "after the header" goes below the DELIMITER — two header rows is
    // not a thing GFM can say.
    const at = afterRow === 0 ? layout.delimiter.to : layout.rows[afterRow].to;
    endCellEdit();
    view.dispatch({
        changes: { from: at, insert: '\n' + blankRowText(layout.columns) },
        userEvent: 'input',
    });
    focusAfterEdit(view, layout.from, afterRow + 1, 0);
    return true;
}

export function deleteRow(view: EditorView, dom: HTMLElement, row: number): boolean {
    if (!canWrite(view)) return false;
    const layout = locate(view, dom);
    if (!layout) return false;
    // The header is not a row anyone can delete, and taking the last body row
    // would stop the whole thing matching — the table would silently become
    // three lines of raw pipe text.
    if (row <= 0 || row >= layout.rows.length || layout.rows.length <= 2) return false;

    endCellEdit();
    view.dispatch({
        changes: { from: layout.rows[row].from - 1, to: layout.rows[row].to, insert: '' },
        userEvent: 'input',
    });
    focusAfterEdit(view, layout.from, Math.min(row, layout.rows.length - 2), 0);
    return true;
}

export function insertColumn(view: EditorView, dom: HTMLElement, afterCol: number): boolean {
    if (!canWrite(view)) return false;
    const layout = locate(view, dom);
    if (!layout || afterCol < -1 || afterCol >= layout.columns) return false;

    const delimiterCell = ` ${delimiterCellText(null)} |`;
    const changes: Edit[] = linesOf(layout).map(({ span, delimiter }) => {
        const cell = delimiter ? delimiterCell : '  |';
        if (afterCol + 1 < span.pipes.length) {
            return { from: span.pipes[afterCol + 1] + 1, insert: cell };
        }
        // A row too short to reach the insertion point is padded to it in the
        // same transaction, so every line still ends with the same number of
        // pipes and the column really is a column.
        const pad = cell.repeat(afterCol + 1 - span.cells.length);
        return { from: span.pipes[span.pipes.length - 1] + 1, insert: pad + cell };
    });

    const row = session && session.dom === dom ? session.row : 0;
    endCellEdit();
    view.dispatch({ changes, userEvent: 'input' });
    focusAfterEdit(view, layout.from, row, afterCol + 1);
    return true;
}

export function deleteColumn(view: EditorView, dom: HTMLElement, col: number): boolean {
    if (!canWrite(view)) return false;
    const layout = locate(view, dom);
    if (!layout || layout.columns <= 1 || col < 0 || col >= layout.columns) return false;

    const changes: Edit[] = [];
    for (const { span } of linesOf(layout)) {
        if (col >= span.cells.length) continue;
        // A one-segment row is SKIPPED, and that half is not optional: removing
        // its only segment takes the closing pipe with it and leaves a bare `|`
        // line, which stops matching, drops out of the table, and writes a stray
        // pipe into the user's file. Such a row keeps its cell and is padded on
        // render like any other short row.
        if (span.cells.length < 2) continue;
        changes.push({ from: span.pipes[col] + 1, to: span.pipes[col + 1] + 1, insert: '' });
    }
    if (changes.length === 0) return false;

    const row = session && session.dom === dom ? session.row : 0;
    endCellEdit();
    view.dispatch({ changes, userEvent: 'input' });
    focusAfterEdit(view, layout.from, row, Math.min(col, layout.columns - 2));
    return true;
}

export function deleteTable(view: EditorView, dom: HTMLElement): boolean {
    if (!canWrite(view)) return false;
    const layout = locate(view, dom);
    if (!layout) return false;

    let from = layout.from;
    let to = layout.to;
    // The table's own line goes with it rather than being left behind as a
    // blank one; on the last line there is no trailing newline, so the
    // preceding one goes instead.
    if (to < view.state.doc.length) to += 1;
    else if (from > 0) from -= 1;

    endCellEdit();
    view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'delete' });
    view.focus();
    return true;
}

export function insertTableAtCursor(view: EditorView, rows: number, cols: number): boolean {
    if (!canWrite(view)) return false;
    const head = view.state.selection.main.head;
    // A caret parked on a table's own edge is sitting on one of that table's
    // LINES — `from` is the header line's start, and atomic motion parks the
    // caret there deliberately, as does the editor menu moving it to wherever
    // the right-click landed. Inserting at that line's end would drop the new
    // table between the old one's header and its delimiter, and BOTH would stop
    // being tables. So a table under the caret is stepped over, not into.
    const under = tableLayoutAt(view.state.doc, head);
    const line = view.state.doc.lineAt(under ? under.to : head);
    const body = blankTableText(rows, cols);

    // A table has to start its own line, with a blank line on BOTH sides of it.
    // After, so whatever follows is not read as another body row — and before,
    // for the exact mirror reason, which is the half that was missing: the
    // pattern's body group `(?:^\|.+\|[ \t]*\n?)+` accepts EVERY pipe-fenced
    // line under a table, so a new table written straight beneath an existing
    // one's last row is swallowed whole, delimiter row and all. Measured on
    // `| a | b |` / `| --- | --- |` / `| c | d |` / (blank): inserting on that
    // blank line left ONE six-row table whose fourth row rendered the literal
    // `---  ---` as data, and no new table — so `tableFrom` was the start of
    // nothing, `tableDomAt` returned null, and the reader got no caret either.
    // The non-blank branch's leading '\n\n' has always supplied this; the
    // blank-line branch did not, and that blank line is exactly where the caret
    // lands when the reader right-clicks the gap under a table
    // (DocumentPane moves it to the click before opening the menu).
    const onBlankLine = line.text.trim().length === 0;
    const lead = onBlankLine && line.number > 1
        && view.state.doc.line(line.number - 1).text.trim().length > 0 ? '\n' : '';
    const from = onBlankLine ? line.from : line.to;
    const insert = onBlankLine ? lead + body + '\n' : '\n\n' + body + '\n';
    const tableFrom = from + (onBlankLine ? lead.length : 2);

    // Deliberately not `input.type`: the caret-adoption rule watches for a typed
    // insertion ending at a table's edge, and this command places its own caret.
    view.dispatch({ changes: { from, insert }, userEvent: 'input' });
    const dom = tableDomAt(view, tableFrom);
    // The first HEADER cell, which is where Google Docs leaves it.
    if (dom) focusTableCell(dom, 0, 0, 'start');
    return true;
}

/* ── Moving between cells ────────────────────────────────────────────────── */

function stepCell(view: EditorView, dom: HTMLElement, row: number, col: number, delta: 1 | -1): void {
    const shape = shapeOf(dom);
    if (!shape) return;
    let nextRow = row;
    let nextCol = col + delta;
    if (nextCol >= shape.columns) { nextCol = 0; nextRow += 1; }
    if (nextCol < 0) { nextCol = shape.columns - 1; nextRow -= 1; }
    if (nextRow < 0) return;                       // Shift-Tab in the first cell: nothing
    if (nextRow >= shape.rows) {
        // Tab out of the last cell appends a row and lands in it, the way it
        // does in every table editor.
        insertRow(view, dom, shape.rows - 1);
        return;
    }
    focusTableCell(dom, nextRow, nextCol, delta > 0 ? 'start' : 'end');
}

function insertTextAtCaret(cell: HTMLElement, text: string): void {
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !cell.contains(range.startContainer)) {
        const at = (cell.textContent ?? '').length;
        cell.textContent = (cell.textContent ?? '') + text;
        placeCaret(cell, at + text.length);
        return;
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

/* ── The keyboard contract ───────────────────────────────────────────────
   CodeMirror never sees a keystroke inside a cell — eventBelongsToEditor is
   false for any event whose path crosses a widget that ignores events, and
   every keymap in this app is a domEventHandler — so this handler IS the whole
   contract. listIndentKeymap's Tab, closeBrackets, mathEditingExtensions,
   formatKeymap AND historyKeymap are all simply not running in here. Anything
   not listed falls through to the browser, which is what makes ordinary typing,
   ⌘X/⌘C/⌘V and text selection work natively and need no permission. */
function onCellKeyDown(view: EditorView, dom: HTMLElement, event: KeyboardEvent): void {
    const current = session;
    const targetCell = (event.target as HTMLElement | null)?.closest('.cm-table-cell') ?? null;
    if (!current || current.dom !== dom || targetCell !== current.cell) return;
    const cell = current.cell;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod) {
        // ⌘Z has to be bound explicitly for the same reason Tab does: the
        // history keymap is outside the widget, so an unbound ⌘Z would reach
        // only the browser's per-element contenteditable undo stack, which
        // knows nothing about the transactions this module dispatched.
        if (key === 'z' || key === 'y') {
            event.preventDefault();
            endCellEdit();
            if (key === 'y' || event.shiftKey) redo(view); else undo(view);
            view.focus();
            return;
        }
        if (key === 'a') {
            // The cell's contents, not the document's.
            event.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(cell);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return;
        }
        if (key === 'b' || key === 'i') {
            // plaintext-only makes the browser's formatBold a no-op anyway, and
            // formatKeymap's own Mod-b never reaches in here. Bold in a cell is
            // typed `**like this**`.
            event.preventDefault();
            return;
        }
        // ⌘X / ⌘C / ⌘V and everything else: the browser's, natively.
        return;
    }

    const selection = window.getSelection();
    const collapsed = selection ? selection.isCollapsed : true;
    const offset = caretOffset(cell);
    const length = (cell.textContent ?? '').length;
    const shape = shapeOf(dom);

    switch (event.key) {
        case 'Tab':
            event.preventDefault();
            stepCell(view, dom, current.row, current.col, event.shiftKey ? -1 : 1);
            return;
        case 'Enter':
            event.preventDefault();
            if (event.shiftKey) {
                // GFM's only in-cell line break, and already in the cell
                // allowlist — so it is inserted as the literal text `<br>`.
                insertTextAtCaret(cell, '<br>');
                writeBack();
                return;
            }
            if (shape && current.row + 1 >= shape.rows) {
                // From the last row, Enter appends one and lands in it — in the
                // same column, which is where the reader's eye already is.
                const from = locate(view, dom)?.from;
                if (from === undefined || !insertRow(view, dom, shape.rows - 1)) return;
                const next = tableDomAt(view, from);
                if (next) focusTableCell(next, shape.rows, current.col, 'end');
                return;
            }
            focusTableCell(dom, current.row + 1, current.col, 'end');
            return;
        case 'Escape':
            // preventDefault AND stopPropagation: this menu-free surface sits
            // inside CodeMirror, which binds Escape too.
            event.preventDefault();
            event.stopPropagation();
            leaveTable(view, dom, 'to');
            return;
        case 'ArrowLeft':
            if (!collapsed || offset > 0) return;
            event.preventDefault();
            if (current.col > 0) focusTableCell(dom, current.row, current.col - 1, 'end');
            else if (current.row > 0 && shape) focusTableCell(dom, current.row - 1, shape.columns - 1, 'end');
            else leaveTable(view, dom, 'from');
            return;
        case 'ArrowRight':
            if (!collapsed || offset < length) return;
            event.preventDefault();
            if (shape && current.col + 1 < shape.columns) focusTableCell(dom, current.row, current.col + 1, 'start');
            else if (shape && current.row + 1 < shape.rows) focusTableCell(dom, current.row + 1, 0, 'start');
            else leaveTable(view, dom, 'to');
            return;
        case 'ArrowUp':
            event.preventDefault();
            if (current.row > 0) focusTableCell(dom, current.row - 1, current.col, 'end');
            else leaveTable(view, dom, 'from');
            return;
        case 'ArrowDown':
            event.preventDefault();
            if (shape && current.row + 1 < shape.rows) focusTableCell(dom, current.row + 1, current.col, 'end');
            else leaveTable(view, dom, 'to');
            return;
        default:
    }
}

/* ── The cell's own context menu ─────────────────────────────────────────── */

/**
 * Replace a run of one cell's RAW text and write it back.
 *
 * The menu's Cut and Paste act on the cell, not on the document's selection,
 * and they have to: focusin parks the document selection at the table's start,
 * so reusing the editor menu's clipboard actions here would copy nothing and
 * paste the clipboard into the document immediately BEFORE the table.
 *
 * The offsets are captured when the menu is built rather than read when the row
 * is clicked, because by then the menu has taken focus and the cell's own DOM
 * selection is gone.
 */
function replaceInCell(
    view: EditorView, dom: HTMLElement, row: number, col: number,
    from: number, to: number, insert: string,
): void {
    if (!canWrite(view)) return;
    let layout = locate(view, dom);
    if (!layout) return;
    // A cell the row is too short to have has no span to replace. writeBack
    // widens the row before its first write; without the same treatment here,
    // Paste on a padded cell would be a dead menu row — the clipboard read has
    // already succeeded and nothing would happen and nothing would say why.
    if (col >= (layout.rows[row]?.cells.length ?? 0)) {
        layout = widenRow(view, dom, layout, row);
        if (!layout) return;
    }
    const span = layout.rows[row]?.cells[col];
    if (!span) return;
    const current = view.state.sliceDoc(span.from, span.to);
    const start = Math.max(0, Math.min(current.length, from));
    const end = Math.max(start, Math.min(current.length, to));
    // Trimmed for the same reason writeBack's is: the span excludes the
    // padding, so pasting text with an edge space would add one to the file.
    // And guarded against a trailing backslash after that trim, for the reason
    // writeBack's is — a pasted line break becomes a trailing space here
    // (tableMenuEntries' Paste collapses it), which is exactly the shape that
    // hid an odd backslash run from a guard applied before the trim.
    const trimmed = escapeNewPipes(current.slice(0, start) + insert + current.slice(end)).text.trim();
    const text = span.to === layout.rows[row].pipes[col + 1]
        ? protectTrailingBackslash(trimmed)
        : trimmed;
    if (text !== current) {
        endCellEdit();
        view.dispatch({ changes: { from: span.from, to: span.to, insert: text }, userEvent: 'input' });
    }
    const target = tableDomAt(view, layout.from);
    const cell = target ? cellElement(target, row, col) : null;
    if (!cell) return;
    cell.focus({ preventScroll: true });
    placeCaret(cell, start + insert.length);
    if (session && session.cell === cell) session.offset = start + insert.length;
}

export function tableMenuEntries(view: EditorView, target: HTMLElement): ContextMenuEntry[] | null {
    // Reading mode has no table menu of its own — the event falls through to
    // the editor's, which is where Copy and Select all still make sense.
    if (!canWrite(view)) return null;
    const cell = target.closest('.cm-table-cell') as HTMLElement | null;
    const dom = cell?.closest('.cm-table-widget') as HTMLElement | null;
    if (!cell || !dom) return null;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const shape = shapeOf(dom);
    if (!Number.isInteger(row) || !Number.isInteger(col) || !shape) return null;

    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const inCell = !!range && cell.contains(range.startContainer) && cell.contains(range.endContainer);
    const start = inCell ? offsetOf(cell, range.startContainer, range.startOffset) : caretOffset(cell);
    const end = inCell ? offsetOf(cell, range.endContainer, range.endOffset) : start;
    const picked = inCell && !range.collapsed ? range.toString() : '';

    const lastBodyRow = shape.rows <= 2;
    const oneColumn = shape.columns <= 1;

    return [
        {
            kind: 'command', id: 'cut', label: 'Cut',
            disabled: picked.length === 0, reason: 'Nothing is selected in this cell.',
            run: async () => {
                // Only once the write RESOLVES: a refused clipboard must never
                // also destroy the text it failed to take.
                if (await copyText(picked)) replaceInCell(view, dom, row, col, start, end, '');
                else notify(CLIPBOARD_WRITE_BLOCKED);
            },
        },
        {
            kind: 'command', id: 'copy', label: 'Copy',
            disabled: picked.length === 0, reason: 'Nothing is selected in this cell.',
            run: async () => { if (!await copyText(picked)) notify(CLIPBOARD_WRITE_BLOCKED); },
        },
        {
            kind: 'command', id: 'paste', label: 'Paste',
            run: async () => {
                const read = await readClipboardText();
                if (!read.ok) { notify(CLIPBOARD_READ_BLOCKED); return; }
                // A cell is one line.
                replaceInCell(view, dom, row, col, start, end, read.text.replace(/\s*\r?\n\s*/g, ' '));
            },
        },
        { kind: 'separator', id: 'sep-structure' },
        {
            kind: 'command', id: 'row-above', label: 'Insert row above',
            disabled: row === 0, reason: "A table's first row is its header.",
            run: () => { insertRow(view, dom, row - 1); },
        },
        {
            kind: 'command', id: 'row-below', label: 'Insert row below',
            run: () => { insertRow(view, dom, row); },
        },
        {
            kind: 'command', id: 'col-left', label: 'Insert column left',
            run: () => { insertColumn(view, dom, col - 1); },
        },
        {
            kind: 'command', id: 'col-right', label: 'Insert column right',
            run: () => { insertColumn(view, dom, col); },
        },
        { kind: 'separator', id: 'sep-delete' },
        {
            kind: 'command', id: 'row-delete', label: 'Delete row',
            disabled: row === 0 || lastBodyRow,
            reason: row === 0
                ? "A table's first row is its header."
                : 'A table needs at least one row — use Delete table.',
            run: () => { deleteRow(view, dom, row); },
        },
        {
            kind: 'command', id: 'col-delete', label: 'Delete column',
            disabled: oneColumn, reason: 'A table needs at least one column — use Delete table.',
            run: () => { deleteColumn(view, dom, col); },
        },
        {
            kind: 'command', id: 'table-delete', label: 'Delete table', danger: true,
            run: () => { deleteTable(view, dom); },
        },
    ];
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */

/* Delegated on the CONTAINER, never per cell: a shape change replaces every
   cell element but never the container, so per-cell listeners would have to be
   re-hung on every row insertion. Each handler reads data-row/data-col off the
   event's target, so nothing closes over the widget instance that built the
   DOM — which is the rule that has to hold, because that instance is replaced
   on every keystroke. */
const wired = new WeakSet<HTMLElement>();

export function attachCellEditing(view: EditorView, dom: HTMLElement): void {
    // Idempotent: updateDOM re-runs this after a shape rebuild, and the
    // container it is called with is the same element every time.
    if (wired.has(dom)) return;
    wired.add(dom);

    dom.addEventListener('mousedown', (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('.cm-table-cell') || target?.closest('.cm-table-control')) return;
        // A press on the widget's chrome must not put a caret in it.
        event.preventDefault();
    }, true);

    dom.addEventListener('focusin', (event) => {
        const cell = (event.target as HTMLElement | null)?.closest('.cm-table-cell') as HTMLElement | null;
        if (!cell || !dom.contains(cell)) return;
        if (session && session.cell === cell) return;
        if (session) endCellEdit();
        beginCellEdit(view, dom, cell);
    });

    dom.addEventListener('focusout', () => {
        // Deferred, and that is required rather than defensive: a write-back
        // blurs the cell to BODY before the repair refocuses it, so an eager
        // check would end the session on every keystroke.
        setTimeout(() => {
            if (!session || session.dom !== dom) return;
            const active = document.activeElement;
            if (active && dom.contains(active)) return;
            endCellEdit();
        }, 0);
    });

    dom.addEventListener('input', (event) => {
        if ((event as InputEvent).isComposing) return;
        writeBack();
    });

    dom.addEventListener('compositionend', () => { writeBack(); });

    dom.addEventListener('beforeinput', (event) => {
        const type = (event as InputEvent).inputType;
        // A cell is one line and holds no formatting of its own.
        if (type === 'insertParagraph' || type === 'insertLineBreak' || type.startsWith('format')) {
            event.preventDefault();
        }
    });

    dom.addEventListener('paste', (event) => {
        const current = session;
        if (!current || current.dom !== dom) return;
        // Two independent guards against markup entering a cell: this, and
        // contenteditable="plaintext-only".
        event.preventDefault();
        const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
        insertTextAtCaret(current.cell, text.replace(/\s*\r?\n\s*/g, ' '));
        writeBack();
    });

    dom.addEventListener('dragstart', (event) => {
        // A "move" drag out of a cell mutates DOM CodeMirror deliberately
        // ignores, so the cell and the document would silently disagree.
        event.preventDefault();
    });

    // An uncancelled drop target navigates the whole app away to the dropped
    // file, so both halves are cancelled and the drop does nothing.
    dom.addEventListener('dragover', (event) => { event.preventDefault(); });
    dom.addEventListener('drop', (event) => { event.preventDefault(); });

    dom.addEventListener('contextmenu', (event) => {
        const target = event.target as HTMLElement | null;
        const cell = target?.closest('.cm-table-cell') as HTMLElement | null;
        if (!cell) return;                       // the chrome: let the editor's menu have it
        // Chromium puts the caret where the right-click landed, but only if the
        // cell takes focus — and the clipboard rows are built from the cell's
        // own selection, so a session has to be live by the time they are.
        if (document.activeElement !== cell) cell.focus({ preventScroll: true });
        const entries = tableMenuEntries(view, cell);
        if (!entries) return;
        event.preventDefault();
        // Otherwise this would also reach .view-content and raise the editor's
        // menu on top of the table's.
        event.stopPropagation();
        openContextMenu({
            x: event.clientX,
            y: event.clientY,
            // "<noun> actions" — the form every raiser uses, so a screen
            // reader hears one shape of name whichever surface was clicked
            // (File actions, Folder actions, Vault actions, Note actions).
            label: 'Table actions',
            opener: document.activeElement as HTMLElement | null,
            entries,
        });
    });

    dom.addEventListener('keydown', (event) => { onCellKeyDown(view, dom, event); });
}
