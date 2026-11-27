import type { Text } from '@codemirror/state';

export type ColumnAlign = 'left' | 'center' | 'right' | null;

export function tablePattern(): RegExp {
    return /(^\|.+\|[ \t]*\n)(^\|[\s:|-]+\|[ \t]*\n)((?:^\|.+\|[ \t]*\n?)+)/gm;
}

export interface CellSpan { from: number; to: number }

export interface RowSpan {
    from: number;
    to: number;
    pipes: number[];
    cells: CellSpan[];
}

export interface TableLayout {
    from: number;
    to: number;
    columns: number;
    rows: RowSpan[];
    delimiter: RowSpan;
    align: ColumnAlign[];
}

export interface GridCell { raw: string; text: string }
export interface Grid {
    columns: number;
    align: ColumnAlign[];
    rows: { cells: GridCell[]; segments: number }[];
}

function pipeOffsets(line: string): number[] {
    const pipes: number[] = [];
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) { i++; continue; }
        if (ch === '|') pipes.push(i);
    }
    return pipes;
}

function unescapeCell(raw: string): string {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '\\' && (raw[i + 1] === '|' || raw[i + 1] === '\\')) { out += raw[++i]; continue; }
        out += ch;
    }
    return out;
}

function segmentsOf(line: string, pipes: number[]): { from: number; to: number }[] {
    const spans: { from: number; to: number }[] = [];
    for (let i = 0; i + 1 < pipes.length; i++) {
        const start = pipes[i] + 1;
        const end = pipes[i + 1];
        let from = start;
        let to = end;
        while (from < to && /\s/.test(line[from])) from++;
        while (to > from && /\s/.test(line[to - 1])) to--;
        if (from === to && end > start) { from = start + 1; to = from; }
        spans.push({ from, to });
    }
    return spans;
}

function isSeparatorLine(line: string): boolean {
    const pipes = pipeOffsets(line);
    const spans = segmentsOf(line, pipes);
    if (spans.length === 0) return false;
    return spans.every(s => /^:?-{1,}:?$/.test(line.slice(s.from, s.to)));
}

function alignOf(cell: string): ColumnAlign {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return null;
}

function alignRow(line: string, columns: number): ColumnAlign[] {
    const spans = segmentsOf(line, pipeOffsets(line));
    const align: ColumnAlign[] = [];
    for (let i = 0; i < columns; i++) {
        align.push(i < spans.length ? alignOf(line.slice(spans[i].from, spans[i].to)) : null);
    }
    return align;
}

function splitTable(source: string): string[] | null {
    const lines = source.split('\n');
    if (lines.length < 3) return null;
    let delimiter = -1;
    for (let i = 0; i < lines.length; i++) {
        if (isSeparatorLine(lines[i])) { delimiter = i; break; }
    }
    if (delimiter !== 1) return null;
    return lines;
}

export function parseGrid(source: string): Grid | null {
    const lines = splitTable(source);
    if (!lines) return null;

    const rowLines = [lines[0], ...lines.slice(2)];
    const rowSegments = rowLines.map(line => segmentsOf(line, pipeOffsets(line)));
    const columns = rowSegments[0].length;
    if (!columns) return null;

    const rows = rowLines.map((line, r) => {
        const spans = rowSegments[r];
        const cells: GridCell[] = [];
        for (let c = 0; c < columns; c++) {
            if (c < spans.length) {
                const raw = line.slice(spans[c].from, spans[c].to);
                cells.push({ raw, text: unescapeCell(raw) });
            } else {
                cells.push({ raw: '', text: '' });
            }
        }
        return { cells, segments: spans.length };
    });

    return { columns, align: alignRow(lines[1], columns), rows };
}

export function findTables(doc: string): { from: number; to: number }[] {
    const pattern = tablePattern();
    const spans: { from: number; to: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(doc)) !== null) {
        const from = match.index;
        const end = from + match[0].length;
        const to = doc[end - 1] === '\n' ? end - 1 : end;
        if (!parseGrid(doc.slice(from, to))) continue;
        spans.push({ from, to });
    }
    return spans;
}

export function parseTableLayout(doc: Text, from: number): TableLayout | null {
    const first = doc.lineAt(from);
    if (first.from !== from || !first.text.startsWith('|')) return null;

    let last = first;
    for (let n = first.number + 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        if (!line.text.startsWith('|') || !line.text.trimEnd().endsWith('|')) break;
        last = line;
    }

    const slice = doc.sliceString(from, last.to);
    const match = tablePattern().exec(slice);
    if (!match || match.index !== 0) return null;

    const end = from + match[0].length;
    const to = doc.sliceString(end - 1, end) === '\n' ? end - 1 : end;

    const lines = splitTable(slice.slice(0, to - from));
    if (!lines) return null;

    let offset = from;
    const spans: RowSpan[] = lines.map(text => {
        const lineFrom = offset;
        offset += text.length + 1;
        const local = pipeOffsets(text);
        return {
            from: lineFrom,
            to: lineFrom + text.length,
            pipes: local.map(p => lineFrom + p),
            cells: segmentsOf(text, local).map(s => ({ from: lineFrom + s.from, to: lineFrom + s.to })),
        };
    });

    const rows = [spans[0], ...spans.slice(2)];
    const columns = rows[0].cells.length;
    if (!columns) return null;

    return { from, to, columns, rows, delimiter: spans[1], align: alignRow(lines[1], columns) };
}

export function tableLayoutAt(doc: Text, pos: number): TableLayout | null {
    const here = doc.lineAt(pos);
    const fenced = (n: number): boolean => {
        const text = doc.line(n).text;
        return text.startsWith('|') && text.trimEnd().endsWith('|');
    };

    let firstLine = here.number;
    if (!fenced(firstLine)) return null;
    while (firstLine > 1 && fenced(firstLine - 1)) firstLine--;
    let lastLine = here.number;
    while (lastLine < doc.lines && fenced(lastLine + 1)) lastLine++;

    const runFrom = doc.line(firstLine).from;
    const text = doc.sliceString(runFrom, doc.line(lastLine).to);
    for (const span of findTables(text)) {
        const from = runFrom + span.from;
        const to = runFrom + span.to;
        if (pos >= from && pos <= to) return parseTableLayout(doc, from);
    }
    return null;
}

export function cellAt(layout: TableLayout, pos: number): { row: number; col: number } | null {
    if (pos < layout.from || pos > layout.to) return null;

    let row = -1;
    if (pos >= layout.delimiter.from && pos <= layout.delimiter.to) {
        row = 0;
    } else {
        for (let r = 0; r < layout.rows.length; r++) {
            if (pos >= layout.rows[r].from && pos <= layout.rows[r].to) { row = r; break; }
        }
    }
    if (row < 0) return null;

    const line = pos >= layout.delimiter.from && pos <= layout.delimiter.to
        ? layout.delimiter
        : layout.rows[row];
    let col = 0;
    for (let i = 0; i + 1 < line.pipes.length; i++) {
        if (pos > line.pipes[i]) col = i;
    }
    return { row, col: Math.min(col, layout.columns - 1) };
}

/**
 * The rule that is easy to get wrong and silently destructive if you do: a `|`
 * is already escaped **iff the run of `\` immediately before it has ODD
 * length**. Not /(?<!\\)\|/: the parse above consumes `\\` as one literal
 * backslash, so in `a \\| b` the `|` IS a delimiter, a lookbehind would leave it
 * alone, and the cell would split in two on write-back — the row silently gains
 * a column.
 */
export function escapeNewPipes(raw: string): { text: string; map: (offset: number) => number } {
    const map: number[] = new Array(raw.length + 1);
    let text = '';
    let backslashes = 0;
    for (let i = 0; i < raw.length; i++) {
        map[i] = text.length;
        const ch = raw[i];
        if (ch === '\\') { text += ch; backslashes++; continue; }
        if (ch === '|') {
            if (backslashes % 2 === 0) text += '\\';
            text += '|';
            backslashes = 0;
            continue;
        }
        if (ch === '\r' || ch === '\n' || ch === '\t') {
            text += ' ';
            while (i + 1 < raw.length && /[\r\n\t]/.test(raw[i + 1])) { i++; map[i] = text.length; }
            backslashes = 0;
            continue;
        }
        text += ch;
        backslashes = 0;
    }
    map[raw.length] = text.length;

    return {
        text,
        map: (offset: number) => map[Math.max(0, Math.min(raw.length, offset))],
    };
}

export function protectTrailingBackslash(text: string): string {
    let trailing = 0;
    for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i--) trailing++;
    return trailing % 2 === 1 ? text + '\\' : text;
}

export function blankRowText(columns: number): string {
    return '|' + '  |'.repeat(Math.max(1, columns));
}

export function delimiterCellText(align: ColumnAlign): string {
    if (align === 'center') return ':---:';
    if (align === 'left') return ':---';
    if (align === 'right') return '---:';
    return '---';
}

export function blankTableText(rows: number, cols: number): string {
    const columns = Math.max(1, cols);
    const lines = [blankRowText(columns), '|' + ` ${delimiterCellText(null)} |`.repeat(columns)];
    for (let i = 1; i < Math.max(2, rows); i++) lines.push(blankRowText(columns));
    return lines.join('\n');
}

export function rowColumnCount(line: string): number {
    const text = line.trimEnd();
    if (text.length < 3 || !text.startsWith('|') || !text.endsWith('|')) return 0;
    const pipes = pipeOffsets(text);
    if (pipes[pipes.length - 1] !== text.length - 1) return 0;
    return Math.max(0, pipes.length - 1);
}
