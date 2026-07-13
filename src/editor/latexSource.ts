import { Decoration, EditorView, keymap } from '@codemirror/view';
import { EditorSelection, Prec } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/** One $…$ / $$…$$ span. `latex` is the inner source, delimiters excluded. */
export interface MathRegion {
    from: number;
    to: number;
    latex: string;
    block: boolean;
}

interface CharRange {
    from: number;
    to: number;
}

/** Ranges where $ is literal text: fenced/indented code blocks and inline
 *  backticks. Shared by the live preview and the math bracket handler. */
export function collectCodeRanges(state: EditorState): CharRange[] {
    const out: CharRange[] = [];
    syntaxTree(state).iterate({
        enter(n) {
            if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') {
                out.push({ from: n.from, to: n.to });
                return false;
            }
        },
    });
    return out;
}

/**
 * Find every math region in the document, using Obsidian's rules and nothing
 * more (no currency heuristics):
 *  - $$…$$ is block math and may span lines;
 *  - $…$ is inline math on a single line, where the opening $ is not followed
 *    by whitespace and the closing $ is not preceded by whitespace;
 *  - \$ is a literal dollar sign, never a delimiter;
 *  - $ inside code (fenced blocks, inline backticks) is literal.
 */
export function findMathRegions(doc: string, codeRanges: CharRange[]): MathRegion[] {
    const regions: MathRegion[] = [];
    const inCode = (from: number, to: number) => codeRanges.some(r => from < r.to && to > r.from);

    const blocks: CharRange[] = [];
    const blockRe = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(doc)) !== null) {
        const from = m.index;
        const to = from + m[0].length;
        if (!m[1].trim() || inCode(from, to)) continue;
        blocks.push({ from, to });
        regions.push({ from, to, latex: m[1].trim(), block: true });
    }

    const inlineRe = /(?<![\\$])\$(?![\s$])([^$\n]*?[^\s$])\$(?!\$)/g;
    while ((m = inlineRe.exec(doc)) !== null) {
        const from = m.index;
        const to = from + m[0].length;
        if (m[1].endsWith('\\')) continue; // …\$ — escaped closing dollar
        if (inCode(from, to)) continue;
        if (blocks.some(b => from < b.to && to > b.from)) continue;
        regions.push({ from, to, latex: m[1], block: false });
    }

    return regions.sort((a, b) => a.from - b.from);
}

/* ── Source highlighting (revealed math) ──
   A lightweight LaTeX tokenizer, matched Obsidian's editor look: green $
   delimiters, coral \commands, purple numbers and ^/_ scripts, green
   operators, muted brackets, teal variable text. One alternation, first
   match wins; whitespace (and anything exotic) simply stays unstyled. */
const TOKEN_RE = new RegExp(
    '(\\\\(?:[a-zA-Z]+\\*?|.))' +                      // 1 \command  \left  \\  \{
    '|([0-9]+(?:\\.[0-9]+)?)' +                        // 2 number
    '|([\\^_])' +                                      // 3 ^/_ script marker (reads red, like commands)
    '|([{}\\[\\]])' +                                  // 4 brace — reads with the command it follows
    '|([()])' +                                        // 5 paren — reads with the variables it wraps
    "|([=+\\-*/<>,;:!|&'])" +                          // 6 operator
    '|(\\$+)' +                                        // 7 $ / $$ delimiter
    "|([^\\s\\\\0-9^_{}\\[\\]()=+\\-*/<>,;:!|&'$]+)",  // 8 variable text
    'g'
);

const GROUP_CLASS = [
    '', // (whole-match placeholder)
    'cm-latex-command',
    'cm-latex-number',
    'cm-latex-script',
    'cm-latex-brace',
    'cm-latex-paren',
    'cm-latex-operator',
    'cm-latex-delim',
    'cm-latex-var',
];

/* ── Code-editor bracket behavior inside math ──
   The stock closeBrackets extension only auto-closes when the NEXT character
   is whitespace or one of ")]}:;>" — inside $…$ the next character is usually
   the closing $, a backslash, or a letter, so braces never pair exactly where
   you want them most. These handlers pair unconditionally, but ONLY in math. */

/** True when `pos` sits inside a math region — or, while a formula is still
 *  being composed (no closing $ yet), when an odd number of unescaped $s
 *  appear earlier on the same line (an opener is pending). */
export function isInMathContext(state: EditorState, pos: number): boolean {
    const doc = state.doc.toString();
    for (const r of findMathRegions(doc, collectCodeRanges(state))) {
        if (pos > r.from && pos < r.to) return true;
    }
    const line = state.doc.lineAt(pos);
    const dollars = doc.slice(line.from, pos).match(/(?<!\\)\$/g);
    return (dollars?.length ?? 0) % 2 === 1;
}

const BRACKET_PAIRS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
const CLOSERS = new Set(Object.values(BRACKET_PAIRS));

function inCodeRange(state: EditorState, pos: number): boolean {
    return collectCodeRanges(state).some(r => pos > r.from && pos < r.to);
}

/**
 * Dollar-sign pairing, active EVERYWHERE except code and after a \ escape:
 *  - a selection gets wrapped in $…$;
 *  - a bare $ spawns the pair:            $|$
 *  - a second $ inside a fresh empty pair expands it to block math: $$|$$
 *    (only when that pair's opener is the sole $ before the cursor on the
 *    line — otherwise the $ is a CLOSER being typed out of habit, and it
 *    steps over the existing one instead: $$x$|$ + $ → $$x$$|, not junk);
 *  - typing $ when the next char is $ steps over it.
 */
function handleDollar(view: EditorView, from: number): boolean {
    const { state } = view;
    if (inCodeRange(state, from)) return false;
    if (state.sliceDoc(from - 1, from) === '\\') return false;

    const changes = state.changeByRange((range) => {
        if (!range.empty) {
            return {
                changes: [
                    { from: range.from, insert: '$' },
                    { from: range.to, insert: '$' },
                ],
                range: EditorSelection.range(range.from + 1, range.to + 1),
            };
        }
        const pos = range.from;
        const prev = state.sliceDoc(pos - 1, pos);
        const next = state.sliceDoc(pos, pos + 1);
        const line = state.doc.lineAt(pos);
        const dollarsBefore = state.sliceDoc(line.from, pos).match(/\$/g)?.length ?? 0;

        if (prev === '$' && next === '$' && dollarsBefore === 1) {
            // $|$ → $$|$$
            return { changes: { from: pos, insert: '$$' }, range: EditorSelection.cursor(pos + 1) };
        }
        if (next === '$') {
            // step over
            return { range: EditorSelection.cursor(pos + 1) };
        }
        // spawn the pair
        return { changes: { from: pos, insert: '$$' }, range: EditorSelection.cursor(pos + 1) };
    });
    view.dispatch({ ...changes, userEvent: 'input.type', scrollIntoView: true });
    return true;
}

/**
 * Code-editor keys for LaTeX: $ pairing/wrapping app-wide (see handleDollar),
 * {, ( and [ auto-pairing inside math (wrapping the selection if there is
 * one), type-over of already-present closers, and Backspace deleting both
 * halves of a fresh empty pair.
 */
export function mathEditingExtensions(): Extension {
    return [
        Prec.high(EditorView.inputHandler.of((view, from, _to, text) => {
            if (text === '$') return handleDollar(view, from);
            if (text.length !== 1) return false;
            const isOpen = text in BRACKET_PAIRS;
            if (!isOpen && !CLOSERS.has(text)) return false;
            const { state } = view;
            if (!isInMathContext(state, from)) return false;

            // Closer: typing it over an identical next char just steps past.
            if (!isOpen) {
                if (state.selection.main.empty && state.sliceDoc(from, from + 1) === text) {
                    view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' });
                    return true;
                }
                return false;
            }

            // Opener: spawn the pair, or wrap the selection in it.
            const changes = state.changeByRange((range) => range.empty
                ? {
                    changes: { from: range.from, insert: text + BRACKET_PAIRS[text] },
                    range: EditorSelection.cursor(range.from + 1),
                }
                : {
                    changes: [
                        { from: range.from, insert: text },
                        { from: range.to, insert: BRACKET_PAIRS[text] },
                    ],
                    range: EditorSelection.range(range.from + 1, range.to + 1),
                });
            view.dispatch({ ...changes, userEvent: 'input.type', scrollIntoView: true });
            return true;
        })),
        Prec.high(keymap.of([{
            key: 'Backspace',
            run: (view) => {
                const { state } = view;
                const range = state.selection.main;
                if (!range.empty || range.from === 0) return false;
                const pair = state.sliceDoc(range.from - 1, range.from + 1);
                const isPair = pair.length === 2
                    && (BRACKET_PAIRS[pair[0]] === pair[1] || pair === '$$');
                if (!isPair) return false;
                if (inCodeRange(state, range.from)) return false;
                // Brackets only pair inside math, so only un-pair them there;
                // an empty $ pair un-pairs anywhere, matching how it spawned.
                if (pair !== '$$' && !isInMathContext(state, range.from)) return false;
                view.dispatch({
                    changes: { from: range.from - 1, to: range.from + 1 },
                    userEvent: 'delete.backward',
                });
                return true;
            },
        }])),
    ];
}

/**
 * Decorations for one revealed math region: a whole-region mark carrying the
 * Fira Code italic "math source" look, plus a color mark per token.
 */
export function latexSourceDecorations(source: string, offset: number): Range<Decoration>[] {
    const out: Range<Decoration>[] = [];
    out.push(Decoration.mark({ class: 'cm-math-src' }).range(offset, offset + source.length));

    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(source)) !== null) {
        for (let g = 1; g < GROUP_CLASS.length; g++) {
            if (m[g] !== undefined) {
                out.push(
                    Decoration.mark({ class: GROUP_CLASS[g] })
                        .range(offset + m.index, offset + m.index + m[0].length)
                );
                break;
            }
        }
    }
    return out;
}
