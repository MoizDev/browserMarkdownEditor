import type { RichText } from '../richText';
import { projectionLength, projectionPosition, projectionSlice } from '../projection';

// TX-5: EditContext and the fallback sink use UTF-16 offsets into the same
// projection. A long selection must fit in its entirety: truncating it would
// make the next IME replacement delete a different range than the user chose.
export interface TextWindow {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

const WINDOW_THRESHOLD = 20_000;
const WINDOW_RADIUS = 8_000;
const RECENTER_MARGIN = 4_000;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function safeStart(text: string, offset: number): number {
    if (offset <= 0 || offset >= text.length) return offset;
    return graphemes.segment(text).containing(offset)?.index ?? offset;
}

function safeEnd(text: string, offset: number): number {
    if (offset <= 0 || offset >= text.length) return offset;
    const segment = graphemes.segment(text).containing(offset);
    return !segment || segment.index === offset ? offset : segment.index + segment.segment.length;
}

export function textWindow(text: string, anchor: number, focus: number, previous?: TextWindow): TextWindow {
    const low = Math.max(0, Math.min(text.length, Math.min(anchor, focus)));
    const high = Math.max(low, Math.min(text.length, Math.max(anchor, focus)));
    if (text.length <= WINDOW_THRESHOLD) return { start: 0, end: text.length, text };
    if (previous && low >= previous.start + RECENTER_MARGIN && high <= previous.end - RECENTER_MARGIN
        && previous.end <= text.length && text.slice(previous.start, previous.end) === previous.text) return previous;
    const start = safeStart(text, Math.max(0, low - WINDOW_RADIUS));
    const end = safeEnd(text, Math.min(text.length, high + WINDOW_RADIUS));
    return { start, end, text: text.slice(start, end) };
}

// Read only the active window, not a million-character projection on every
// input. Block and run strings remain the immutable model's own strings.
export function richTextWindow(rich: RichText, anchor: number, focus: number, previous?: TextWindow): TextWindow {
    const total = projectionLength(rich);
    const low = Math.max(0, Math.min(total, Math.min(anchor, focus)));
    const high = Math.max(low, Math.min(total, Math.max(anchor, focus)));
    const slice = (from: number, to: number) => projectionSlice(rich, from, to);
    const boundary = (offset: number, end: boolean): number => {
        const found = projectionPosition(rich, offset), block = found.block;
        const value = block.runs.length === 1 ? block.runs[0].text : block.runs.map(run => run.text).join('');
        return found.start + (end ? safeEnd(value, found.offset) : safeStart(value, found.offset));
    };
    if (total <= WINDOW_THRESHOLD) return { start: 0, end: total, text: slice(0, total) };
    if (previous && low >= previous.start + RECENTER_MARGIN && high <= previous.end - RECENTER_MARGIN
        && previous.end <= total && slice(previous.start, previous.end) === previous.text) return previous;
    const start = boundary(Math.max(0, low - WINDOW_RADIUS), false);
    const end = boundary(Math.min(total, high + WINDOW_RADIUS), true);
    return { start, end, text: slice(start, end) };
}
