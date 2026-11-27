export type TexInline =
    | { kind: 'text'; text: string }
    | { kind: 'math'; tex: string }
    | { kind: 'styled'; style: 'bold' | 'italic' | 'mono' | 'underline'; spans: TexInline[] }
    | { kind: 'raw'; text: string }
    | { kind: 'break' };

export type TexBlock =
    | { kind: 'heading'; level: number; spans: TexInline[] }
    | { kind: 'para'; spans: TexInline[] }
    | { kind: 'math'; tex: string }
    | { kind: 'code'; text: string }
    | { kind: 'list'; ordered: boolean; items: TexBlock[][] }
    | { kind: 'table'; rows: TexInline[][][]; head: boolean }
    | { kind: 'env'; name: string; blocks: TexBlock[] };

export interface TexDoc {
    title?: string;
    author?: string;
    date?: string;
    preamble: string;
    blocks: TexBlock[];
    tooBig?: boolean;
}

const MAX_PARSED_BYTES = 1_500_000;

const HEADINGS: Record<string, number> = {
    part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4,
    paragraph: 5, subparagraph: 5,
};

/** Environments whose body is code, not prose: taken verbatim, and never
 *  comment-stripped (a `%` in a listing is a line of Python). */
const VERBATIM_ENVS = new Set(['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt', 'semiverbatim']);

const MATH_ENVS = new Set([
    'equation', 'align', 'alignat', 'flalign', 'gather', 'multline', 'displaymath',
    'eqnarray', 'split', 'aligned', 'gathered', 'cases', 'array', 'CD',
]);

const LIST_ENVS: Record<string, boolean> = { itemize: false, enumerate: true, description: false };

const TABLE_RULES = /\\(?:hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\}|cmidrule(?:\([^)]*\))?\s*\{[^}]*\}|addlinespace(?:\s*\[[^\]]*\])?)/g;

function afterGroup(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { i++; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

function readArg(src: string, i: number): { text: string; next: number } {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return { text: '', next: i };
    const end = afterGroup(src, i);
    if (end < 0) return { text: src.slice(i + 1), next: src.length };
    return { text: src.slice(i + 1, end - 1), next: end };
}

function skipOptional(src: string, i: number): number {
    let at = i;
    while (at < src.length && /[ \t]/.test(src[at])) at++;
    if (src[at] !== '[') return i;
    const end = src.indexOf(']', at);
    return end < 0 ? src.length : end + 1;
}

function stripComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            const begin = /^\\begin\s*\{([A-Za-z*]+)\}/.exec(src.slice(i, i + 40));
            if (begin && VERBATIM_ENVS.has(begin[1].replace(/\*$/, ''))) {
                const close = `\\end{${begin[1]}}`;
                const at = src.indexOf(close, i);
                const to = at < 0 ? src.length : at + close.length;
                out += src.slice(i, to);
                i = to;
                continue;
            }
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

const DROPPED = new Set([
    'noindent', 'centering', 'raggedright', 'raggedleft', 'clearpage', 'newpage',
    'pagebreak', 'linebreak', 'maketitle', 'tableofcontents', 'bigskip', 'medskip',
    'smallskip', 'hfill', 'vfill', 'par', 'protect', 'normalsize', 'small',
    'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge',
    'bfseries', 'itshape', 'ttfamily', 'rmfamily', 'sffamily', 'upshape', 'mdseries',
]);

const DROPPED_WITH_ARG = new Set(['label', 'vspace', 'hspace', 'index', 'nonumber', 'setlength']);

const STYLES: Record<string, 'bold' | 'italic' | 'mono' | 'underline'> = {
    textbf: 'bold', bf: 'bold', strong: 'bold',
    textit: 'italic', emph: 'italic', it: 'italic', textsl: 'italic',
    texttt: 'mono', tt: 'mono', lstinline: 'mono', mathtt: 'mono',
    underline: 'underline', uline: 'underline',
};

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
                text += src[i + 1] ?? '';
                i += 2;
                continue;
            }
            const cmd = name[1];
            let next = i + name[0].length;

            if (cmd === 'verb') {
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
                const arg = readArg(src, next);
                flush();
                out.push(...parseInline(arg.text));
                i = arg.next;
                continue;
            }
            push({ kind: 'raw', text: name[0] });
            i = next;
            if (src[i] === '{') text += ' ';
            continue;
        }

        if (c === '~') { text += ' '; i++; continue; }
        if (c === '{') { i++; continue; }
        if (c === '}') {
            if (src[i + 1] === '{') text += ' ';
            i++;
            continue;
        }
        if (c === '&') { text += '&'; i++; continue; }
        if (c === '\n') { text += ' '; i++; continue; }
        text += c;
        i++;
    }
    flush();
    return out;
}

function tableRows(body: string): { rows: TexInline[][][]; head: boolean } {
    let i = skipOptional(body, 0);
    i = readArg(body, i).next;
    const rest = body.slice(i);
    const lines = rest.split(/\\\\/);
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
        return { kind: 'code', text: body.replace(/^\n/, '').replace(/\n[ \t]*$/, '') };
    }
    if (MATH_ENVS.has(bare)) {
        return { kind: 'math', tex: `\\begin{${name}}${body}\\end{${name}}` };
    }
    if (bare === 'tabular' || bare === 'tabularx' || bare === 'longtable') {
        const { rows, head } = tableRows(body);
        return { kind: 'table', rows, head };
    }
    if (bare in LIST_ENVS) {
        const ordered = LIST_ENVS[bare];
        const items: TexBlock[][] = [];
        const parts = splitItems(body);
        for (const part of parts) items.push(parseBlocks(part));
        return { kind: 'list', ordered, items };
    }
    if (bare === 'document' || bare === 'center' || bare === 'flushleft' || bare === 'flushright' || bare === 'sloppypar') {
        return { kind: 'env', name: '', blocks: parseBlocks(body) };
    }
    return { kind: 'env', name: bare, blocks: parseBlocks(body) };
}

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
        if (spans.length && inlineText(spans).trim()) blocks.push({ kind: 'para', spans: trimSpans(spans) });
        para = '';
    };

    let i = 0;
    while (i < src.length) {
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
        if (src.startsWith('$$', i) || src.startsWith('\\[', i)) {
            flush();
            const close = src.startsWith('$$', i) ? '$$' : '\\]';
            const end = src.indexOf(close, i + 2);
            blocks.push({ kind: 'math', tex: src.slice(i + 2, end < 0 ? src.length : end) });
            i = end < 0 ? src.length : end + close.length;
            continue;
        }
        const heading = /^\\([A-Za-z]+)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(src.slice(i));
        if (heading && HEADINGS[heading[1]]) {
            flush();
            const arg = readArg(src, i + heading[0].length - 1);
            blocks.push({ kind: 'heading', level: HEADINGS[heading[1]], spans: trimSpans(parseInline(arg.text)) });
            i = arg.next;
            continue;
        }
        const blank = /^\n[ \t]*\n\s*/.exec(src.slice(i));
        if (blank) {
            flush();
            i += blank[0].length;
            continue;
        }
        para += src[i];
        i++;
    }
    flush();
    return blocks;
}

function trimSpans(spans: TexInline[]): TexInline[] {
    const out = spans.slice();
    const first = out[0];
    if (first?.kind === 'text') out[0] = { kind: 'text', text: first.text.replace(/^\s+/, '') };
    const last = out[out.length - 1];
    if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text.replace(/\s+$/, '') };
    return out.filter(span => span.kind !== 'text' || span.text !== '');
}

function inlineText(spans: readonly TexInline[]): string {
    return spans.map(span => {
        if (span.kind === 'text') return span.text;
        if (span.kind === 'styled') return inlineText(span.spans);
        if (span.kind === 'math') return `$${span.tex}$`;
        return '';
    }).join('');
}

function preambleField(preamble: string, name: string): string | undefined {
    const at = preamble.search(new RegExp(`\\\\${name}\\s*(?:\\[[^\\]]*\\])?\\s*\\{`));
    if (at < 0) return undefined;
    const arg = readArg(preamble, preamble.indexOf('{', at));
    const text = inlineText(parseInline(arg.text)).trim();
    return text || undefined;
}

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
