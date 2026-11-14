import { isGraphemeBoundary } from '../graphemes';

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

function safeStart(text: string, offset: number): number {
    while (offset > 0 && !isGraphemeBoundary(text, offset)) offset--;
    return offset;
}

function safeEnd(text: string, offset: number): number {
    while (offset < text.length && !isGraphemeBoundary(text, offset)) offset++;
    return offset;
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
