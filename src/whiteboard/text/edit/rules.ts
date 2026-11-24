import type { Transaction } from '../../change/ops';
import type { NodeId } from '../../model/ids';
import { sliceRichText, spliceRichText, type Block, type Marks, type RichText } from '../richText';
import { trackBlock, trackRun } from '../carriers';
import { reformatRichBlock } from '../richOperations';
import { textBoundaries } from '../boundaries';
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

function transaction(id: NodeId, key: 'text' | 'label', from: number, to: number, insert: RichText, replaceBlocks = false): Transaction {
    return { origin: 'tool', label: 'Format typed text', ops: [{ t: 'splice', id, key, from, to, insert, ...(replaceBlocks ? { replaceBlocks: true as const } : {}) }] };
}

// Each rule is returned as one splice so the history service can join it to the
// current typing burst and retain its inverse for immediate Backspace.
export function inputRule(id: NodeId, key: 'text' | 'label', text: RichText, caret: number, trigger: 'typing' | 'enter' = 'typing'): InputRuleResult | null {
    const found = blockAt(text, caret);
    if (!found || !textBoundaries.isBoundary(text, caret)) return null;
    const { block, start, value } = found;
    const before = value.slice(0, caret - start);
    const prefix = /^(#{1,6}|[-*+]|\d+\.) $/.exec(before);
    if (trigger === 'typing' && prefix && block.kind === 'p') {
        const token = prefix[1];
        const kind: Block['kind'] = token[0] === '#' ? `h${token.length}` as Block['kind'] : /\d/.test(token[0]) ? 'ol' : 'ul';
        const number = kind === 'ol' ? Number.parseInt(token, 10) : undefined;
        if (number !== undefined && !Number.isSafeInteger(number)) return null;
        const content = spliceRichText(text, start, caret, { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: '', marks: {} }] }] }).after[0];
        const replacement = reformatRichBlock(content, kind, 0, number);
        return { transaction: transaction(id, key, start, start + value.length, { blocks: [replacement] }, true), caret: start };
    }
    const patterns: readonly [RegExp, ToggleMark, number][] = [
        [/\*\*([^*\n]+)\*\*$/, 'b', 2], [/__([^_\n]+)__$/, 'b', 2],
        [/(?<!\*)\*([^*\n]+)\*$/, 'i', 1], [/(?<!_)_([^_\n]+)_$/, 'i', 1],
        [/`([^`\n]+)`$/, 'code', 1], [/~~([^~\n]+)~~$/, 's', 2], [/==([^=\n]+)==$/, 'hl', 2],
    ];
    for (const [pattern, mark, delimiter] of patterns) {
        if (trigger !== 'typing') break;
        const match = pattern.exec(before);
        if (!match) continue;
        const from = start + match.index;
        if (!textBoundaries.isBoundary(text, from) || !textBoundaries.isBoundary(text, from + delimiter)
            || !textBoundaries.isBoundary(text, caret - delimiter)) continue;
        const content = sliceRichText(text, from + delimiter, caret - delimiter, true);
        const replacement = { blocks: content.blocks.map(item => trackBlock({ ...item, runs: item.runs.map(run => trackRun({ ...run, marks: { ...run.marks, [mark]: true } as Marks }, run)) }, item)) };
        return { transaction: transaction(id, key, from, caret, replacement), caret: from + match[1].length };
    }
    const word = (trigger === 'typing'
        ? /(?:^|\s)((?:(?:https?:\/\/|mailto:)[^\s]+|[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/[^\s]*)?)[.,!?;:]*) $/iu
        : /(?:^|\s)((?:(?:https?:\/\/|mailto:)[^\s]+|[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/[^\s]*)?)[.,!?;:]*)$/iu).exec(before);
    if (word) {
        const raw = word[1].replace(/[.,!?;:]+$/u, '');
        const url = linkUrl(raw.includes('@') && !raw.includes(':') ? `mailto:${raw}` : raw);
        if (!url) return null;
        const end = caret - (trigger === 'typing' ? 1 : 0) - (word[1].length - raw.length);
        const from = end - raw.length;
        if (!textBoundaries.isBoundary(text, from) || !textBoundaries.isBoundary(text, end)) return null;
        const content = sliceRichText(text, from, end, true);
        const replacement = { blocks: content.blocks.map(item => trackBlock({ ...item, runs: item.runs.map(run => trackRun({ ...run, marks: { ...run.marks, link: url } }, run)) }, item)) };
        return { transaction: transaction(id, key, from, end, replacement), caret };
    }
    return null;
}

// TipTap-typography defaults, as tldraw ships them: a sequence becomes its character as its last character is typed.
// Fractions need a non-letter, non-digit before them so "11/2" stays as typed.
const TYPOGRAPHY: readonly { readonly pattern: string; readonly insert: string; readonly wordStart?: true }[] = [
    { pattern: '--', insert: '—' }, { pattern: '...', insert: '…' },
    { pattern: '<-', insert: '←' }, { pattern: '->', insert: '→' },
    { pattern: '(c)', insert: '©' }, { pattern: '(r)', insert: '®' }, { pattern: '(tm)', insert: '™' },
    { pattern: '1/2', insert: '½', wordStart: true }, { pattern: '1/4', insert: '¼', wordStart: true },
    { pattern: '3/4', insert: '¾', wordStart: true }, { pattern: '+/-', insert: '±' },
    { pattern: '!=', insert: '≠' }, { pattern: '<<', insert: '«' }, { pattern: '>>', insert: '»' },
];

function markAt(block: Block, index: number): Marks | undefined {
    let offset = 0;
    for (const run of block.runs) {
        if (index < offset + run.text.length) return run.marks;
        offset += run.text.length;
    }
    return undefined;
}

/** The typed character becomes typography when the text before it completes a pattern. Quotes take the open or close form by
 * what precedes them. Monospace text and an unclosed backtick type literally (literalTyping), so they are never rewritten. */
export function typographyRule(id: NodeId, key: 'text' | 'label', text: RichText, caret: number): InputRuleResult | null {
    const found = blockAt(text, caret);
    if (!found || !textBoundaries.isBoundary(text, caret)) return null;
    const { block, start, value } = found;
    const at = caret - start, before = value.slice(0, at);
    if (!before || before.split('`').length % 2 === 0) return null;
    const marks = markAt(block, at - 1);
    if (!marks || marks.code) return null;
    const typed = before.at(-1)!;
    let from: number, insert: string;
    if (typed === '"' || typed === '\'') {
        const previous = before.at(-2);
        const opening = previous === undefined || /[\s([{—–]/u.test(previous);
        if (typed === '"') insert = opening ? '“' : '”';
        else insert = opening ? '‘' : '’';
        from = at - 1;
    } else {
        const rule = TYPOGRAPHY.find(item => before.endsWith(item.pattern) && (!item.wordStart || !/[\p{L}\p{N}]/u.test(before.charAt(before.length - item.pattern.length - 1))));
        if (!rule) return null;
        insert = rule.insert; from = at - rule.pattern.length;
    }
    const replaceFrom = start + from;
    if (!textBoundaries.isBoundary(text, replaceFrom) || !textBoundaries.isBoundary(text, caret)) return null;
    return { transaction: transaction(id, key, replaceFrom, caret, { blocks: [{ kind: 'p', level: 0, dir: 'auto', runs: [{ text: insert, marks }] }] }),
        caret: replaceFrom + insert.length };
}
