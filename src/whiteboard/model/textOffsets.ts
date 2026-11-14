import type { Block, RichText } from '../text/richText';
import { isGraphemeBoundary } from '../text/graphemes';

// R-W18/R-W21: temporary O(existing runs), allocation-free projection lookup.
// TX-2 replaces these scans with its cached lengths/offsets; TX-1 adds the owed
// grapheme-boundary check. Never build a whole plain-text string for validation.
export function scanText(text: RichText | null, offset = -1): number {
    if (text === null) return offset < 0 ? 0 : NaN;
    let position = 0;
    for (let b = 0; b < text.blocks.length; b++) {
        const runs = text.blocks[b].runs;
        for (let r = 0; r < runs.length; r++) {
            const value = runs[r].text;
            if (offset >= position && offset < position + value.length) return value.charCodeAt(offset - position);
            position += value.length;
        }
        if (b + 1 < text.blocks.length) {
            if (offset === position) return 10;
            position++;
        }
    }
    return offset < 0 ? position : NaN;
}

export function blockTextLength(block: Block): number {
    let length = 0;
    for (let i = 0; i < block.runs.length; i++) length += block.runs[i].text.length;
    return length;
}

export function isBlockRange(text: RichText | null, from: number, to: number): boolean {
    if (text === null) return from === 0 && to === 0;
    let position = 0;
    let starts = false;
    for (let i = 0; i < text.blocks.length; i++) {
        if (position === from) starts = true;
        position += blockTextLength(text.blocks[i]);
        if (position === to && starts) return true;
        position++;
    }
    return false;
}

export function spliceBlockCount(text: RichText | null, from: number, to: number, inserted: number): number {
    if (text === null) return inserted;
    let position = 0;
    let removed = 0;
    for (let i = 0; i + 1 < text.blocks.length; i++) {
        position += blockTextLength(text.blocks[i]);
        if (position >= from && position < to) removed++;
        position++;
    }
    return text.blocks.length - removed + inserted - 1;
}

const blockProjection = new WeakMap<Block, string>();

/** Runs may split a grapheme; segment the complete immutable block, not each run. */
export function isTextGraphemeBoundary(text: RichText | null, offset: number): boolean {
    if (!text) return offset === 0;
    let position = 0;
    for (const block of text.blocks) {
        const length = blockTextLength(block);
        if (offset <= position + length) {
            let plain = blockProjection.get(block);
            if (plain === undefined) { plain = block.runs.map(run => run.text).join(''); blockProjection.set(block, plain); }
            return isGraphemeBoundary(plain, offset - position);
        }
        position += length + 1;
    }
    return false;
}

export function isSurrogateBoundary(text: RichText | null, offset: number): boolean {
    if (offset === 0) return true;
    const before = scanText(text, offset - 1);
    if (before < 0xd800 || before > 0xdbff || Number.isNaN(before)) return true;
    const after = scanText(text, offset);
    return after < 0xdc00 || after > 0xdfff || Number.isNaN(after);
}
