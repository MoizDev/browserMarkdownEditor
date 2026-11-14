// Offsets in the text model are UTF-16, as are the indices returned by Segmenter.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** All grapheme boundaries, including both endpoints, in ascending UTF-16 order. */
export function graphemeBoundaries(text: string): number[] {
    const result = [0];
    for (const segment of segmenter.segment(text)) {
        if (segment.index !== 0) result.push(segment.index);
    }
    if (text.length !== 0) result.push(text.length);
    return result;
}

/** Whether an offset is safe for a text splice or caret stop. */
export function isGraphemeBoundary(text: string, offset: number): boolean {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
    if (offset === 0 || offset === text.length) return true;
    return segmenter.segment(text).containing(offset)?.index === offset;
}
