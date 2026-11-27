import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { openContextMenu } from '../utils/contextMenu';
import type { ContextMenuEntry } from '../utils/contextMenu';
// Every write below asks canWrite first: neither half of Reading mode blocks a
// programmatic dispatch, so an unguarded one would really edit a table in a
// note that is only being read (readingMode.ts).
import { canWrite } from './readingMode';
import {
    CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED, copyText, readClipboardText,
} from '../utils/clipboard';
import {
    blankRowText, blankTableText, delimiterCellText, escapeNewPipes, parseTableLayout,
    protectTrailingBackslash, tableLayoutAt,
} from './tableModel';
import type { ColumnAlign, RowSpan, TableLayout } from './tableModel';
// A deliberate cycle: tableWidget imports this module's session functions and
// this module imports its two DOM readers back. It exists so that "leaving a
// cell re-renders it" — an HTML path — stays in tableWidget beside the CELL_HTML
// allowlist, rather than a SECOND innerHTML sink being opened here. The rule
// that keeps it safe: neither side may touch the other's exports at MODULE
// EVALUATION time. Every use on both sides is inside a function body, and it
// must stay that way.
import { restoreRenderedCell, tableModelOf } from './tableWidget';

interface Session {
    dom: HTMLElement;
    view: EditorView;
    cell: HTMLElement;
    row: number;
    col: number;
    expected: string;
    offset: number;
}
let session: Session | null = null;

export function activeCellSession(): { dom: HTMLElement; expected: string } | null {
    return session ? { dom: session.dom, expected: session.expected } : null;
}

let notify: (message: string) => void = (message) => { console.warn(message); };

export function setTableNotify(next: (message: string) => void): void {
    notify = next;
}

function locate(view: EditorView, dom: HTMLElement): TableLayout | null {
    let pos: number;
    try {
        pos = view.posAtDOM(dom);
    } catch {
        return null;
    }
    return parseTableLayout(view.state.doc, pos);
}

function shapeOf(dom: HTMLElement): { rows: number; columns: number } | null {
    const model = tableModelOf(dom);
    return model ? { rows: model.cellText.length, columns: model.columns } : null;
}

function cellElement(dom: HTMLElement, row: number, col: number): HTMLElement | null {
    return dom.querySelector(`.cm-table-cell[data-row="${row}"][data-col="${col}"]`);
}

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

function repairFocus(current: Session): void {
    if (document.activeElement === current.cell) return;
    if (!current.cell.isConnected) return;
    current.cell.focus({ preventScroll: true });
    placeCaret(current.cell, Math.min(current.offset, (current.cell.textContent ?? '').length));
}

function beginCellEdit(view: EditorView, dom: HTMLElement, cell: HTMLElement): void {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    const layout = locate(view, dom);
    if (!layout) return;

    const span = layout.rows[row]?.cells[col];
    const raw = span ? view.state.sliceDoc(span.from, span.to) : '';
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

function publishExpected(dom: HTMLElement, next: string): void {
    if (session && session.dom === dom) session.expected = next;
}

function writeBack(): void {
    const current = session;
    if (!current) return;
    const { view, cell } = current;

    const raw = cell.textContent ?? '';
    const { text, map } = escapeNewPipes(raw);
    let offset = caretOffset(cell);
    if (text !== raw) {
        cell.textContent = text;
        offset = map(offset);
        placeCaret(cell, offset);
    }
    current.offset = offset;

    let layout = locate(view, current.dom);
    if (!layout) return;
    if (!layout.rows[current.row]) return;

    if (current.col >= layout.rows[current.row].cells.length) {
        layout = widenRow(view, current.dom, layout, current.row);
        if (!layout) return;
        repairFocus(current);
        cell.removeAttribute('data-pad');
    }

    const span = layout.rows[current.row]?.cells[current.col];
    if (!span) return;

    const abutsPipe = span.to === layout.rows[current.row].pipes[current.col + 1];
    const trimmed = text.trim();
    const written = abutsPipe ? protectTrailingBackslash(trimmed) : trimmed;
    if (view.state.sliceDoc(span.from, span.to) === written) return;

    publishExpected(current.dom, sourceAfter(view, layout, [{ from: span.from, to: span.to, insert: written }]));
    view.dispatch({ changes: { from: span.from, to: span.to, insert: written }, userEvent: 'input.type' });
    repairFocus(current);
}

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

interface Edit { from: number; to?: number; insert?: string }

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

export function focusTableCell(
    dom: HTMLElement,
    row: number,
    col: number,
    where: 'start' | 'end' | { x: number },
): boolean {
    const cell = cellElement(dom, row, col);
    if (!cell) return false;
    cell.focus({ preventScroll: true });
    if (where === 'start') placeCaret(cell, 0);
    else if (where === 'end') placeCaret(cell, (cell.textContent ?? '').length);
    else placeCaretAtX(cell, where.x);
    if (session && session.cell === cell) session.offset = caretOffset(cell);
    return document.activeElement === cell;
}

function focusAfterEdit(view: EditorView, from: number, row: number, col: number): void {
    const dom = tableDomAt(view, from);
    if (dom) focusTableCell(dom, row, col, 'start');
}

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

function linesOf(layout: TableLayout): { span: RowSpan; delimiter: boolean }[] {
    return [
        { span: layout.rows[0], delimiter: false },
        { span: layout.delimiter, delimiter: true },
        ...layout.rows.slice(1).map(span => ({ span, delimiter: false })),
    ];
}

export function insertRow(view: EditorView, dom: HTMLElement, afterRow: number): boolean {
    if (!canWrite(view.state)) return false;
    if (afterRow < 0) return false;
    const layout = locate(view, dom);
    if (!layout || afterRow >= layout.rows.length) return false;

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
    if (!canWrite(view.state)) return false;
    const layout = locate(view, dom);
    if (!layout) return false;
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
    if (!canWrite(view.state)) return false;
    const layout = locate(view, dom);
    if (!layout || afterCol < -1 || afterCol >= layout.columns) return false;

    const delimiterCell = ` ${delimiterCellText(null)} |`;
    const changes: Edit[] = linesOf(layout).map(({ span, delimiter }) => {
        const cell = delimiter ? delimiterCell : '  |';
        if (afterCol + 1 < span.pipes.length) {
            return { from: span.pipes[afterCol + 1] + 1, insert: cell };
        }
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
    if (!canWrite(view.state)) return false;
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

export function moveRow(view: EditorView, dom: HTMLElement, row: number, delta: -1 | 1): boolean {
    if (!canWrite(view.state)) return false;
    const layout = locate(view, dom);
    const target = row + delta;
    if (!layout || row < 1 || target < 1 || row >= layout.rows.length || target >= layout.rows.length) return false;

    const upper = layout.rows[Math.min(row, target)];
    const lower = layout.rows[Math.max(row, target)];
    const upperText = view.state.sliceDoc(upper.from, upper.to);
    const lowerText = view.state.sliceDoc(lower.from, lower.to);
    const col = session && session.dom === dom ? session.col : 0;
    endCellEdit();
    view.dispatch({
        changes: [
            { from: upper.from, to: upper.to, insert: lowerText },
            { from: lower.from, to: lower.to, insert: upperText },
        ],
        userEvent: 'input',
    });
    focusAfterEdit(view, layout.from, target, col);
    return true;
}

export function moveColumn(view: EditorView, dom: HTMLElement, col: number, delta: -1 | 1): boolean {
    if (!canWrite(view.state)) return false;
    const layout = locate(view, dom);
    const target = col + delta;
    if (!layout || col < 0 || target < 0 || col >= layout.columns || target >= layout.columns) return false;

    const left = Math.min(col, target);
    const changes: Edit[] = [];
    for (const { span, delimiter } of linesOf(layout)) {
        const present = span.pipes.length - 1;
        const segment = (i: number) => ({ from: span.pipes[i] + 1, to: span.pipes[i + 1] });
        if (left + 1 < present) {
            const a = segment(left);
            const b = segment(left + 1);
            changes.push({ from: a.from, to: a.to, insert: view.state.sliceDoc(b.from, b.to) });
            changes.push({ from: b.from, to: b.to, insert: view.state.sliceDoc(a.from, a.to) });
        } else if (left < present) {
            const a = segment(left);
            // An empty DELIMITER cell is not a delimiter: that row would stop
            // matching and the whole table would fall back to text.
            changes.push({ from: a.from, to: a.to, insert: delimiter ? ` ${delimiterCellText(null)} ` : '  ' });
            changes.push({ from: a.to + 1, insert: view.state.sliceDoc(a.from, a.to) + '|' });
        }
    }
    if (changes.length === 0) return false;

    const row = session && session.dom === dom ? session.row : 0;
    endCellEdit();
    view.dispatch({ changes, userEvent: 'input' });
    focusAfterEdit(view, layout.from, row, target);
    return true;
}

export function setColumnAlign(view: EditorView, dom: HTMLElement, col: number, align: ColumnAlign): boolean {
    if (!canWrite(view.state)) return false;
    const layout = locate(view, dom);
    if (!layout || col < 0 || col >= layout.columns) return false;

    const { delimiter } = layout;
    const text = delimiterCellText(align);
    const present = delimiter.pipes.length - 1;
    const change: Edit = col < present
        ? { from: delimiter.cells[col].from, to: delimiter.cells[col].to, insert: text }
        : {
            from: delimiter.pipes[present] + 1,
            insert: ` ${delimiterCellText(null)} |`.repeat(col - present) + ` ${text} |`,
        };

    const row = session && session.dom === dom ? session.row : 0;
    endCellEdit();
    view.dispatch({ changes: change, userEvent: 'input' });
    focusAfterEdit(view, layout.from, row, col);
    return true;
}

export function deleteTable(view: EditorView, dom: HTMLElement): boolean {
    if (!canWrite(view.state)) return false;
    const layout = locate(view, dom);
    if (!layout) return false;

    let from = layout.from;
    let to = layout.to;
    if (to < view.state.doc.length) to += 1;
    else if (from > 0) from -= 1;

    endCellEdit();
    view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from }, userEvent: 'delete' });
    view.focus();
    return true;
}

export function insertTableAtCursor(view: EditorView, rows: number, cols: number): boolean {
    if (!canWrite(view.state)) return false;
    const head = view.state.selection.main.head;
    const under = tableLayoutAt(view.state.doc, head);
    const line = view.state.doc.lineAt(under ? under.to : head);
    const body = blankTableText(rows, cols);

    const onBlankLine = line.text.trim().length === 0;
    const lead = onBlankLine && line.number > 1
        && view.state.doc.line(line.number - 1).text.trim().length > 0 ? '\n' : '';
    const from = onBlankLine ? line.from : line.to;
    const insert = onBlankLine ? lead + body + '\n' : '\n\n' + body + '\n';
    const tableFrom = from + (onBlankLine ? lead.length : 2);

    view.dispatch({ changes: { from, insert }, userEvent: 'input' });
    const dom = tableDomAt(view, tableFrom);
    if (dom) focusTableCell(dom, 0, 0, 'start');
    return true;
}

function stepCell(view: EditorView, dom: HTMLElement, row: number, col: number, delta: 1 | -1): void {
    const shape = shapeOf(dom);
    if (!shape) return;
    let nextRow = row;
    let nextCol = col + delta;
    if (nextCol >= shape.columns) { nextCol = 0; nextRow += 1; }
    if (nextCol < 0) { nextCol = shape.columns - 1; nextRow -= 1; }
    if (nextRow < 0) return;
    if (nextRow >= shape.rows) {
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

function onCellKeyDown(view: EditorView, dom: HTMLElement, event: KeyboardEvent): void {
    const current = session;
    const targetCell = (event.target as HTMLElement | null)?.closest('.cm-table-cell') ?? null;
    if (!current || current.dom !== dom || targetCell !== current.cell) return;
    const cell = current.cell;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod) {
        if (key === 'z' || key === 'y') {
            event.preventDefault();
            endCellEdit();
            if (key === 'y' || event.shiftKey) redo(view); else undo(view);
            view.focus();
            return;
        }
        if (key === 'a') {
            event.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(cell);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return;
        }
        if (key === 'b' || key === 'i') {
            event.preventDefault();
            return;
        }
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
                insertTextAtCaret(cell, '<br>');
                writeBack();
                return;
            }
            if (shape && current.row + 1 >= shape.rows) {
                const from = locate(view, dom)?.from;
                if (from === undefined || !insertRow(view, dom, shape.rows - 1)) return;
                const next = tableDomAt(view, from);
                if (next) focusTableCell(next, shape.rows, current.col, 'end');
                return;
            }
            focusTableCell(dom, current.row + 1, current.col, 'end');
            return;
        case 'Escape':
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
            if (event.altKey) { moveRow(view, dom, current.row, -1); return; }
            if (current.row > 0) focusTableCell(dom, current.row - 1, current.col, 'end');
            else leaveTable(view, dom, 'from');
            return;
        case 'ArrowDown':
            event.preventDefault();
            if (event.altKey) { moveRow(view, dom, current.row, 1); return; }
            if (shape && current.row + 1 < shape.rows) focusTableCell(dom, current.row + 1, current.col, 'end');
            else leaveTable(view, dom, 'to');
            return;
        default:
    }
}

function replaceInCell(
    view: EditorView, dom: HTMLElement, row: number, col: number,
    from: number, to: number, insert: string,
): void {
    if (!canWrite(view.state)) return;
    let layout = locate(view, dom);
    if (!layout) return;
    if (col >= (layout.rows[row]?.cells.length ?? 0)) {
        layout = widenRow(view, dom, layout, row);
        if (!layout) return;
    }
    const span = layout.rows[row]?.cells[col];
    if (!span) return;
    const current = view.state.sliceDoc(span.from, span.to);
    const start = Math.max(0, Math.min(current.length, from));
    const end = Math.max(start, Math.min(current.length, to));
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
    if (!canWrite(view.state)) return null;
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

const HEADER_REASON = "A table's first row is its header.";

function command(id: string, label: string, run: () => void, blocked: string | false = false, danger = false): ContextMenuEntry {
    return {
        kind: 'command', id, label, run, danger,
        disabled: blocked !== false,
        reason: blocked === false ? undefined : blocked,
    };
}

export function rowMenuEntries(view: EditorView, dom: HTMLElement, row: number): ContextMenuEntry[] {
    const rows = shapeOf(dom)?.rows ?? 0;
    const header = row === 0;
    return [
        command('row-above', 'Insert row above', () => { insertRow(view, dom, row - 1); }, header && HEADER_REASON),
        command('row-below', 'Insert row below', () => { insertRow(view, dom, row); }),
        { kind: 'separator', id: 'sep-move' },
        command('row-up', 'Move row up', () => { moveRow(view, dom, row, -1); },
            header ? HEADER_REASON : row <= 1 && 'This is already the first row under the header.'),
        command('row-down', 'Move row down', () => { moveRow(view, dom, row, 1); },
            header ? HEADER_REASON : row >= rows - 1 && 'This is already the last row.'),
        { kind: 'separator', id: 'sep-delete' },
        command('row-delete', 'Delete row', () => { deleteRow(view, dom, row); },
            header ? HEADER_REASON : rows <= 2 && 'A table needs at least one row. Use Delete table.'),
        command('table-delete', 'Delete table', () => { deleteTable(view, dom); }, false, true),
    ];
}

export function columnMenuEntries(view: EditorView, dom: HTMLElement, col: number): ContextMenuEntry[] {
    const columns = shapeOf(dom)?.columns ?? 0;
    const current = locate(view, dom)?.align[col] ?? 'left';
    const align = (value: 'left' | 'center' | 'right', label: string) => command(
        `align-${value}`, label, () => { setColumnAlign(view, dom, col, value); },
        current === value && `This column is already ${value === 'center' ? 'centred' : `${value}-aligned`}.`,
    );
    return [
        command('col-left', 'Insert column left', () => { insertColumn(view, dom, col - 1); }),
        command('col-right', 'Insert column right', () => { insertColumn(view, dom, col); }),
        { kind: 'separator', id: 'sep-move' },
        command('col-move-left', 'Move column left', () => { moveColumn(view, dom, col, -1); },
            col <= 0 && 'This is already the first column.'),
        command('col-move-right', 'Move column right', () => { moveColumn(view, dom, col, 1); },
            col >= columns - 1 && 'This is already the last column.'),
        { kind: 'separator', id: 'sep-align' },
        align('left', 'Align left'),
        align('center', 'Align centre'),
        align('right', 'Align right'),
        { kind: 'separator', id: 'sep-delete' },
        command('col-delete', 'Delete column', () => { deleteColumn(view, dom, col); },
            columns <= 1 && 'A table needs at least one column. Use Delete table.'),
        command('table-delete', 'Delete table', () => { deleteTable(view, dom); }, false, true),
    ];
}

const wired = new WeakSet<HTMLElement>();

export function attachCellEditing(view: EditorView, dom: HTMLElement): void {
    if (wired.has(dom)) return;
    wired.add(dom);

    dom.addEventListener('mousedown', (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('.cm-table-cell') || target?.closest('.cm-table-control')) return;
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
        if (type === 'insertParagraph' || type === 'insertLineBreak' || type.startsWith('format')) {
            event.preventDefault();
        }
    });

    dom.addEventListener('paste', (event) => {
        const current = session;
        if (!current || current.dom !== dom) return;
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
        if (!cell) return;
        if (document.activeElement !== cell) cell.focus({ preventScroll: true });
        const entries = tableMenuEntries(view, cell);
        if (!entries) return;
        event.preventDefault();
        event.stopPropagation();
        openContextMenu({
            x: event.clientX,
            y: event.clientY,
            label: 'Table actions',
            opener: document.activeElement as HTMLElement | null,
            entries,
        });
    });

    dom.addEventListener('keydown', (event) => { onCellKeyDown(view, dom, event); });
}
