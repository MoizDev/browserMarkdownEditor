// Reading a LaTeX file, rather than staring at its source.
//
// WHAT THIS IS NOT: a TeX engine. Nothing here lays out a page, resolves a
// package, numbers a theorem or follows a \input — that is a compiler, and a
// compiler is not what a student opening `assignment.tex` in a notes app wants.
// What they want is to READ it: the sections as headings, the maths set, the
// lists as lists, the code verbatim.
//
// THE ONE RULE THE PARSER FOLLOWS: nothing in the file disappears. A command it
// has never heard of is shown as itself, muted, and its braces' contents are
// still read as text — so an unknown `\textcolor{red}{careful}` reads as
// "\textcolor careful" rather than silently losing the word. That is why there is
// no "unsupported" path and no allowlist to fall off: the worst case degrades to
// source, which is what the file is anyway.
//
// Pure, and React-free: it returns a tree, and components/TexView.tsx is what
// draws it. Split that way because the shape of a LaTeX document is worth
// testing by eye against real files, and because the parser must not drag KaTeX
// into anything that only wants to know what a file contains.

/** Inline runs inside a paragraph, a heading or a table cell. */
export type TexInline =
    | { kind: 'text'; text: string }
    | { kind: 'math'; tex: string }
    | { kind: 'styled'; style: 'bold' | 'italic' | 'mono' | 'underline'; spans: TexInline[] }
    /** A command this parser does not know, kept visible exactly as written. */
    | { kind: 'raw'; text: string }
    | { kind: 'break' };

export type TexBlock =
    | { kind: 'heading'; level: number; spans: TexInline[] }
    | { kind: 'para'; spans: TexInline[] }
    | { kind: 'math'; tex: string }
    | { kind: 'code'; text: string }
    | { kind: 'list'; ordered: boolean; items: TexBlock[][] }
    | { kind: 'table'; rows: TexInline[][][]; head: boolean }
    /** Any other environment: its name, and its contents parsed as blocks. */
    | { kind: 'env'; name: string; blocks: TexBlock[] };

export interface TexDoc {
    title?: string;
    author?: string;
    date?: string;
    /** Everything before `\begin{document}`, verbatim — shown as source, since
     *  a preamble is instructions to the compiler and not prose. */
    preamble: string;
    blocks: TexBlock[];
    /** Set when the file was too big to parse and `blocks` is its source. */
    tooBig?: boolean;
}

/**
 * Past this the file is shown as plain source instead.
 *
 * The scanner is linear and a megabyte costs a few ms, but the DOM it produces
 * is not free, and a 4MB generated .tex (a data table dumped as `tabular`) is a
 * document nobody reads in a pane anyway.
 */
const MAX_PARSED_BYTES = 1_500_000;

const HEADINGS: Record<string, number> = {
    part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4,
    paragraph: 5, subparagraph: 5,
};

/** Environments whose body is code, not prose: taken verbatim, and never
 *  comment-stripped (a `%` in a listing is a line of Python). */
const VERBATIM_ENVS = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt', 'semiverbatim']);

/** Environments KaTeX itself understands, handed to it whole — `align` and
 *  friends carry their own alignment and numbering, so splitting them up would
 *  be undoing the thing they are for. */
const MATH_ENVS = new Set([
    'equation', 'align', 'alignat', 'flalign', 'gather', 'multline', 'displaymath',
    'eqnarray', 'split', 'aligned', 'gathered', 'cases', 'array', 'CD',
]);

const LIST_ENVS: Record<string, boolean> = { itemize: false, enumerate: true, description: false };

/** Rules and column-spec noise dropped from a `tabular` row. */
const TABLE_RULES = /\\(?:hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\}|cmidrule(?:\([^)]*\))?\s*\{[^}]*\}|addlinespace(?:\s*\[[^\]]*\])?)/g;

/* ── Scanning helpers ─────────────────────────────────────────────────────── */

/** Index just past the `}` matching the `{` at `open`, or -1. */
function afterGroup(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { i++; continue; }          // an escaped brace is not a brace
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

/** The contents of a `{…}` argument at `i`, and where it ends. Whitespace
 *  before the brace is skipped, as TeX does. */
function readArg(src: string, i: number): { text: string; next: number } {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return { text: '', next: i };
    const end = afterGroup(src, i);
    if (end < 0) return { text: src.slice(i + 1), next: src.length };
    return { text: src.slice(i + 1, end - 1), next: end };
}

/** Skip a `[…]` optional argument if one is next. Returns `i` UNCHANGED when
 *  there is none — spaces are content, and eating them turned every `\item Foo`
 *  into an item labelled with a space. */
function skipOptional(src: string, i: number): number {
    let at = i;
    while (at < src.length && /[ \t]/.test(src[at])) at++;
    if (src[at] !== '[') return i;
    const end = src.indexOf(']', at);
    return end < 0 ? src.length : end + 1;
}

/**
 * Drop comments, leaving verbatim environments alone.
 *
 * `%` to end of line, unless escaped — and a comment takes the newline with it,
 * which is TeX's own rule and the reason a commented-out line does not open a
 * paragraph break where the author did not write one.
 */
function stripComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            // A verbatim body is copied across untouched, `%` and all.
            const begin = /^\\begin\s*\{([A-Za-z*]+)\}/.exec(src.slice(i, i + 40));
            if (begin && VERBATIM_ENVS.has(begin[1].replace(/\*$/, ''))) {
                const close = `\\end{${begin[1]}}`;
                const at = src.indexOf(close, i);
                const to = at < 0 ? src.length : at + close.length;
                out += src.slice(i, to);
                i = to;
                continue;
            }
            // Anything else after a backslash is a command name or an escaped
            // character; either way the next character is not a comment.
            out += src.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (c === '%') {
            const nl = src.indexOf('\n', i);
            i = nl < 0 ? src.length : nl + 1;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** Where the body of `\begin{name}` at `from` ends, counting nested copies of
 *  the same environment. Returns the body and where to carry on from. */
function readEnvBody(src: string, name: string, from: number): { body: string; next: number } {
    const open = `\\begin{${name}}`;
    const close = `\\end{${name}}`;
    let depth = 1;
    let i = from;
    while (i < src.length) {
        const nextOpen = src.indexOf(open, i);
        const nextClose = src.indexOf(close, i);
        if (nextClose < 0) return { body: src.slice(from), next: src.length };
        if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + open.length; continue; }
        if (--depth === 0) return { body: src.slice(from, nextClose), next: nextClose + close.length };
        i = nextClose + close.length;
    }
    return { body: src.slice(from), next: src.length };
}

/* ── Inline text ──────────────────────────────────────────────────────────── */

/** Commands that are pure formatting in a compiler and pure noise in a reader. */
const DROPPED = new Set([
    'noindent', 'centering', 'raggedright', 'raggedleft', 'clearpage', 'newpage',
    'pagebreak', 'linebreak', 'maketitle', 'tableofcontents', 'bigskip', 'medskip',
    'smallskip', 'hfill', 'vfill', 'par', 'protect', 'normalsize', 'small',
    'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge',
    'bfseries', 'itshape', 'ttfamily', 'rmfamily', 'sffamily', 'upshape', 'mdseries',
]);

/** Commands whose one argument is dropped along with them. */
const DROPPED_WITH_ARG = new Set(['label', 'vspace', 'hspace', 'index', 'nonumber', 'setlength']);

const STYLES: Record<string, 'bold' | 'italic' | 'mono' | 'underline'> = {
    textbf: 'bold', bf: 'bold', strong: 'bold',
    textit: 'italic', emph: 'italic', it: 'italic', textsl: 'italic',
    texttt: 'mono', tt: 'mono', lstinline: 'mono', mathtt: 'mono',
    underline: 'underline', uline: 'underline',
};

/** Commands that are a single character or word once typeset. */
const LITERALS: Record<string, string> = {
    LaTeX: 'LaTeX', LaTeXe: 'LaTeX2e', TeX: 'TeX', BibTeX: 'BibTeX',
    ldots: '…', dots: '…', textbackslash: '\\', textasciitilde: '~',
    textellipsis: '…', textquotedblleft: '“', textquotedblright: '”',
    textendash: '–', textemdash: '-', copyright: '©', pounds: '£',
};

export function parseInline(src: string): TexInline[] {
    const out: TexInline[] = [];
    let text = '';
    const flush = () => { if (text) { out.push({ kind: 'text', text }); text = ''; } };
    const push = (span: TexInline) => { flush(); out.push(span); };

    let i = 0;
    while (i < src.length) {
        const c = src[i];

        if (c === '$') {
            // `$$` inside a paragraph is display maths the author put mid-line;
            // both forms end at their own delimiter.
            const double = src.startsWith('$$', i);
            const delim = double ? '$$' : '$';
            let end = i + delim.length;
            while (end < src.length) {
                if (src[end] === '\\') { end += 2; continue; }
                if (src.startsWith(delim, end)) break;
                end++;
            }
            push({ kind: 'math', tex: src.slice(i + delim.length, Math.min(end, src.length)) });
            i = Math.min(end + delim.length, src.length);
            continue;
        }

        if (src.startsWith('\\(', i) || src.startsWith('\\[', i)) {
            const close = src.startsWith('\\(', i) ? '\\)' : '\\]';
            const end = src.indexOf(close, i + 2);
            push({ kind: 'math', tex: src.slice(i + 2, end < 0 ? src.length : end) });
            i = end < 0 ? src.length : end + 2;
            continue;
        }

        if (c === '\\') {
            if (src.startsWith('\\\\', i)) {
                push({ kind: 'break' });
                i = skipOptional(src, i + 2);
                continue;
            }
            const name = /^\\([A-Za-z@]+)\*?/.exec(src.slice(i));
            if (!name) {
                // An escaped character: `\%`, `\&`, `\_`, `\$`, `\#`, `\{`, `\}`,
                // and `\ ` for a space that survives.
                text += src[i + 1] ?? '';
                i += 2;
                continue;
            }
            const cmd = name[1];
            let next = i + name[0].length;

            if (cmd === 'verb') {
                // `\verb|code|` — the character after the command IS the
                // delimiter, which is why this cannot go through readArg.
                const delim = src[next];
                const end = delim ? src.indexOf(delim, next + 1) : -1;
                push({ kind: 'styled', style: 'mono', spans: [{ kind: 'text', text: src.slice(next + 1, end < 0 ? src.length : end) }] });
                i = end < 0 ? src.length : end + 1;
                continue;
            }
            if (STYLES[cmd]) {
                const arg = readArg(src, next);
                push({ kind: 'styled', style: STYLES[cmd], spans: parseInline(arg.text) });
                i = arg.next;
                continue;
            }
            if (LITERALS[cmd]) {
                text += LITERALS[cmd];
                i = next;
                // `\LaTeX{}` — an empty group after a word command is how TeX
                // keeps the space after it; it is not content.
                if (src.startsWith('{}', i)) i += 2;
                continue;
            }
            if (cmd === 'ref' || cmd === 'eqref' || cmd === 'autoref' || cmd === 'cref' || cmd === 'Cref' || cmd === 'cite' || cmd === 'citep' || cmd === 'citet') {
                next = skipOptional(src, next);
                const arg = readArg(src, next);
                text += `[${arg.text}]`;
                i = arg.next;
                continue;
            }
            if (cmd === 'footnote') {
                const arg = readArg(src, next);
                text += ` (${arg.text})`;
                i = arg.next;
                continue;
            }
            if (DROPPED_WITH_ARG.has(cmd)) {
                i = readArg(src, skipOptional(src, next)).next;
                continue;
            }
            if (DROPPED.has(cmd)) { i = next; continue; }
            if (cmd === 'text' || cmd === 'textrm' || cmd === 'textsf' || cmd === 'textsc' || cmd === 'textnormal' || cmd === 'mbox' || cmd === 'mathrm') {
                // A font change with nothing to show for it in a pane: its
                // contents are the content.
                const arg = readArg(src, next);
                flush();
                out.push(...parseInline(arg.text));
                i = arg.next;
                continue;
            }
            // Unknown: shown as itself. Its arguments are left in the stream, so
            // whatever text they hold is still read (see the file's header) — with
            // a space after the command, or `\textcolor{red}{this}` would read
            // as "\textcolorred this".
            push({ kind: 'raw', text: name[0] });
            i = next;
            if (src[i] === '{') text += ' ';
            continue;
        }

        if (c === '~') { text += ' '; i++; continue; }
        if (c === '{') { i++; continue; }                // grouping, not content
        if (c === '}') {
            // `\textcolor{red}{this}`: with the braces gone the two arguments
            // would read as one word. A space between them keeps both legible.
            if (src[i + 1] === '{') text += ' ';
            i++;
            continue;
        }
        if (c === '&') { text += '&'; i++; continue; }    // a column break outside a table
        if (c === '\n') { text += ' '; i++; continue; }  // TeX reflows; so does the pane
        text += c;
        i++;
    }
    flush();
    return out;
}

/* ── Blocks ───────────────────────────────────────────────────────────────── */

function tableRows(body: string): { rows: TexInline[][][]; head: boolean } {
    // The column spec (`{|l|c|}`, and `[t]` before it) belongs to the compiler.
    let i = skipOptional(body, 0);
    i = readArg(body, i).next;
    const rest = body.slice(i);
    const lines = rest.split(/\\\\/);
    // A rule drawn after the first row is what makes it a header row — the one
    // piece of `\hline` worth reading before it is dropped.
    const head = /^\s*(?:\\(?:hline|toprule|midrule))/.test(lines[1] ?? '');
    const rows: TexInline[][][] = [];
    for (const line of lines) {
        const cleaned = line.replace(TABLE_RULES, '').trim();
        if (!cleaned) continue;
        // `\&` is an ampersand in a cell, not a column break.
        const cells = cleaned.split(/(?<!\\)&/).map(cell => trimSpans(parseInline(cell.trim())));
        rows.push(cells);
    }
    return { rows, head };
}

function envBlock(name: string, body: string): TexBlock {
    const bare = name.replace(/\*$/, '');
    if (VERBATIM_ENVS.has(bare)) {
        // Only the leading/trailing newlines the \begin and \end sit on.
        return { kind: 'code', text: body.replace(/^\n/, '').replace(/\n[ \t]*$/, '') };
    }
    if (MATH_ENVS.has(bare)) {
        // Handed to KaTeX whole, environment and all.
        return { kind: 'math', tex: `\\begin{${name}}${body}\\end{${name}}` };
    }
    if (bare === 'tabular' || bare === 'tabularx' || bare === 'longtable') {
        const { rows, head } = tableRows(body);
        return { kind: 'table', rows, head };
    }
    if (bare in LIST_ENVS) {
        const ordered = LIST_ENVS[bare];
        const items: TexBlock[][] = [];
        // Split on \item at THIS level: an \item inside a nested list belongs to
        // that list, which parseBlocks below will reach on its own.
        const parts = splitItems(body);
        for (const part of parts) items.push(parseBlocks(part));
        return { kind: 'list', ordered, items };
    }
    if (bare === 'document' || bare === 'center' || bare === 'flushleft' || bare === 'flushright' || bare === 'sloppypar') {
        // Alignment only: no label worth drawing.
        return { kind: 'env', name: '', blocks: parseBlocks(body) };
    }
    return { kind: 'env', name: bare, blocks: parseBlocks(body) };
}

/**
 * A list body split into its items.
 *
 * `\item` at THIS level only: a nested `itemize` is skipped whole, so its items
 * stay with it rather than being pulled up into the outer list. `\item[term]`
 * keeps the term, as the bold lead-in of the item — which is what a description
 * list looks like once typeset.
 */
function splitItems(body: string): string[] {
    const items: string[] = [];
    let current: string | null = null;
    let i = 0;
    while (i < body.length) {
        if (body.startsWith('\\begin', i)) {
            const m = /^\\begin\s*\{([A-Za-z*]+)\}/.exec(body.slice(i));
            if (m) {
                const inner = readEnvBody(body, m[1], i + m[0].length);
                if (current !== null) current += body.slice(i, inner.next);
                i = inner.next;
                continue;
            }
        }
        if (body.startsWith('\\item', i) && !/[A-Za-z]/.test(body[i + 5] ?? '')) {
            if (current !== null) items.push(current);
            let at = i + 5;
            let lead = '';
            const opt = skipOptional(body, at);
            if (opt > at) {
                lead = body.slice(at, opt).replace(/^\s*\[/, '').replace(/\]$/, '');
                at = opt;
            }
            current = lead ? `\\textbf{${lead}} ` : '';
            i = at;
            continue;
        }
        if (current !== null) current += body[i];
        i++;
    }
    if (current !== null) items.push(current);
    return items.filter(item => item.trim());
}

export function parseBlocks(src: string): TexBlock[] {
    const blocks: TexBlock[] = [];
    let para = '';
    const flush = () => {
        const spans = para.trim() ? parseInline(para) : [];
        // A paragraph that was nothing but `\maketitle` and a newline has no
        // text left once the commands are dropped, and an empty <p> would show
        // as a gap the file does not have.
        if (spans.length && inlineText(spans).trim()) blocks.push({ kind: 'para', spans: trimSpans(spans) });
        para = '';
    };

    let i = 0;
    while (i < src.length) {
        // An environment.
        if (src.startsWith('\\begin', i)) {
            const m = /^\\begin\s*\{([A-Za-z*]+)\}/.exec(src.slice(i));
            if (m) {
                flush();
                const { body, next } = readEnvBody(src, m[1], i + m[0].length);
                blocks.push(envBlock(m[1], body));
                i = next;
                continue;
            }
        }
        // Display maths.
        if (src.startsWith('$$', i) || src.startsWith('\\[', i)) {
            flush();
            const close = src.startsWith('$$', i) ? '$$' : '\\]';
            const end = src.indexOf(close, i + 2);
            blocks.push({ kind: 'math', tex: src.slice(i + 2, end < 0 ? src.length : end) });
            i = end < 0 ? src.length : end + close.length;
            continue;
        }
        // A sectioning command.
        const heading = /^\\([A-Za-z]+)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(src.slice(i));
        if (heading && HEADINGS[heading[1]]) {
            flush();
            const arg = readArg(src, i + heading[0].length - 1);
            blocks.push({ kind: 'heading', level: HEADINGS[heading[1]], spans: trimSpans(parseInline(arg.text)) });
            i = arg.next;
            continue;
        }
        // A blank line ends a paragraph, exactly as it does for TeX.
        const blank = /^\n[ \t]*\n\s*/.exec(src.slice(i));
        if (blank) {
            flush();
            i += blank[0].length;
            continue;
        }
        // A brace group runs past everything above, so its contents cannot be
        // mistaken for a paragraph break.
        para += src[i];
        i++;
    }
    flush();
    return blocks;
}

/** Whitespace at the very start and end of a run is TeX's line breaks, not the
 *  author's spacing: a paragraph that keeps it opens with a stray indent. */
function trimSpans(spans: TexInline[]): TexInline[] {
    const out = spans.slice();
    const first = out[0];
    if (first?.kind === 'text') out[0] = { kind: 'text', text: first.text.replace(/^\s+/, '') };
    const last = out[out.length - 1];
    if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text.replace(/\s+$/, '') };
    return out.filter(span => span.kind !== 'text' || span.text !== '');
}

/** The plain text of some inline runs — for a title, which is a string. */
function inlineText(spans: readonly TexInline[]): string {
    return spans.map(span => {
        if (span.kind === 'text') return span.text;
        if (span.kind === 'styled') return inlineText(span.spans);
        if (span.kind === 'math') return `$${span.tex}$`;
        return '';
    }).join('');
}

/** Read `name`'s one argument out of the preamble, if it is there. */
function preambleField(preamble: string, name: string): string | undefined {
    const at = preamble.search(new RegExp(`\\\\${name}\\s*(?:\\[[^\\]]*\\])?\\s*\\{`));
    if (at < 0) return undefined;
    const arg = readArg(preamble, preamble.indexOf('{', at));
    const text = inlineText(parseInline(arg.text)).trim();
    return text || undefined;
}

/**
 * Parse a `.tex` file for reading.
 *
 * Comments go first, then the file splits at `\begin{document}`: a file with no
 * document environment (an `\input`ed fragment, a `.sty`) is all body, which is
 * the reading that shows its contents rather than an empty pane.
 */
export function parseTex(source: string): TexDoc {
    if (source.length > MAX_PARSED_BYTES) {
        return { preamble: '', blocks: [{ kind: 'code', text: source }], tooBig: true };
    }
    const src = stripComments(source);
    const begin = src.search(/\\begin\s*\{document\}/);
    const preamble = begin < 0 ? '' : src.slice(0, begin);
    let body = begin < 0 ? src : src.slice(begin);
    if (begin >= 0) {
        const m = /^\\begin\s*\{document\}/.exec(body)!;
        const { body: inner } = readEnvBody(body, 'document', m[0].length);
        body = inner;
    }
    return {
        title: preambleField(preamble, 'title'),
        author: preambleField(preamble, 'author'),
        date: preambleField(preamble, 'date'),
        preamble: preamble.trim(),
        blocks: parseBlocks(body),
    };
}
