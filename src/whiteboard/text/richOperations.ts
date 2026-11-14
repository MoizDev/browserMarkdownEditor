import { textBoundaries } from './boundaries';
import { projectionLength as indexedLength, projectionPosition, projectionText } from './projection';
import { normalizePlainInsertion } from './plainText';
import { normalizeRichText, sliceRichText, spliceRichText, type Block, type Marks, type RichFragment, type RichText } from './richText';
import type { RichEdit, RichMark, RichSelection, RichTextOperations } from './rich';
import { trackBlock, trackRun } from './carriers';
import { runContaining, runIndex } from './runIndex';

const position = projectionPosition;
const blockTextLength = (block: Block): number => runIndex(block).length;
function check(text: RichText, from: number, to = from): void {
    if (to < from || !textBoundaries.isBoundary(text, from) || !textBoundaries.isBoundary(text, to))
        throw new RangeError('Text range must have grapheme boundaries');
}
function withoutStart(block: Block): Block {
    // The native tuple's dormant start slot remains attached to an opaque future tail.
    if (block.tail !== undefined && block.tail !== '[]') return block;
    const { start: _start, ...rest } = block;
    return rest;
}
function insertionBlock(block: Block): Block {
    const { tail: _tail, carriers: _carriers, ...rest } = block;
    return rest;
}
function continuation(block: Block): Block {
    const { start: _start, tail: _tail, carriers: _carriers, ...rest } = block;
    return rest;
}
export function plain(value: RichText): string {
    return projectionText(value);
}
export function fromPlain(value: string): RichText {
    const lines = normalizePlainInsertion(value).split('\n');
    return { blocks: lines.map(text => ({ kind: 'p', level: 0, dir: 'auto', runs: [{ text, marks: {} }] })) };
}
export function marksAt(value: RichText, offset: number): Marks {
    check(value, offset);
    const { block, offset: local } = position(value, offset);
    const indexed = runIndex(block);
    if (!indexed.count) return {};
    const i = indexed.length ? runContaining(indexed, local ? local - 1 : 0) : indexed.count - 1;
    const run = block.runs[i], end = indexed.starts[i + 1];
    const { x: _x, link, ...marks } = run.marks;
    if (!link) return marks;
    if (local < end) return { ...marks, link };
    // Formatting may split one link into adjacent runs; only its true end stops extension.
    for (let next = i + 1; next < block.runs.length; next++) {
        if (!block.runs[next].text.length) continue;
        return block.runs[next].marks.link === link ? { ...marks, link } : marks;
    }
    return marks;
}
export function linkRangeAt(value: RichText, offset: number): { readonly from: number; readonly to: number; readonly url: string } | null {
    check(value, offset);
    const found = position(value, offset), runs = found.block.runs, indexed = runIndex(found.block);
    if (!indexed.length) return null;
    const chosen = runContaining(indexed, found.offset ? found.offset - 1 : 0);
    if (!runs[chosen].marks.link) return null;
    const url = runs[chosen].marks.link!;
    let first = chosen, last = chosen;
    while (first > 0 && (!runs[first - 1].text.length || runs[first - 1].marks.link === url)) first--;
    while (last + 1 < runs.length && (!runs[last + 1].text.length || runs[last + 1].marks.link === url)) last++;
    const from = found.start + indexed.starts[first], to = found.start + indexed.starts[last + 1];
    return from < to && textBoundaries.isBoundary(value, from) && textBoundaries.isBoundary(value, to) ? { from, to, url } : null;
}
export function insertionFragment(value: RichText, from: number, inserted: string, storedMarks: Marks | null): RichFragment {
    check(value, from);
    const { block } = position(value, from);
    const marks = storedMarks ?? marksAt(value, from);
    const lines = normalizePlainInsertion(inserted).split('\n');
    return { blocks: lines.map((text, index) => ({ ...(index === 0 ? insertionBlock(block) : continuation(block)), runs: [{ text, marks }] })) };
}
function mapMarks(value: RichText, from: number, to: number, map: (marks: Marks) => Marks): RichFragment {
    check(value, from, to);
    const fragment = sliceRichText(value, from, to, true);
    return normalizeRichText({ blocks: fragment.blocks.map(block => trackBlock({ ...block, runs: block.runs.map(run => trackRun({ ...run, marks: map(run.marks) }, run)) }, block)) });
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
        if (url.length > 2048 || /\p{Cc}/u.test(url)) throw new RangeError('Invalid link');
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
    const insert: RichText = { blocks: [{ ...insertionBlock(block), runs: [{ text: '', marks }] }, { ...next, runs: [{ text: '', marks }] }] };
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
function checkedSplice(value: RichText, from: number, to: number, insert: RichFragment, wholeBlocks = false) {
    check(value, from, to);
    return spliceRichText(value, from, to, insert, wholeBlocks);
}
export const richTextOperations: RichTextOperations = { plain, fromPlain, normalize: normalizeRichText, splice: checkedSplice, marksAt, insertionFragment, toggleMark, applyLink, enter, blocks };
export function projectionLength(text: RichText): number { return indexedLength(text); }
