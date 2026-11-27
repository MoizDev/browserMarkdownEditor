import { overlapsRange } from './rangeSearch';
import type { CharRange } from './rangeSearch';
import type { Tree } from '@lezer/common';

export function codeRangesForTree(tree: Tree): CharRange[] {
    const out: CharRange[] = [];
    tree.iterate({ enter(node) {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
            out.push({ from: node.from, to: node.to });
            return false;
        }
    } });
    return out;
}

export interface MathRegion {
    from: number;
    to: number;
    latex: string;
    block: boolean;
}

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
        if (m[1].endsWith('\\')) continue;
        if (inCode(from, to)) continue;
        if (overlapsRange(blocks, from, to)) continue;
        regions.push({ from, to, latex: m[1], block: false });
    }

    return regions.sort((a, b) => a.from - b.from);
}

