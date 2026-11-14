import { overlapsRange } from './rangeSearch';
import type { CharRange } from './rangeSearch';

/** One $…$ / $$…$$ span. `latex` is the inner source, delimiters excluded. */
export interface MathRegion {
    from: number;
    to: number;
    latex: string;
    block: boolean;
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
    const inCode = (from: number, to: number) => overlapsRange(codeRanges, from, to);

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
        if (overlapsRange(blocks, from, to)) continue;
        regions.push({ from, to, latex: m[1], block: false });
    }

    return regions.sort((a, b) => a.from - b.from);
}

