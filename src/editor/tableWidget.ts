import { WidgetType } from '@codemirror/view';
import { createFitProbes, observeTableFit, releaseTableFit } from './tableFit';

/** One parsed table: header rows, body rows, and the column count they share. */
interface TableGrid {
    header: string[][];
    body: string[][];
    columns: number;
}

/**
 * Split one `| a | b |` line into its cells, dropping the outer pipes' empties.
 *
 * Only UNESCAPED pipes delimit. `\|` is GFM's one way to put a pipe in a cell,
 * and it is needed everywhere — code spans included — so a row like
 * `` | `grep a \| wc` | count matches | `` really is two cells. Splitting on
 * every pipe made it three, which used to merely look wrong; now that rows are
 * truncated to the header's column count it would silently drop the last one.
 */
function parseRow(line: string): string[] {
    const cells: string[] = [];
    let cell = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        // A backslash escapes a pipe or another backslash. Either way the next
        // character is literal, so a pipe there stops being a delimiter.
        if (ch === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) {
            cell += line[++i];
            continue;
        }
        if (ch === '|') { cells.push(cell); cell = ''; continue; }
        cell += ch;
    }
    cells.push(cell);
    if (cells.length > 0 && cells[0].trim() === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
    return cells.map(c => c.trim());
}

/** The `| --- | :-: |` row that separates the header from the body. */
function isSeparator(line: string): boolean {
    const cells = parseRow(line);
    return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c));
}

/**
 * Parse the raw markdown into a RECTANGULAR grid.
 *
 * Rows are padded and truncated to the header's column count, the way GFM
 * specifies — which also keeps the table's own right edge straight, and lets
 * tableFit read every column's width off a single row.
 */
function parseTable(raw: string): TableGrid | null {
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 2) return null;

    const header: string[][] = [];
    const body: string[][] = [];
    let afterSeparator = false;
    for (const line of lines) {
        if (!afterSeparator && isSeparator(line)) { afterSeparator = true; continue; }
        (afterSeparator ? body : header).push(parseRow(line));
    }

    const rows = header.length ? header : body;
    const columns = rows.length ? rows[0].length : 0;
    if (!columns) return null;

    const rectangular = (row: string[]): string[] => row.length === columns
        ? row
        : row.length > columns
            ? row.slice(0, columns)
            : row.concat(new Array(columns - row.length).fill(''));

    return { header: header.map(rectangular), body: body.map(rectangular), columns };
}

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
   render as the text they were written as. */
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

function buildRow(cells: string[], tag: 'th' | 'td'): HTMLTableRowElement {
    const tr = document.createElement('tr');
    for (const text of cells) {
        const cell = document.createElement(tag);
        cell.innerHTML = renderInlineMarkdown(text);
        tr.appendChild(cell);
    }
    return tr;
}

/**
 * Parses a raw markdown table string and renders it as an HTML <table>.
 *
 * The rendered table is kept FITTED to the note's text width (see
 * editor/tableFit.ts): its columns are sized from their measured content
 * rather than by the browser's proportional squeeze, and the whole table
 * shrinks when they cannot all be satisfied.
 */
export class TableWidget extends WidgetType {
    rawTable: string;

    constructor(rawTable: string) {
        super();
        this.rawTable = rawTable;
    }

    eq(other: TableWidget): boolean {
        return other.rawTable === this.rawTable;
    }

    toDOM(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'cm-table-widget';

        const grid = parseTable(this.rawTable);
        if (!grid) {
            // Nothing parseable — show the source. The class restores the
            // line breaks that .cm-table-widget's `white-space: normal` would
            // otherwise collapse into one run-on line.
            container.classList.add('cm-table-raw');
            container.textContent = this.rawTable;
            return container;
        }

        const table = document.createElement('table');

        // One <col> per column: the fitter writes each column's share of the
        // width here, so the table needs no per-cell styling to be laid out.
        const colgroup = document.createElement('colgroup');
        const cols: HTMLTableColElement[] = [];
        for (let i = 0; i < grid.columns; i++) {
            const col = document.createElement('col');
            cols.push(col);
            colgroup.appendChild(col);
        }
        table.appendChild(colgroup);

        const thead = document.createElement('thead');
        for (const row of grid.header) thead.appendChild(buildRow(row, 'th'));
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of grid.body) tbody.appendChild(buildRow(row, 'td'));
        table.appendChild(tbody);

        // The sensors the fitter watches — zero-height, never painted.
        const { probe, fontProbe } = createFitProbes();
        container.appendChild(probe);
        container.appendChild(table);

        observeTableFit({
            container, widthProbe: probe, fontProbe, table, cols,
            lastAvail: -1, lastFont: -1, lastBreaks: '',
        });

        return container;
    }

    destroy(dom: HTMLElement): void {
        releaseTableFit(dom);
    }
}
