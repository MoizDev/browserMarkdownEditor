import type { EditSelection } from './host';

const words = new Intl.Segmenter(undefined, { granularity: 'word' });

export function selectWord(text: string, offset: number): EditSelection {
    if (!text.length) return { anchor: 0, focus: 0 };
    const position = Math.max(0, Math.min(text.length - 1, offset));
    const part = words.segment(text).containing(position);
    return part ? { anchor: part.index, focus: part.index + part.segment.length } : { anchor: position, focus: position };
}

export function selectBlock(text: string, offset: number): EditSelection {
    const position = Math.max(0, Math.min(text.length, offset));
    const before = text.lastIndexOf('\n', position - 1);
    const after = text.indexOf('\n', position);
    return { anchor: before + 1, focus: after < 0 ? text.length : after };
}

export function wordBoundary(text: string, offset: number, direction: -1 | 1): number {
    const segments = words.segment(text);
    const position = Math.max(0, Math.min(text.length, offset));
    if (direction < 0) {
        if (!position) return 0;
        let part = segments.containing(position - 1);
        while (part && !part.isWordLike && part.index > 0) part = segments.containing(part.index - 1);
        return part?.index ?? 0;
    }
    if (position === text.length) return position;
    let part = segments.containing(position);
    while (part && !part.isWordLike && part.index + part.segment.length < text.length) part = segments.containing(part.index + part.segment.length);
    return part ? part.index + part.segment.length : text.length;
}
