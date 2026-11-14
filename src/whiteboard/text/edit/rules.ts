import type { Transaction } from '../../change/ops';
import type { NodeId } from '../../model/ids';
import { sliceRichText, type Block, type Marks, type RichText } from '../richText';
import { linkUrl, type ToggleMark } from './format';

export interface InputRuleResult { readonly transaction: Transaction; readonly caret: number }

function blockAt(text: RichText, offset: number): { block: Block; start: number; value: string } | null {
    let start = 0;
    for (const block of text.blocks) {
        const value = block.runs.map(run => run.text).join('');
        if (offset <= start + value.length) return { block, start, value };
        start += value.length + 1;
    }
    return null;
}

function transaction(id: NodeId, key: 'text' | 'label', from: number, to: number, insert: RichText, wholeBlocks = false): Transaction {
    return { origin: 'tool', label: 'Format typed text', ops: [{ t: 'splice', id, key, from, to, insert, ...(wholeBlocks ? { wholeBlocks: true as const } : {}) }] };
}

// Each rule is returned as one splice so the history service can join it to the
// current typing burst and retain its inverse for immediate Backspace.
export function inputRule(id: NodeId, key: 'text' | 'label', text: RichText, caret: number): InputRuleResult | null {
    const found = blockAt(text, caret);
    if (!found) return null;
    const { block, start, value } = found;
    const before = value.slice(0, caret - start);
    const prefix = /^(#{1,6}|[-*+]|\d+\.) $/.exec(before);
    if (prefix && block.kind === 'p') {
        const token = prefix[1];
        const kind: Block['kind'] = token[0] === '#' ? `h${token.length}` as Block['kind'] : /\d/.test(token[0]) ? 'ol' : 'ul';
        const number = kind === 'ol' ? Number.parseInt(token, 10) : undefined;
        if (number !== undefined && !Number.isSafeInteger(number)) return null;
        const content = sliceRichText(text, caret, start + value.length).blocks[0];
        const replacement: Block = { ...content, kind, level: 0, ...(number === undefined ? {} : { start: number }) };
        return { transaction: transaction(id, key, start, start + value.length, { blocks: [replacement] }, true), caret: start };
    }
    const patterns: readonly [RegExp, ToggleMark, number][] = [
        [/\*\*([^*\n]+)\*\*$/, 'b', 2], [/__([^_\n]+)__$/, 'b', 2],
        [/(?<!\*)\*([^*\n]+)\*$/, 'i', 1], [/(?<!_)_([^_\n]+)_$/, 'i', 1],
        [/`([^`\n]+)`$/, 'code', 1], [/~~([^~\n]+)~~$/, 's', 2], [/==([^=\n]+)==$/, 'hl', 2],
    ];
    for (const [pattern, mark, delimiter] of patterns) {
        const match = pattern.exec(before);
        if (!match) continue;
        const from = start + match.index;
        const content = sliceRichText(text, from + delimiter, caret - delimiter);
        const replacement = { blocks: content.blocks.map(item => ({ ...item, runs: item.runs.map(run => ({ ...run, marks: { ...run.marks, [mark]: true } as Marks })) })) };
        return { transaction: transaction(id, key, from, caret, replacement), caret: from + match[1].length };
    }
    const word = /(?:^|\s)((?:https?:\/\/|mailto:)[^\s]+|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/[^\s]*)?) $/iu.exec(before);
    if (word) {
        const url = linkUrl(word[1]);
        if (!url) return null;
        const from = caret - 1 - word[1].length;
        const content = sliceRichText(text, from, caret - 1);
        const replacement = { blocks: content.blocks.map(item => ({ ...item, runs: item.runs.map(run => ({ ...run, marks: { ...run.marks, link: url } })) })) };
        return { transaction: transaction(id, key, from, caret - 1, replacement), caret };
    }
    return null;
}
