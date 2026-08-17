import type { Text } from '@codemirror/state';

/* ── One definition of a markdown table's geometry ────────────────────────
 *
 * A rendered table is an OBJECT the reader edits in place (see tableWidget.ts
 * and tableEdit.ts), so three different questions have to be answered about
 * the same pipe markdown and they must never disagree:
 *
 *   · which spans of the document are tables at all (livePreview's decoration
 *     pass, which also makes each one ATOMIC — so a span it decorates and the
 *     widget cannot build editable cells for would be the user's own text with
 *     no way to put a caret in it);
 *   · where every cell of one begins and ends IN THE DOCUMENT, so an edit can
 *     replace the narrowest span that actually changed;
 *   · what each cell should render as.
 *
 * All three live here, DOM-free and EditorView-free, so they are one piece of
 * code with one escape loop rather than three that drift. The escape loop is
 * the one tableWidget's parseRow used to hold, moved rather than copied: only
 * UNESCAPED pipes delimit, because `\|` is GFM's one way to put a pipe in a
 * cell and a row that splits on it silently gains a column.
 *
 * NOTHING here writes. The writers (tableEdit.ts) ask for spans and replace
 * them; no path in this app ever reconstructs a table the user already has, so
 * their padding, their alignment colons and their escaping survive an edit to
 * a neighbouring cell byte for byte.
 */

export type ColumnAlign = 'left' | 'center' | 'right' | null;

/** A FRESH regex per call — a shared /g regex carries lastIndex between callers
 *  (utils/assets.ts embedPattern carries the same note, and this one has three
 *  callers). Byte-identical to the inline regex livePreview.ts used to hold, so
 *  this change alters WHICH tables are decorated only through parseGrid's gate
 *  below, never through the scan itself. */
export function tablePattern(): RegExp {
    return /(^\|.+\|[ \t]*\n)(^\|[\s:|-]+\|[ \t]*\n)((?:^\|.+\|[ \t]*\n?)+)/gm;
}

/** TRIMMED inner text; `from === to` when the cell is empty. */
export interface CellSpan { from: number; to: number }

export interface RowSpan {
    /** The whole line, newline excluded. */
    from: number;
    to: number;
    /** Document offsets of every UNESCAPED `|`, ascending. */
    pipes: number[];
    /** One per segment ACTUALLY PRESENT — never padded. A short row therefore
     *  reads as short, which is what lets a writer tell "this cell is missing
     *  from the source" from "this cell is empty". */
    cells: CellSpan[];
}

export interface TableLayout {
    /** Exactly livePreview's [from, trimmedTo). */
    from: number;
    to: number;
    /** The HEADER row's cell count. */
    columns: number;
    /** rows[0] is the header; rows[1..] are body rows. The delimiter is NOT in
     *  here — it is never rendered and never edited, only preserved. */
    rows: RowSpan[];
    delimiter: RowSpan;
    /** Padded/truncated to `columns`. */
    align: ColumnAlign[];
}

/** The RENDER view of a source string: rows padded/sliced to `columns`, each
 *  cell carrying BOTH strings. Used by the widget and by tableFit; used by
 *  NOTHING that writes. */
export interface GridCell { raw: string; text: string }
export interface Grid {
    columns: number;
    align: ColumnAlign[];
    rows: { cells: GridCell[]; segments: number }[];
}

/* ── The escape loop, in one place ───────────────────────────────────────── */

/**
 * Offsets of every UNESCAPED `|` in one line, ascending.
 *
 * The character loop tableWidget's parseRow used to run, verbatim: a `\`
 * consumes the next character only when that character is `|` or `\`, so
 * `C:\path` passes through untouched (a `\p` is not an escape) while `\|` and
 * `\\` are. Segment i is (pipes[i], pipes[i+1]) — the outer pipes are simply
 * the first and last recorded offsets, so nothing is shifted or popped.
 */
function pipeOffsets(line: string): number[] {
    const pipes: number[] = [];
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) { i++; continue; }
        if (ch === '|') pipes.push(i);
    }
    return pipes;
}

/**
 * Resolve `\|` and `\\` — the exact inverse of what a writer escapes.
 *
 * Trimming before this rather than after is safe and is what lets a cell's raw
 * span be trimmed once: an escape only ever yields `|` or `\`, never
 * whitespace, so trim-then-unescape and unescape-then-trim cannot differ.
 */
function unescapeCell(raw: string): string {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '\\' && (raw[i + 1] === '|' || raw[i + 1] === '\\')) { out += raw[++i]; continue; }
        out += ch;
    }
    return out;
}

/**
 * The trimmed segments of one line, as [start, end) offsets WITHIN it.
 *
 * An EMPTY cell collapses to a single position, and where that position sits
 * decides what the user's file looks like after they type in one: one space
 * inside the opening pipe, so `|  |` becomes `| X |` rather than `|X  |` or
 * `|  X|`. The padding either side of a cell is the writer's to leave alone,
 * so this is the only say it gets in the matter.
 */
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

/** The `| --- | :-: |` row that separates the header from the body. Exactly
 *  tableWidget's old isSeparator, over the shared loop. */
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

/** `align`, padded or truncated to `columns` with nulls. */
function alignRow(line: string, columns: number): ColumnAlign[] {
    const spans = segmentsOf(line, pipeOffsets(line));
    const align: ColumnAlign[] = [];
    for (let i = 0; i < columns; i++) {
        align.push(i < spans.length ? alignOf(line.slice(spans[i].from, spans[i].to)) : null);
    }
    return align;
}

/**
 * Split a table's source into lines and locate its delimiter row.
 *
 * Returns null unless the delimiter is line 1 EXACTLY. The regex guarantees
 * that for anything it matched, so this rejects nothing legitimate — but
 * isSeparatorLine also accepts a bare `-`, so a table whose HEADER row is
 * `| - | - |`, or one carrying a duplicated delimiter row (an ordinary editing
 * accident), would otherwise be read as having no header at all. Such a span is
 * simply not decorated, which leaves the markdown as ordinary editable text
 * rather than as an atomic, never-revealed block with no cell in it.
 */
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

/**
 * Every RENDERABLE table in a flattened document, left to right, non-overlapping.
 *
 * A span is returned only if `parseGrid` accepts it. This is load-bearing, not
 * tidiness: the caller pushes an atomic, never-revealed Decoration.replace for
 * every span it gets back, so a span the widget cannot build editable cells for
 * would become a block of the user's own text with no way to put a caret in it.
 */
export function findTables(doc: string): { from: number; to: number }[] {
    const pattern = tablePattern();
    const spans: { from: number; to: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(doc)) !== null) {
        const from = match.index;
        const end = from + match[0].length;
        // The trailing newline stays OUT of the replaced range, exactly as the
        // table branch has always computed it.
        const to = doc[end - 1] === '\n' ? end - 1 : end;
        if (!parseGrid(doc.slice(from, to))) continue;
        spans.push({ from, to });
    }
    return spans;
}

/**
 * The table whose first line begins at `from`, or null.
 *
 * The slice handed to the regex is bounded by walking forward over pipe-fenced
 * lines rather than by running an unbounded scan from `from` to the end of the
 * document — this is called on every keystroke in a cell.
 */
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

    // Line starts, in document offsets. Walking the split rather than asking
    // the Text again keeps the two descriptions of the table in step.
    let offset = from;
    const spans: RowSpan[] = lines.map(text => {
        const lineFrom = offset;
        offset += text.length + 1;      // the '\n' the split consumed
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

/**
 * The table containing or starting at `pos`, or null.
 *
 * Scans the contiguous run of pipe-fenced lines `pos` sits in with the same
 * findTables gate the decoration pass uses, so this can never report a table
 * the reader is not looking at — nor miss one that begins part-way down a run
 * (`| a note |` followed by a real table underneath it is exactly that shape).
 */
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

/**
 * Which cell a document position falls in — RENDERED indices, so `row` counts
 * the header as 0 and skips the delimiter.
 *
 * Deliberately TOTAL over the table's range: a position on the delimiter row
 * answers with the header row above it, and a position in a surplus segment of
 * a ragged row (or in the trailing whitespace past the closing pipe) is clamped
 * to the last rendered column. The caller is the caret-adoption rule, and the
 * one thing it must never do is leave a caret inside an atomic, never-revealed
 * range with nowhere to go.
 */
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

/* ── The one transformation applied on the way back into the document ────── */

/**
 * Escape a `|` that is NOT already escaped and collapse [\r\n\t]+ to one space.
 * Idempotent, and a no-op on untouched text — which is what makes focusing a
 * cell and clicking away again a byte-identical round trip. `map(o)` carries an
 * offset in the input to its offset in the output, so a caret survives an escape
 * it caused.
 *
 * The rule that is easy to get wrong and silently destructive if you do: a `|`
 * is already escaped **iff the run of `\` immediately before it has ODD
 * length**. Not /(?<!\\)\|/: the parse above consumes `\\` as one literal
 * backslash, so in `a \\| b` the `|` IS a delimiter, a lookbehind would leave it
 * alone, and the cell would split in two on write-back — the row silently gains
 * a column.
 *
 * What this deliberately does NOT do is guard a TRAILING backslash; that is
 * protectTrailingBackslash below, and the separation is load-bearing in both
 * directions. See its comment.
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
            // A whole run collapses to one space: a cell is one line, and a
            // pasted line break would otherwise end the row mid-table.
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

/**
 * Double a TRAILING backslash run of ODD length, so it cannot escape whatever
 * follows the span it is written into.
 *
 * Kept out of escapeNewPipes, and applied by the writers to the string that
 * actually lands in the DOCUMENT — after the trim, and only when the cell's span
 * really does abut the row's closing pipe. Both halves of that are load-bearing,
 * and each was got wrong once:
 *
 * · AFTER the trim, because a cell's span excludes the padding either side of it
 *   and the writers therefore trim before writing. Doubling before the trim
 *   inspects whitespace the document never sees: `escapeNewPipes('cmd \ ').text`
 *   ends in a space, so the run is not trailing and nothing is doubled — and
 *   then `.trim()` hands the document `cmd \`, which escapes the row's own
 *   closing pipe. Measured on an unpadded `|a|b|`: the header line became
 *   `|a|cmd \|` and parseGrid dropped the table from 2 columns to 1, taking the
 *   whole second column off the screen.
 *
 * · ONLY WHEN NEEDED, because the escaped text is also what the focused cell
 *   shows, and this transformation is idempotent — so a cell it is applied to
 *   unconditionally becomes a FIXED POINT. Measured: typing `\` into a cell left
 *   `\\`, and every Backspace after it was undone by the re-escape on the next
 *   input event, so the backslash could not be deleted at all. A padded cell
 *   (`| b |`, which is what blankRowText, insertColumn and widenRow all produce)
 *   is followed by a space, where `\ ` is not an escape and no doubling is
 *   required; only an unpadded cell, whose span ends exactly at the closing
 *   pipe, needs it.
 *
 * This is the ONLY place a backslash is ever rewritten — blanket doubling would
 * turn `C:\path` into `C:\\path` in the user's file.
 */
export function protectTrailingBackslash(text: string): string {
    let trailing = 0;
    for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i--) trailing++;
    return trailing % 2 === 1 ? text + '\\' : text;
}

/* ── Builders, used ONLY to create something that did not exist before ───── */

/** '|  |  |' style, two spaces per cell. */
export function blankRowText(columns: number): string {
    return '|' + '  |'.repeat(Math.max(1, columns));
}

/** '---' | ':---' | ':---:' | '---:' */
export function delimiterCellText(align: ColumnAlign): string {
    if (align === 'center') return ':---:';
    if (align === 'left') return ':---';
    if (align === 'right') return '---:';
    return '---';
}

/** `rows` INCLUDES the header, clamped >= 2 — GFM cannot express a table with
 *  no body row, and one that stops matching the pattern stops being a table. */
export function blankTableText(rows: number, cols: number): string {
    const columns = Math.max(1, cols);
    const lines = [blankRowText(columns), '|' + ` ${delimiterCellText(null)} |`.repeat(columns)];
    for (let i = 1; i < Math.max(2, rows); i++) lines.push(blankRowText(columns));
    return lines.join('\n');
}
