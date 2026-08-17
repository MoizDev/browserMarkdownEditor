import { WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { createFitProbes, observeTableFit, rekeyTableFit, releaseTableFit, retuneTableFit } from './tableFit';
import { parseGrid } from './tableModel';
import type { ColumnAlign, Grid } from './tableModel';
import { activeCellSession, attachCellEditing, endCellEdit, insertColumn, insertRow } from './tableEdit';

/* ── A rendered table is an OBJECT with an inside ─────────────────────────
 *
 * Like an embedded image (imageWidget.ts), a table is never revealed by the
 * cursor and its range is atomic — but unlike a picture it has parts, so the
 * object model goes one level further: each <th>/<td> is a
 * contenteditable="plaintext-only" ISLAND, and every keystroke in one writes
 * the narrowest possible markdown change back through view.dispatch. The file
 * on disk still holds ordinary GFM pipe markdown; this is a layer over it, not
 * a new document format.
 *
 * CodeMirror deliberately stands back from a widget's internals, and this rests
 * on four facts of the pinned 6.39.15 source rather than on luck:
 *   · readMutation discards every DOM mutation inside a widget (:7329-7332),
 *   · onSelectionChange ignores a selection inside one (:7092-7105),
 *   · updateSelection never moves the DOM selection while focus is not on the
 *     contentDOM (:2994-3002),
 *   · eventBelongsToEditor is false for any event whose path crosses a widget
 *     that ignores events (:4775-4785), so NO keymap fires inside a cell.
 * The last one is why tableEdit.ts has to bind Tab, the arrows, Escape and even
 * ⌘Z itself: inside a cell this app's whole keymap stack is simply not running.
 *
 * ignoreEvent() is therefore NOT overridden. Keeping CodeMirror's default
 * (true) is what buys all four.
 */

/* ── What a cell may contain ──
   A table cell is the only place in this app where note text reaches the DOM
   as HTML rather than as text. That is what makes `<br>` — the only way to get
   a line break inside a cell — work at all, and left unrestricted it equally
   lets a note run script in the app's origin. This origin is not an ordinary
   one: it holds the vault's directory handle in IndexedDB with permission
   already granted, so a note carrying `<img src=x onerror=…>` would get
   read/write over every file in the vault the moment it was opened, silently
   and with no prompt. Notes arrive from elsewhere all the time — cloned,
   downloaded, synced from a shared folder — so that is a live path, not a
   theoretical one.

   Hence: everything is escaped except a fixed set of tags that take NO
   attributes, and those are re-emitted from this pattern's own alternation
   rather than copied out of the input. So no untrusted markup is ever parsed,
   and no attribute is ever emitted — which is the property that makes this
   safe to read at a glance, and the one to preserve if the list is extended.
   `<a href>` and `<img src>` need attributes and are deliberately absent; they
   render as the text they were written as.

   Editable cells do not widen this by one character. The text handed to
   renderInlineMarkdown is the same unescaped cell text it has always been
   given; the ONLY other way anything reaches a cell is textContent, which is a
   text node and can never be markup; and a paste into a cell is intercepted
   and re-inserted as plain text on top of plaintext-only's own guarantee. */
const CELL_HTML = /<(\/?)(br|b|i|u|s|em|strong|code|kbd|mark|small|sub|sup)\s*\/?>/gi;

/** `<` and `>` only: an entity can't open a tag, so leaving `&` alone keeps a
 *  cell that spells out `&lt;br&gt;` showing what it meant to show. */
function escapeText(text: string): string {
    return text.replace(/[<>]/g, ch => (ch === '<' ? '&lt;' : '&gt;'));
}

/**
 * Minimal inline markdown for cell contents: bold, italic, bold+italic, code —
 * over text that has been escaped down to the allowlist above.
 */
function renderInlineMarkdown(text: string): string {
    let html = '';
    let last = 0;
    let tag: RegExpExecArray | null;
    CELL_HTML.lastIndex = 0;
    while ((tag = CELL_HTML.exec(text)) !== null) {
        html += escapeText(text.slice(last, tag.index)) + `<${tag[1]}${tag[2].toLowerCase()}>`;
        last = tag.index + tag[0].length;
    }
    html += escapeText(text.slice(last));

    return html
        // Bold+Italic: ***text***
        .replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>')
        // Bold: **text** or __text__
        .replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>')
        .replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>')
        // Italic: *text* or _text_
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        // Inline code: `text`
        .replace(/`(.+?)`/g, '<code>$1</code>');
}

/**
 * The live state of one rendered table, hanging off its DOM.
 *
 * The DOM outlives the widget INSTANCE that built it — CodeMirror hands an
 * existing element to a later widget's updateDOM rather than rebuilding it —
 * so nothing attached to this element may close over the widget that happened
 * to create it. The delegated listeners read data-row/data-col off the event's
 * target and this model off the container, exactly as the image widget's
 * buttons read ImageModel.
 */
export interface TableModel {
    /** The markdown this DOM was last dressed from. */
    source: string;
    canEdit: boolean;
    columns: number;
    /** The UNESCAPED text each rendered cell was built from, so a re-dress can
     *  touch only the cells that really changed. */
    cellText: string[][];
    view: EditorView;
    table: HTMLTableElement;
    cols: HTMLTableColElement[];
}

const MODEL = Symbol('tableModel');
type TableDom = HTMLElement & { [MODEL]?: TableModel };

/** The model hanging off a rendered table, if this element is one of ours. */
export function tableModelOf(dom: HTMLElement): TableModel | null {
    return (dom as TableDom)[MODEL] ?? null;
}

function alignClass(align: ColumnAlign): string {
    if (align === 'center') return ' cm-table-align-center';
    if (align === 'right') return ' cm-table-align-right';
    return '';                                  // left is the stylesheet's default
}

/**
 * Everything about one cell except its contents: which cell it is, how it is
 * aligned, whether it can be typed in, and whether the source actually backs it.
 *
 * `data-pad` marks a cell the row is too short to have — a body row with fewer
 * segments than the header, which GFM renders as empty. It is editable like any
 * other; the flag exists only so the first write into it knows to widen the line
 * first. Deriving it needs no document position: parseGrid reports how many
 * segments each line really has, which is all toDOM has to work from.
 */
function dressCell(cell: HTMLTableCellElement, grid: Grid, row: number, col: number, canEdit: boolean): void {
    cell.className = 'cm-table-cell' + alignClass(grid.align[col]);
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    if (col >= grid.rows[row].segments) cell.dataset.pad = '';
    else cell.removeAttribute('data-pad');
    if (canEdit) cell.contentEditable = 'plaintext-only';
    else cell.removeAttribute('contenteditable');
}

function buildRow(grid: Grid, row: number, tag: 'th' | 'td', canEdit: boolean): HTMLTableRowElement {
    const tr = document.createElement('tr');
    for (let col = 0; col < grid.columns; col++) {
        const cell = document.createElement(tag);
        dressCell(cell, grid, row, col, canEdit);
        cell.innerHTML = renderInlineMarkdown(grid.rows[row].cells[col].text);
        tr.appendChild(cell);
    }
    return tr;
}

/** Build (or rebuild in place) the colgroup, head and body of one table. */
function buildTable(table: HTMLTableElement, grid: Grid, canEdit: boolean): HTMLTableColElement[] {
    table.textContent = '';

    // One <col> per column: the fitter writes each column's share of the width
    // here, so the table needs no per-cell styling to be laid out.
    const colgroup = document.createElement('colgroup');
    const cols: HTMLTableColElement[] = [];
    for (let i = 0; i < grid.columns; i++) {
        const col = document.createElement('col');
        cols.push(col);
        colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    thead.appendChild(buildRow(grid, 0, 'th', canEdit));
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let row = 1; row < grid.rows.length; row++) tbody.appendChild(buildRow(grid, row, 'td', canEdit));
    table.appendChild(tbody);

    return cols;
}

function cellTextOf(grid: Grid): string[][] {
    return grid.rows.map(row => row.cells.map(cell => cell.text));
}

/**
 * Put a cell's RENDERED contents back, from the source the model last saw.
 *
 * This is the "leaving a cell" HTML path, and it is here rather than in
 * tableEdit so that every route from note text to innerHTML goes through the
 * one allowlist above. It reads the text out of the current source rather than
 * out of model.cellText, because a write-back deliberately leaves cellText
 * stale for the cell being typed in (updateDOM must not touch a cell holding
 * the caret).
 */
export function restoreRenderedCell(dom: HTMLElement, cell: HTMLElement): void {
    const model = tableModelOf(dom);
    if (!model || !cell.isConnected) return;
    const grid = parseGrid(model.source);
    if (!grid) return;
    model.cellText = cellTextOf(grid);
    model.columns = grid.columns;

    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    if (row >= grid.rows.length || col >= grid.columns) return;
    dressCell(cell as HTMLTableCellElement, grid, row, col, model.canEdit);
    cell.innerHTML = renderInlineMarkdown(grid.rows[row].cells[col].text);
}

/** The two corner chips, in the shape imageWidget's toolButton established. */
function controlButton(cls: string, title: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    // The base class is what carries `pointer-events: auto`; the layer they sit
    // in is `none`, so a button given only its modifier is an unclickable div.
    button.className = `cm-table-control ${cls}`;
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    // Never a tab stop: these live inside the document's contenteditable, where
    // tabbing to them would interrupt the note's own Tab handling — and inside
    // a table Tab is bound to walking the cells.
    button.tabIndex = -1;
    button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
    });
    return button;
}

/**
 * Parses a raw markdown table string and renders it as an editable HTML <table>.
 *
 * The rendered table is kept FITTED to the note's text width (see
 * editor/tableFit.ts): its columns are sized from their measured content
 * rather than by the browser's proportional squeeze, and the whole table
 * shrinks when they cannot all be satisfied.
 */
export class TableWidget extends WidgetType {
    /**
     * NEVER call this field `editable`. WidgetType.prototype carries an
     * undocumented `get editable() { return false }` (@codemirror/view:177)
     * that is absent from the .d.ts. Measured, twice: a `readonly editable`
     * constructor parameter property — the exact idiom ImageWidget uses —
     * THROWS "Cannot set property editable of #<Base> which has only a getter"
     * on the first render, with a completely clean typecheck; and a plain field
     * declaration instead silently shadows the getter, which stops CodeMirror
     * marking the widget root contenteditable="false" (:2129-2135) and lets the
     * editor try to put a caret in the table's chrome.
     */
    constructor(
        readonly rawTable: string,
        readonly canEdit: boolean,
        /** The document selection is exactly this table — the "you are acting
         *  on this object" state a Backspace beside it produces. Carried per
         *  widget, not merely as one flag on the editor, because the ring has
         *  to say WHICH table: a note with two tables would otherwise outline
         *  both. ImageWidget carries `selected` for the same reason. */
        readonly selected: boolean,
    ) {
        super();
    }

    eq(other: TableWidget): boolean {
        return other.rawTable === this.rawTable
            && other.canEdit === this.canEdit
            && other.selected === this.selected;
    }

    toDOM(view: EditorView): HTMLElement {
        const container = document.createElement('div') as TableDom;
        container.className = 'cm-table-widget';

        const grid = parseGrid(this.rawTable);
        if (!grid) {
            // Nothing parseable — show the source. The class restores the
            // line breaks that .cm-table-widget's `white-space: normal` would
            // otherwise collapse into one run-on line.
            //
            // Unreachable from the live preview, which only decorates spans
            // parseGrid accepts, and kept as the honest answer for a widget
            // built from a source that somehow does not parse. Such a widget
            // must never be given an atomic range: a never-revealed atomic
            // block with no cell in it is text the reader cannot reach at all.
            container.classList.add('cm-table-raw');
            container.textContent = this.rawTable;
            return container;
        }

        // The sensors the fitter watches — zero-height, never painted. The
        // width probe must stay a DIRECT first child of the container: its
        // width IS the available text width, which is the fit's input.
        const { probe, fontProbe } = createFitProbes();
        container.appendChild(probe);

        // The table sits inside its own scroller rather than in the container,
        // because an overflow container clips in BOTH axes and would cut the
        // corner chips off.
        const scroll = document.createElement('div');
        scroll.className = 'cm-table-scroll';
        const table = document.createElement('table');
        const cols = buildTable(table, grid, this.canEdit);
        scroll.appendChild(table);
        container.appendChild(scroll);

        if (this.canEdit) container.appendChild(buildControls(view, container));
        container.classList.toggle('cm-table-selected', this.selected);

        container[MODEL] = {
            source: this.rawTable,
            canEdit: this.canEdit,
            columns: grid.columns,
            cellText: cellTextOf(grid),
            view,
            table,
            cols,
        };
        attachCellEditing(view, container);

        observeTableFit({
            key: this.rawTable, view, container, widthProbe: probe, fontProbe, table, cols,
            lastAvail: -1, lastFont: -1, lastBreaks: '', fitted: false,
        });

        return container;
    }

    /**
     * Re-dress an existing table instead of building a new one.
     *
     * Rebuilding is not merely wasteful here, it is destructive: the caret
     * usually lives in a text node of one of these cells, and a fresh <td>
     * takes it with it. So the common case — the write-back this very edit
     * session just dispatched — touches nothing at all.
     *
     * NOTHING reachable from here may dispatch. updateDOM is called from
     * findWidget inside DocView.update, where EditorView.update throws
     * (@codemirror/view:7810, measured); that is why the re-fit is scheduled
     * for the next frame rather than run here.
     */
    updateDOM(dom: HTMLElement, view: EditorView): boolean {
        const model = tableModelOf(dom);
        if (!model) return false;                       // not one of ours — let CodeMirror rebuild
        const grid = parseGrid(this.rawTable);
        if (!grid) return false;                        // let it build the raw fallback instead

        const session = activeCellSession();
        const ours = session !== null && session.dom === dom;

        // findWidget's second pass offers ANY same-class tile's DOM to ANY
        // widget of that class, so a second table on screen could otherwise
        // adopt the very element the caret is sitting in. Refuse it to any
        // widget whose text is not the one this edit just wrote, and CodeMirror
        // moves on to find its own DOM. Note the shape of the guard: it is on
        // `session.dom === dom`, never on `!==`. Refusing every dom that is not
        // the session's would refuse a widget its OWN pooled element and send
        // it through destroy() + toDOM() — which is the tear-out this guard
        // exists to prevent.
        if (ours && this.rawTable !== session.expected) return false;

        // A class on the container, so it cannot disturb a caret inside a cell
        // — and it never fires mid-edit anyway: a session parks an EMPTY
        // document selection at the table's start, so `selected` (which needs
        // the selection to be exactly the table's span) is false throughout one.
        dom.classList.toggle('cm-table-selected', this.selected);

        if (ours && this.canEdit === model.canEdit) {
            // Our own write-back. The caret is in one of these cells and the
            // DOM already shows what was typed. Only the fit's memo key
            // follows — emphatically NOT the fit itself, which would move the
            // columns under the user's hands mid-word.
            model.source = this.rawTable;
            model.view = view;
            rekeyTableFit(dom, this.rawTable);
            return true;
        }
        // ⌘E flipped the mode under a live edit: the cells are about to stop
        // being editable, so the session has to end before they are re-dressed.
        if (ours) endCellEdit();

        if (model.source === this.rawTable && model.canEdit === this.canEdit) return true;

        const shapeChanged = grid.columns !== model.columns
            || grid.rows.length !== model.cellText.length
            || this.canEdit !== model.canEdit;

        if (shapeChanged) {
            const cols = buildTable(model.table, grid, this.canEdit);
            model.cols = cols;
            const controls = dom.querySelector('.cm-table-controls');
            if (this.canEdit && !controls) dom.appendChild(buildControls(view, dom));
            if (!this.canEdit && controls) controls.remove();
            attachCellEditing(view, dom);
            retuneTableFit(dom, this.rawTable, { table: model.table, cols });
        } else {
            const rows = [model.table.tHead?.rows[0], ...Array.from(model.table.tBodies[0]?.rows ?? [])];
            for (let row = 0; row < grid.rows.length; row++) {
                const tr = rows[row];
                if (!tr) continue;
                for (let col = 0; col < grid.columns; col++) {
                    const cell = tr.cells[col];
                    if (!cell) continue;
                    dressCell(cell, grid, row, col, this.canEdit);
                    if (model.cellText[row]?.[col] === grid.rows[row].cells[col].text) continue;
                    cell.innerHTML = renderInlineMarkdown(grid.rows[row].cells[col].text);
                }
            }
            retuneTableFit(dom, this.rawTable);
        }

        model.source = this.rawTable;
        model.canEdit = this.canEdit;
        model.columns = grid.columns;
        model.cellText = cellTextOf(grid);
        model.view = view;
        return true;
    }

    destroy(dom: HTMLElement): void {
        // Nothing to flush — every keystroke was already written through to the
        // document — but a session pointing at DOM that is going away must not
        // outlive it. Like updateDOM, this runs inside a CodeMirror update, so
        // nothing reachable from here may dispatch.
        if (activeCellSession()?.dom === dom) endCellEdit();
        releaseTableFit(dom);
    }
}

/**
 * The overlay layer holding the two corner chips.
 *
 * Each press reads the table's CURRENT shape off the model rather than
 * remembering one, for the same reason every action in tableEdit re-locates the
 * table in the current document: this element outlives the widget that built
 * it, and a row or column count captured at build time goes stale on the very
 * first press.
 */
function buildControls(view: EditorView, container: HTMLElement): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'cm-table-controls';
    controls.appendChild(controlButton('cm-table-add-col', 'Add column', () => {
        const model = tableModelOf(container);
        if (model) insertColumn(view, container, model.columns - 1);
    }));
    controls.appendChild(controlButton('cm-table-add-row', 'Add row', () => {
        const model = tableModelOf(container);
        if (model) insertRow(view, container, model.cellText.length - 1);
    }));
    return controls;
}
