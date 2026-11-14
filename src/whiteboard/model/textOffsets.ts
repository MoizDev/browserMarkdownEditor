import type { RichText } from '../text/richText';

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

export function isSurrogateBoundary(text: RichText | null, offset: number): boolean {
    if (offset === 0) return true;
    const before = scanText(text, offset - 1);
    if (before < 0xd800 || before > 0xdbff || Number.isNaN(before)) return true;
    const after = scanText(text, offset);
    return after < 0xdc00 || after > 0xdfff || Number.isNaN(after);
}
