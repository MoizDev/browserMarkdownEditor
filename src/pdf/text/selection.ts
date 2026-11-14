export interface TextPoint { page: number; offset: number; affinity: 'before' | 'after' }
export interface PdfSelection {
    anchor: TextPoint;
    focus: TextPoint;
    granularity: 'char' | 'word' | 'line';
    wholeDocument: boolean;
    docKey: string;
}
export interface TextRange { start: TextPoint; end: TextPoint }

export function compareTextPoints(a: TextPoint, b: TextPoint): number {
    return a.page - b.page || a.offset - b.offset;
}
/** Half-open in physical-page and canonical UTF-16 order, in either drag direction. */
export function selectionRange(selection: PdfSelection): TextRange {
    return compareTextPoints(selection.anchor, selection.focus) <= 0
        ? { start: selection.anchor, end: selection.focus }
        : { start: selection.focus, end: selection.anchor };
}
export function selectionContains(selection: PdfSelection, point: TextPoint): boolean {
    const { start, end } = selectionRange(selection);
    return compareTextPoints(start, point) <= 0 && compareTextPoints(point, end) < 0;
}
export function pointForCharacter(page: number, charU16: Uint32Array, index: number, side: 'before' | 'after', text: string): TextPoint {
    const i = Math.max(0, Math.min(charU16.length - 1, Math.trunc(index)));
    const start = Math.min(text.length, charU16[i]);
    const cp = text.codePointAt(start);
    const units = cp === undefined ? 0 : cp > 0xffff ? 2 : 1;
    return { page, offset: side === 'after' ? Math.min(text.length, start + units) : start, affinity: side };
}
/** A Unicode word/non-word segment containing the offset in one canonical line. */
export function wordRange(text: string, lineFrom: number, lineTo: number, offset: number, locale?: string): { from: number; to: number } {
    const from = Math.max(0, Math.min(text.length, Math.trunc(lineFrom)));
    const to = Math.max(from, Math.min(text.length, Math.trunc(lineTo)));
    if (from === to) return { from, to };
    const at = Math.max(from, Math.min(to - 1, Math.trunc(offset)));
    const slice = text.slice(from, to);
    try {
        const segments = new Intl.Segmenter(locale, { granularity: 'word' }).segment(slice);
        const segment = segments.containing(at - from);
        if (segment) return { from: from + segment.index, to: from + segment.index + segment.segment.length };
    } catch { /* Conservative fallback preserves the source text. */ }
    const codepoint = text.codePointAt(at);
    const start = at > from && /[\uDC00-\uDFFF]/u.test(text[at]) && /[\uD800-\uDBFF]/u.test(text[at - 1]) ? at - 1 : at;
    return { from: start, to: Math.min(to, start + (codepoint !== undefined && codepoint > 0xffff ? 2 : 1)) };
}
export function lineRange(charU16: Uint32Array, lines: Uint32Array, line: number): { from: number; to: number } | undefined {
    const first = lines[line * 2], end = lines[line * 2 + 1];
    if (first === undefined || end === undefined || charU16[first] === undefined || charU16[end] === undefined) return undefined;
    return { from: charU16[first], to: charU16[end] };
}
