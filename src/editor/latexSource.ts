import { Decoration } from '@codemirror/view';
import type { Range } from '@codemirror/state';

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
