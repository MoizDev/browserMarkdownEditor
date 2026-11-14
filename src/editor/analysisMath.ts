import type { Text } from '@codemirror/state';
import { overlapsRange } from './rangeSearch';
import type { CharRange } from './rangeSearch';
import type { LineMatch } from './analysisLines';
import type { MathRegion } from './latexSource';

export interface BlockPair extends CharRange {
    accepted: boolean;
    latex: string;
}

export interface InlineMath extends CharRange {
    accepted: boolean;
    latex: string;
}

/** Reproduce the global block regex's consuming pairing, including rejected pairs. */
export function pairMathTokens(doc: Text, tokens: readonly number[], code: readonly CharRange[]): BlockPair[] {
    const pairs: BlockPair[] = [];
    let i = 0;
    while (i < tokens.length) {
        const from = tokens[i++];
        while (i < tokens.length && tokens[i] < from + 3) i++;
        if (i === tokens.length) break;
        const to = tokens[i++] + 2;
        const latex = doc.sliceString(from + 2, to - 2).trim();
        pairs.push({ from, to, latex, accepted: !!latex && !overlapsRange(code, from, to) });
        while (i < tokens.length && tokens[i] < to) i++;
    }
    return pairs;
}

export function filterInlineMath(raw: readonly LineMatch[], code: readonly CharRange[], blocks: readonly BlockPair[]): InlineMath[] {
    const acceptedBlocks = blocks.filter(pair => pair.accepted);
    return raw.map(match => {
        const latex = match.groups[0];
        return {
            from: match.from, to: match.to, latex,
            accepted: !latex.endsWith('\\') && !overlapsRange(code, match.from, match.to)
                && !overlapsRange(acceptedBlocks, match.from, match.to),
        };
    });
}

export function acceptedMath(blocks: readonly BlockPair[], inline: readonly InlineMath[]): MathRegion[] {
    const result: MathRegion[] = [];
    let b = 0, i = 0;
    while (b < blocks.length || i < inline.length) {
        if (i === inline.length || (b < blocks.length && blocks[b].from <= inline[i].from)) {
            const pair = blocks[b++];
            if (pair.accepted) result.push({ from: pair.from, to: pair.to, latex: pair.latex, block: true });
        } else {
            const match = inline[i++];
            if (match.accepted) result.push({ from: match.from, to: match.to, latex: match.latex, block: false });
        }
    }
    return result;
}
