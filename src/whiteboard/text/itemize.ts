import { resolveBidi, type BidiParagraph } from './bidi';
import { graphemeBoundaries } from './graphemes';
import { lineBreaks, type LineBreakOpportunity } from './lineBreak';
import type { Block, Marks } from './richText';

export interface TextItem {
    readonly from: number;
    readonly to: number;
    readonly level: number;
    readonly marks: Marks;
}
export interface ItemizedBlock {
    readonly text: string;
    readonly offset: number;
    readonly bidi: BidiParagraph;
    readonly items: readonly TextItem[];
    readonly breaks: readonly LineBreakOpportunity[];
    readonly graphemes: readonly number[];
}

const cache = new WeakMap<Block, Omit<ItemizedBlock, 'offset'>>();

export function itemizeBlock(block: Block, offset: number): ItemizedBlock {
    const cached = cache.get(block);
    if (cached) return { ...cached, offset };
    const text = block.runs.map(run => run.text).join('');
    const bidi = resolveBidi(text, block.dir);
    const items: TextItem[] = [];
    let runStart = 0, charIndex = 0;
    for (const run of block.runs) {
        const end = runStart + run.text.length;
        let cursor = runStart;
        while (cursor < end) {
            while (charIndex < bidi.characters.length && bidi.characters[charIndex].end <= cursor) charIndex++;
            const character = bidi.characters[charIndex];
            if (!character) break;
            const level = character.level;
            let to = Math.min(end, character.end);
            charIndex++;
            while (charIndex < bidi.characters.length && bidi.characters[charIndex].start < end && bidi.characters[charIndex].level === level) {
                to = Math.min(end, bidi.characters[charIndex].end);
                charIndex++;
            }
            items.push({ from: cursor, to, level, marks: run.marks });
            cursor = to;
            if (bidi.characters[charIndex - 1].end > to) charIndex--;
        }
        runStart = end;
    }
    const result = { text, bidi, items, breaks: lineBreaks(text), graphemes: graphemeBoundaries(text) };
    if (text.length <= 16_384) cache.set(block, result);
    return { ...result, offset };
}
