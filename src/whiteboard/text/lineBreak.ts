import { unicodeProperty } from './unicode';

export interface LineBreakOpportunity { readonly offset: number; readonly mandatory: boolean }
interface Unit { cp: number; start: number; end: number; cls: string; category: string; east: boolean; pict: boolean; sa: boolean; endsWithZwj: boolean }
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const is = (value: string, ...classes: string[]) => classes.includes(value);

/** UAX #14 default opportunities in UTF-16. Dictionary mode tailors SA using ICU words. */
export function lineBreaks(text: string, dictionary = true): LineBreakOpportunity[] {
    const units: Unit[] = [];
    let offset = 0;
    for (const char of text) {
        const cp = char.codePointAt(0)!;
        const original = unicodeProperty('lineBreak', cp);
        const category = unicodeProperty('category', cp);
        let cls = original;
        if (is(cls, 'AI', 'SG', 'XX')) cls = 'AL';
        else if (cls === 'CJ') cls = 'NS';
        else if (cls === 'SA') cls = is(category, 'Mn', 'Mc') ? 'CM' : 'AL';
        const end = offset + char.length;
        const previous = units[units.length - 1];
        if (is(cls, 'CM', 'ZWJ') && previous && !is(previous.cls, 'BK', 'CR', 'LF', 'NL', 'SP', 'ZW')) {
            previous.end = end;
            previous.endsWithZwj = cls === 'ZWJ';
        } else {
            if (is(cls, 'CM', 'ZWJ')) cls = 'AL';
            units.push({ cp, start: offset, end, cls, category, east: is(unicodeProperty('eastAsianWidth', cp), 'F', 'W', 'H'), pict: unicodeProperty('extendedPictographic', cp) === 'Y', sa: original === 'SA', endsWithZwj: original === 'ZWJ' });
        }
        offset = end;
    }
    const words = new Set<number>();
    if (dictionary) for (const segment of wordSegmenter.segment(text)) words.add(segment.index);
    const result: LineBreakOpportunity[] = [];
    const prevNonSpace: number[] = [], numeric: boolean[] = [], regional: number[] = [];
    for (let i = 0; i < units.length; i++) {
        const c = units[i].cls;
        prevNonSpace[i] = c === 'SP' ? (i ? prevNonSpace[i - 1] : -1) : i;
        numeric[i] = c === 'NU' || (is(c, 'SY', 'IS') && i > 0 && numeric[i - 1]);
        regional[i] = c === 'RI' ? 1 + (i ? regional[i - 1] : 0) : 0;
    }
    for (let i = 1; i < units.length; i++) {
        const a = units[i - 1], b = units[i], p = units[i - 2], n = units[i + 1];
        const beforeSpaces = units[prevNonSpace[i - 1]];
        const beforeQuote = beforeSpaces && units[prevNonSpace[i - 1] - 1];
        const A = a.cls, B = b.cls, P = p?.cls, N = n?.cls, S = beforeSpaces?.cls;
        let allow = false, mandatory = false;
        if (A === 'CR' && B === 'LF') { /* LB5 */ }
        else if (is(A, 'BK', 'CR', 'LF', 'NL')) { allow = true; mandatory = true; }
        else if (is(B, 'BK', 'CR', 'LF', 'NL', 'SP', 'ZW')) { /* LB6/7 */ }
        else if (S === 'ZW') allow = true;
        else if (a.endsWithZwj) { /* LB8a */ }
        else if (A === 'WJ' || B === 'WJ' || A === 'GL') { /* LB11/12 */ }
        else if (B === 'GL' && !is(A, 'SP', 'BA', 'HY', 'HH')) { /* LB12a */ }
        else if (is(B, 'CL', 'CP', 'EX', 'SY')) { /* LB13 */ }
        else if (S === 'OP') { /* LB14 */ }
        else if (S === 'QU' && beforeSpaces.category === 'Pi' && (!beforeQuote || is(beforeQuote.cls, 'BK', 'CR', 'LF', 'NL', 'OP', 'QU', 'GL', 'SP', 'ZW'))) { /* LB15a */ }
        else if (B === 'QU' && b.category === 'Pf' && (!n || is(N, 'SP', 'GL', 'WJ', 'CL', 'QU', 'CP', 'EX', 'IS', 'SY', 'BK', 'CR', 'LF', 'NL', 'ZW'))) { /* LB15b */ }
        else if (A === 'SP' && B === 'IS' && N === 'NU') allow = true;
        else if (B === 'IS') { /* LB15d */ }
        else if (is(S, 'CL', 'CP') && B === 'NS') { /* LB16 */ }
        else if (S === 'B2' && B === 'B2') { /* LB17 */ }
        else if (A === 'SP') allow = true;
        else if ((B === 'QU' && b.category !== 'Pi') || (A === 'QU' && a.category !== 'Pf')) { /* LB19 */ }
        else if ((B === 'QU' && (!a.east || !n?.east)) || (A === 'QU' && (!b.east || !p?.east))) { /* LB19a */ }
        else if (A === 'CB' || B === 'CB') allow = true;
        else if (is(A, 'HY', 'HH') && is(B, 'AL', 'HL') && (!p || is(P, 'BK', 'CR', 'LF', 'NL', 'SP', 'ZW', 'CB', 'GL'))) { /* LB20a */ }
        else if (is(B, 'BA', 'HH', 'HY', 'NS') || A === 'BB') { /* LB21 */ }
        else if (P === 'HL' && is(A, 'HY', 'HH') && B !== 'HL') { /* LB21a */ }
        else if (A === 'SY' && B === 'HL') { /* LB21b */ }
        else if (B === 'IN') { /* LB22 */ }
        else if ((is(A, 'AL', 'HL') && B === 'NU') || (A === 'NU' && is(B, 'AL', 'HL'))) { /* LB23 */ }
        else if ((A === 'PR' && is(B, 'ID', 'EB', 'EM')) || (is(A, 'ID', 'EB', 'EM') && B === 'PO')) { /* LB23a */ }
        else if ((is(A, 'PR', 'PO') && is(B, 'AL', 'HL')) || (is(A, 'AL', 'HL') && is(B, 'PR', 'PO'))) { /* LB24 */ }
        else if ((is(B, 'PO', 'PR') && (numeric[i - 1] || (is(A, 'CL', 'CP') && i >= 2 && numeric[i - 2]))) || (is(A, 'PO', 'PR') && (B === 'NU' || (B === 'OP' && (N === 'NU' || (N === 'IS' && units[i + 2]?.cls === 'NU'))))) || (is(A, 'HY', 'IS') && B === 'NU') || (numeric[i - 1] && B === 'NU')) { /* LB25 */ }
        else if ((A === 'JL' && is(B, 'JL', 'JV', 'H2', 'H3')) || (is(A, 'JV', 'H2') && is(B, 'JV', 'JT')) || (is(A, 'JT', 'H3') && B === 'JT')) { /* LB26 */ }
        else if ((is(A, 'JL', 'JV', 'JT', 'H2', 'H3') && B === 'PO') || (A === 'PR' && is(B, 'JL', 'JV', 'JT', 'H2', 'H3'))) { /* LB27 */ }
        else if (is(A, 'AL', 'HL') && is(B, 'AL', 'HL')) allow = dictionary && a.sa && b.sa && words.has(b.start);
        else if ((A === 'AP' && (is(B, 'AK', 'AS') || b.cp === 0x25cc)) || ((is(A, 'AK', 'AS') || a.cp === 0x25cc) && is(B, 'VF', 'VI')) || (A === 'VI' && p && (is(P, 'AK', 'AS') || p.cp === 0x25cc) && (B === 'AK' || b.cp === 0x25cc)) || ((is(A, 'AK', 'AS') || a.cp === 0x25cc) && (is(B, 'AK', 'AS') || b.cp === 0x25cc) && N === 'VF')) { /* LB28a */ }
        else if (A === 'IS' && is(B, 'AL', 'HL')) { /* LB29 */ }
        else if ((is(A, 'AL', 'HL', 'NU') && B === 'OP' && !b.east) || (A === 'CP' && !a.east && is(B, 'AL', 'HL', 'NU'))) { /* LB30 */ }
        else if (A === 'RI' && B === 'RI' && regional[i - 1] % 2 === 1) { /* LB30a */ }
        else if ((A === 'EB' || (a.pict && a.category === 'Cn')) && B === 'EM') { /* LB30b */ }
        else allow = true;
        if (allow) result.push({ offset: b.start, mandatory });
    }
    result.push({ offset: text.length, mandatory: true });
    return result;
}
