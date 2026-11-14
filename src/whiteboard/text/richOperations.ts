import { isTextGraphemeBoundary, blockTextLength, scanText } from '../model/textOffsets';
import { MAX_TEXT_BLOCKS, MAX_TEXT_LENGTH } from '../model/textLimits';
import { normalizeRichText, sliceRichText, spliceRichText, type Block, type Marks, type RichFragment, type RichText } from './richText';
import type { RichEdit, RichMark, RichSelection, RichTextOperations } from './rich';

interface Position { readonly block: Block; readonly index: number; readonly start: number; readonly offset: number }
function position(text: RichText, offset: number): Position {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid text offset');
    let start = 0;
    for (let index = 0; index < text.blocks.length; index++) {
        const block = text.blocks[index], length = blockTextLength(block);
        if (offset <= start + length) return { block, index, start, offset: offset - start };
        start += length + 1;
    }
    throw new RangeError('Text offset exceeds projection');
}
function check(text: RichText, from: number, to = from): void {
    if (to < from || !isTextGraphemeBoundary(text, from) || !isTextGraphemeBoundary(text, to))
        throw new RangeError('Text range must have grapheme boundaries');
}
function withoutStart(block: Block): Block {
    const { start: _start, ...rest } = block;
    return rest;
}
function continuation(block: Block): Block {
    const { start: _start, tail: _tail, ...rest } = block;
    return rest;
}
export function plain(value: RichText): string {
    return value.blocks.map(block => block.runs.map(run => run.text).join('')).join('\n');
}
export function fromPlain(value: string): RichText {
    const lines = value.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > MAX_TEXT_BLOCKS || value.length > MAX_TEXT_LENGTH) throw new RangeError('Rich text exceeds limits');
    return { blocks: lines.map(text => ({ kind: 'p', level: 0, dir: 'auto', runs: [{ text, marks: {} }] })) };
}
export function marksAt(value: RichText, offset: number): Marks {
    check(value, offset);
    const { block, offset: local } = position(value, offset);
    let at = 0;
    for (let i = 0; i < block.runs.length; i++) {
        const run = block.runs[i], end = at + run.text.length;
        if (local < end || (local === end && (i === block.runs.length - 1 || end > at))) {
            const { x: _x, link, ...marks } = run.marks;
            return link && local < end ? { ...marks, link } : marks;
        }
        at = end;
    }
    return {};
}
export function insertionFragment(value: RichText, from: number, inserted: string, storedMarks: Marks | null): RichFragment {
    check(value, from);
    const { block } = position(value, from);
    const marks = storedMarks ?? marksAt(value, from);
    const lines = inserted.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > MAX_TEXT_BLOCKS || inserted.length > MAX_TEXT_LENGTH) throw new RangeError('Rich text exceeds limits');
    return { blocks: lines.map((text, index) => ({ ...(index === 0 ? block : continuation(block)), runs: [{ text, marks }] })) };
}
function mapMarks(value: RichText, from: number, to: number, map: (marks: Marks) => Marks): RichFragment {
    check(value, from, to);
    const fragment = sliceRichText(value, from, to);
    return normalizeRichText({ blocks: fragment.blocks.map(block => ({ ...block, runs: block.runs.map(run => ({ ...run, marks: map(run.marks) })) })) });
}
export function toggleMark(value: RichText, from: number, to: number, mark: RichMark): RichFragment {
    check(value, from, to);
    const fragment = sliceRichText(value, from, to);
    const runs = fragment.blocks.flatMap(block => block.runs).filter(run => run.text.length > 0);
    const remove = runs.length > 0 && runs.every(run => run.marks[mark] === true);
    return mapMarks(value, from, to, marks => {
        const next = { ...marks };
        if (remove) delete next[mark]; else next[mark] = true;
        return next;
    });
}
export function applyLink(value: RichText, from: number, to: number, url: string | null): RichFragment {
    if (url !== null) {
        if (url.length > 2048 || Array.from(url).some(char => {
            const code = char.charCodeAt(0);
            return code <= 31 || (code >= 127 && code <= 159);
        })) throw new RangeError('Invalid link');
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new RangeError('Invalid link'); }
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new RangeError('Invalid link');
    }
    return mapMarks(value, from, to, marks => {
        const next = { ...marks };
        if (url === null) delete next.link; else next.link = url;
        return next;
    });
}
export function enter(value: RichText, selection: RichSelection): RichEdit {
    const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
    check(value, from, to);
    const found = position(value, from), block = found.block;
    if (from === to && (block.kind === 'ul' || block.kind === 'ol') && blockTextLength(block) === 0) {
        const replacement = { ...withoutStart(block), kind: 'p' as const, level: 0 };
        return { from: found.start, to: found.start, insert: normalizeRichText({ blocks: [replacement] }), selection: { anchor: from, focus: from }, replaceBlocks: true };
    }
    const next = continuation(block);
    const marks = marksAt(value, from);
    const insert: RichText = { blocks: [{ ...block, runs: [{ text: '', marks }] }, { ...next, runs: [{ text: '', marks }] }] };
    return { from, to, insert, selection: { anchor: from + 1, focus: from + 1 } };
}
export function blocks(value: RichText, from: number, to: number, kind: Block['kind'] | 'indent' | 'outdent'): RichEdit {
    check(value, from, to);
    const first = position(value, from), last = position(value, to);
    // A selection ending at the start of the next block does not include it.
    const lastIndex = to > from && last.offset === 0 ? Math.max(first.index, last.index - 1) : last.index;
    const selected = value.blocks.slice(first.index, lastIndex + 1);
    const end = first.start + selected.reduce((sum, block) => sum + blockTextLength(block), 0) + selected.length - 1;
    const effective = (kind === 'ul' || kind === 'ol') && selected.every(block => block.kind === kind) ? 'p' : kind;
    const changed = selected.map(block => {
        if (effective === 'indent' || effective === 'outdent') {
            if (block.kind !== 'ul' && block.kind !== 'ol') return block;
            return { ...block, level: Math.min(7, Math.max(0, block.level + (effective === 'indent' ? 1 : -1))) };
        }
        const clean = effective === 'ol' ? block : withoutStart(block);
        return { ...clean, kind: effective, level: effective === 'ul' || effective === 'ol' ? block.level : 0 };
    });
    return { from: first.start, to: end, insert: normalizeRichText({ blocks: changed }), selection: { anchor: from, focus: to }, replaceBlocks: true };
}
export const richTextOperations: RichTextOperations = { plain, fromPlain, normalize: normalizeRichText, splice: spliceRichText, marksAt, insertionFragment, toggleMark, applyLink, enter, blocks };
export function projectionLength(text: RichText): number { return scanText(text); }
