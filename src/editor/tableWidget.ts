import { WidgetType } from '@codemirror/view';
import { countEditorWidget } from './editorPerf';
import type { EditorView } from '@codemirror/view';
import { preserveTableReadingSelection, queueTableReadingSelection } from './tableReadingSelection';
import { createFitProbes, observeTableFit, rekeyTableFit, releaseTableFit, retuneTableFit } from './tableFit';
import { parseGrid } from './tableModel';
import type { ColumnAlign, Grid } from './tableModel';
import { activeCellSession, attachCellEditing, columnMenuEntries, endCellEdit, insertColumn, insertRow, rowMenuEntries } from './tableEdit';
import { closeContextMenu, openContextMenu } from '../utils/contextMenu';
import { findMathRegions } from './latexSource';
import type { MathRegion } from './latexSource';
import { renderMath } from './mathWidget';
import { emphasisRanges } from '../utils/readingEmphasis';
import type { Utf16Range } from '../utils/readingEmphasis';
import type { ReadingEmphasisOptions } from './readingEmphasisConfig';

const CELL_HTML = /<(\/?)(br|b|i|u|s|em|strong|code|kbd|mark|small|sub|sup)\s*\/?>/gi;

function escapeText(text: string): string {
    return text.replace(/[<>]/g, ch => (ch === '<' ? '&lt;' : '&gt;'));
}

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
        .replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>')
        .replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>')
        .replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
}

const SLOT_OPEN = '\uE000';   // Private Use Area, written here as an ESCAPE and never
const SLOT_CLOSE = '\uE001';  // as a literal character. Nothing a note can mean uses
                              // these, and they are stripped from the cell text below.
const MATH_SLOT = /\uE000(\d+)\uE001|[\uE000\uE001]/;

const CELL_PARSER = document.createElement('div');

function inlineCodeRanges(text: string): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    const re = /`(.+?)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ from: m.index, to: m.index + m[0].length });
    return out;
}

function renderCellContent(cell: HTMLElement, text: string, emphasis?: ReadingEmphasisOptions): void {
    const clean = text.replace(/[\uE000\uE001]/g, '');
    const regions = findMathRegions(clean, inlineCodeRanges(clean));

    let masked = clean;
    if (regions.length) {
        masked = '';
        let last = 0;
        for (let i = 0; i < regions.length; i++) {
            masked += clean.slice(last, regions[i].from) + SLOT_OPEN + i + SLOT_CLOSE;
            last = regions[i].to;
        }
        masked += clean.slice(last);
    }

    CELL_PARSER.innerHTML = renderInlineMarkdown(masked);   // ← the allowlist's one sink
    if (regions.length || clean.includes('&')) fillMathSlots(CELL_PARSER, regions);
    cell.textContent = '';
    while (CELL_PARSER.firstChild) cell.appendChild(CELL_PARSER.firstChild);
    if (regions.length) cell.scrollLeft = 0;
    if (emphasis?.enabled && emphasis.mode === 'read' && cell.tagName !== 'TH') emphasizeCell(cell, emphasis.locale);
}

function emphasizeCell(cell: HTMLElement, locale: string): void {
    interface Holder { node: Text; from: number; to: number }
    let text = '', holders: Holder[] = [], exclusions: Utf16Range[] = [];
    const runs: { text: string; holders: Holder[]; exclusions: Utf16Range[] }[] = [];
    const flush = () => {
        if (text) runs.push({ text, holders, exclusions });
        text = ''; holders = []; exclusions = [];
    };
    function walk(node: Node, strong: boolean): void {
        if (node.nodeType === Node.TEXT_NODE) {
            const from = text.length;
            text += node.nodeValue ?? '';
            holders.push({ node: node as Text, from, to: text.length });
            if (strong) exclusions.push({ from, to: text.length });
        } else if (node instanceof Element) {
            if (node.matches('br, code, kbd, math, svg, ruby, sub, sup, .cm-table-math')) { flush(); return; }
            const bold = strong || node.matches('b, strong');
            for (const child of node.childNodes) walk(child, bold);
        }
    }
    walk(cell, false); flush();
    for (const run of runs) {
        const ranges = emphasisRanges({ text: run.text, exclusions: run.exclusions, locale });
        for (const holder of run.holders) {
            for (let i = ranges.length - 1; i >= 0; i--) {
                const from = Math.max(ranges[i].from, holder.from), to = Math.min(ranges[i].to, holder.to);
                if (from >= to) continue;
                const selected = holder.node.splitText(from - holder.from);
                selected.splitText(to - from);
                const span = document.createElement('span');
                span.className = 'cm-table-reading-prefix';
                selected.replaceWith(span); span.appendChild(selected);
            }
        }
    }
}

function fillMathSlots(root: Element, regions: MathRegion[]): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const holders: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const v = n.nodeValue;
        if (v && (v.includes(SLOT_OPEN) || v.includes(SLOT_CLOSE))) holders.push(n as Text);
    }
    const used = new Set<number>();
    for (const holder of holders) {
        let rest = holder;
        for (;;) {
            const m = MATH_SLOT.exec(rest.nodeValue ?? '');
            if (!m) break;
            const slot = rest.splitText(m.index);
            const tail = slot.splitText(m[0].length);
            // m[1] is undefined for a lone sentinel; an index naming no region,
            // or one already spent, is a forgery. Either way the token goes.
            const index = m[1] === undefined ? -1 : Number(m[1]);
            const region = used.has(index) ? undefined : regions[index];
            if (region) {
                used.add(index);
                const span = document.createElement('span');
                span.className = 'cm-table-math';
                span.setAttribute('role', 'math');
                span.setAttribute('aria-label', region.latex);
                renderMath(span, region.latex, false);
                slot.replaceWith(span);
            } else {
                slot.remove();
            }
            rest = tail;
        }
    }
}

export interface TableModel {
    source: string;
    canEdit: boolean;
    emphasis: ReadingEmphasisOptions;
    columns: number;
    cellText: string[][];
    view: EditorView;
    table: HTMLTableElement;
    cols: HTMLTableColElement[];
}

const MODEL = Symbol('tableModel');
type TableDom = HTMLElement & { [MODEL]?: TableModel };

export function tableModelOf(dom: HTMLElement): TableModel | null {
    return (dom as TableDom)[MODEL] ?? null;
}

function alignClass(align: ColumnAlign): string {
    if (align === 'center') return ' cm-table-align-center';
    if (align === 'right') return ' cm-table-align-right';
    return '';
}

function dressCell(cell: HTMLTableCellElement, grid: Grid, row: number, col: number, canEdit: boolean): void {
    cell.className = 'cm-table-cell' + alignClass(grid.align[col]);
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    if (col >= grid.rows[row].segments) cell.dataset.pad = '';
    else cell.removeAttribute('data-pad');
    if (canEdit) cell.contentEditable = 'plaintext-only';
    else cell.removeAttribute('contenteditable');
}

function buildRow(grid: Grid, row: number, tag: 'th' | 'td', canEdit: boolean, emphasis: ReadingEmphasisOptions): HTMLTableRowElement {
    const tr = document.createElement('tr');
    for (let col = 0; col < grid.columns; col++) {
        const cell = document.createElement(tag);
        dressCell(cell, grid, row, col, canEdit);
        renderCellContent(cell, grid.rows[row].cells[col].text, emphasis);
        tr.appendChild(cell);
    }
    return tr;
}

function buildTable(table: HTMLTableElement, grid: Grid, canEdit: boolean, emphasis: ReadingEmphasisOptions): HTMLTableColElement[] {
    table.textContent = '';

    const colgroup = document.createElement('colgroup');
    const cols: HTMLTableColElement[] = [];
    for (let i = 0; i < grid.columns; i++) {
        const col = document.createElement('col');
        cols.push(col);
        colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    thead.appendChild(buildRow(grid, 0, 'th', canEdit, emphasis));
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let row = 1; row < grid.rows.length; row++) tbody.appendChild(buildRow(grid, row, 'td', canEdit, emphasis));
    table.appendChild(tbody);

    return cols;
}

function cellTextOf(grid: Grid): string[][] {
    return grid.rows.map(row => row.cells.map(cell => cell.text));
}

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
    renderCellContent(cell, grid.rows[row].cells[col].text, model.emphasis);
}

function controlButton(cls: string, title: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `cm-table-control ${cls}`;
    button.type = 'button';
    button.dataset.tooltip = title;
    button.setAttribute('aria-label', title);
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

function emphasisKey(options: ReadingEmphasisOptions, canEdit: boolean): string {
    return !canEdit && options.enabled && options.mode === 'read' ? `latin-prefix-v1:${options.locale}` : 'off';
}

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
        readonly selected: boolean,
        readonly emphasis: ReadingEmphasisOptions = { enabled: false, mode: 'edit', locale: '' },
    ) {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
    }

    private effectiveEmphasis(): ReadingEmphasisOptions {
        return this.canEdit ? { ...this.emphasis, enabled: false } : this.emphasis;
    }
    private fitKey(): string { return this.rawTable + '\u0000' + emphasisKey(this.emphasis, this.canEdit); }

    eq(other: TableWidget): boolean {
        return other.rawTable === this.rawTable
            && other.canEdit === this.canEdit
            && other.selected === this.selected
            && emphasisKey(other.emphasis, other.canEdit) === emphasisKey(this.emphasis, this.canEdit);
    }

    toDOM(view: EditorView): HTMLElement {
        const container = document.createElement('div') as TableDom;
        container.className = 'cm-table-widget';

        const grid = parseGrid(this.rawTable);
        if (!grid) {
            container.classList.add('cm-table-raw');
            container.textContent = this.rawTable;
            return container;
        }

        const { probe, fontProbe, mathProbe } = createFitProbes();
        container.appendChild(probe);

        const scroll = document.createElement('div');
        scroll.className = 'cm-table-scroll';
        const table = document.createElement('table');
        const cols = buildTable(table, grid, this.canEdit, this.effectiveEmphasis());
        scroll.appendChild(table);
        container.appendChild(scroll);

        if (this.canEdit) container.appendChild(buildControls(view, container));
        container.classList.toggle('cm-table-selected', this.selected);

        container[MODEL] = {
            source: this.rawTable,
            canEdit: this.canEdit,
            emphasis: this.effectiveEmphasis(),
            columns: grid.columns,
            cellText: cellTextOf(grid),
            view,
            table,
            cols,
        };
        attachCellEditing(view, container);
        attachEdgeReveal(container);

        observeTableFit({
            key: this.fitKey(), view, container, widthProbe: probe, fontProbe, mathProbe, table, cols,
            lastAvail: -1, lastFont: -1, lastBreaks: '', fitted: false,
        });

        return container;
    }

    /**
     * NOTHING reachable from here may dispatch. updateDOM is called from
     * findWidget inside DocView.update, where EditorView.update throws
     * (@codemirror/view:7810, measured); that is why the re-fit is scheduled
     * for the next frame rather than run here.
     */
    updateDOM(dom: HTMLElement, view: EditorView): boolean {
        const model = tableModelOf(dom);
        if (!model) return false;
        const grid = parseGrid(this.rawTable);
        if (!grid) return false;

        const session = activeCellSession();
        const ours = session !== null && session.dom === dom;

        if (ours && this.rawTable !== session.expected) return false;

        dom.classList.toggle('cm-table-selected', this.selected);

        if (ours && this.canEdit === model.canEdit) {
            model.source = this.rawTable;
            model.view = view;
            rekeyTableFit(dom, this.fitKey());
            return true;
        }
        if (ours) endCellEdit();

        const styleChanged = emphasisKey(model.emphasis, model.canEdit) !== emphasisKey(this.emphasis, this.canEdit);
        if (model.source === this.rawTable && model.canEdit === this.canEdit && !styleChanged) return true;
        const restoreSelection = preserveTableReadingSelection(model.table, view);

        const shapeChanged = grid.columns !== model.columns
            || grid.rows.length !== model.cellText.length
            || this.canEdit !== model.canEdit;

        if (shapeChanged) {
            const cols = buildTable(model.table, grid, this.canEdit, this.effectiveEmphasis());
            model.cols = cols;
            const controls = dom.querySelector('.cm-table-controls');
            if (this.canEdit && !controls) dom.appendChild(buildControls(view, dom));
            if (!this.canEdit && controls) controls.remove();
            attachCellEditing(view, dom);
            retuneTableFit(dom, this.fitKey(), { table: model.table, cols });
        } else {
            const rows = [model.table.tHead?.rows[0], ...Array.from(model.table.tBodies[0]?.rows ?? [])];
            for (let row = 0; row < grid.rows.length; row++) {
                const tr = rows[row];
                if (!tr) continue;
                for (let col = 0; col < grid.columns; col++) {
                    const cell = tr.cells[col];
                    if (!cell) continue;
                    dressCell(cell, grid, row, col, this.canEdit);
                    if (!styleChanged && model.cellText[row]?.[col] === grid.rows[row].cells[col].text) continue;
                    renderCellContent(cell, grid.rows[row].cells[col].text, this.effectiveEmphasis());
                }
            }
            retuneTableFit(dom, this.fitKey());
        }

        model.source = this.rawTable;
        model.canEdit = this.canEdit;
        model.emphasis = this.effectiveEmphasis();
        if (restoreSelection) queueTableReadingSelection(view, restoreSelection);
        model.columns = grid.columns;
        model.cellText = cellTextOf(grid);
        model.view = view;
        return true;
    }

    destroy(dom: HTMLElement): void {
        if (activeCellSession()?.dom === dom) endCellEdit();
        releaseTableFit(dom);
    }
}

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
    controls.appendChild(gripButton(view, container, 'row'));
    controls.appendChild(gripButton(view, container, 'col'));
    return controls;
}

function gripButton(view: EditorView, container: HTMLElement, axis: 'row' | 'col'): HTMLButtonElement {
    const label = axis === 'row' ? 'Row options' : 'Column options';
    const button = document.createElement('button');
    button.className = `cm-table-grip cm-table-grip-${axis}`;
    button.type = 'button';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.tabIndex = -1;
    button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    let openFor: number | null = null;
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(button.dataset.index);
        if (!Number.isInteger(index) || !tableModelOf(container)?.canEdit) return;
        if (openFor !== null && openFor !== index) closeContextMenu();
        const box = button.getBoundingClientRect();
        const marked = Array.from(container.querySelectorAll<HTMLElement>(`.cm-table-cell[data-${axis}="${index}"]`));
        const opened = openContextMenu({
            x: box.left,
            y: box.bottom + 2,
            entries: axis === 'row' ? rowMenuEntries(view, container, index) : columnMenuEntries(view, container, index),
            label,
            opener: null,
            anchor: button,
            onClose: () => {
                openFor = null;
                for (const cell of marked) cell.classList.remove('cm-table-target');
                container.classList.remove('cm-table-grip-open');
            },
        });
        if (!opened) return;
        openFor = index;
        for (const cell of marked) cell.classList.add('cm-table-target');
        container.classList.add('cm-table-grip-open');
    });
    return button;
}

function placeGrips(container: HTMLElement, box: DOMRect, cell: HTMLElement | null): void {
    const rowGrip = container.querySelector<HTMLElement>('.cm-table-grip-row');
    const colGrip = container.querySelector<HTMLElement>('.cm-table-grip-col');
    const live = rowGrip && colGrip && cell?.isConnected && container.contains(cell) ? cell : null;
    container.classList.toggle('cm-table-near-cell', !!live);
    if (!live || !rowGrip || !colGrip) return;
    const cellBox = live.getBoundingClientRect();
    const rowBox = live.parentElement?.getBoundingClientRect() ?? cellBox;
    const tableTop = live.closest('table')?.getBoundingClientRect().top ?? box.top;
    rowGrip.dataset.index = live.dataset.row ?? '';
    colGrip.dataset.index = live.dataset.col ?? '';
    rowGrip.style.top = `${rowBox.top - box.top + rowBox.height / 2}px`;
    colGrip.style.left = `${cellBox.left - box.left + cellBox.width / 2}px`;
    colGrip.style.top = `${tableTop - box.top}px`;
}

const EDGE_BAND_PX = 48;

function attachEdgeReveal(container: HTMLElement): void {
    let frame = 0;
    let clientX = 0;
    let clientY = 0;
    let hovered: HTMLElement | null = null;
    let overGrip = false;

    const measure = () => {
        frame = 0;
        const rect = container.getBoundingClientRect();
        const inBox = clientX >= rect.left && clientX <= rect.right
            && clientY >= rect.top && clientY <= rect.bottom;
        container.classList.toggle('cm-table-near-right', inBox && rect.right - clientX <= EDGE_BAND_PX);
        container.classList.toggle('cm-table-near-bottom', inBox && rect.bottom - clientY <= EDGE_BAND_PX);
        placeGrips(container, rect, inBox || overGrip ? hovered : null);
    };

    container.addEventListener('pointermove', (event) => {
        if (!tableModelOf(container)?.canEdit) return;
        const target = event.target as HTMLElement | null;
        overGrip = !!target?.closest('.cm-table-grip');
        const cell = target?.closest('.cm-table-cell') as HTMLElement | null;
        if (cell && container.contains(cell)) hovered = cell;
        clientX = event.clientX;
        clientY = event.clientY;
        if (!frame) frame = requestAnimationFrame(measure);
    });

    container.addEventListener('pointerleave', () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        hovered = null;
        overGrip = false;
        container.classList.remove('cm-table-near-right', 'cm-table-near-bottom', 'cm-table-near-cell');
    });
}
