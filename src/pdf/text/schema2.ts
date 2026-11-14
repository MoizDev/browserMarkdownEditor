import type { PdfSemanticRole } from '../../utils/pdfPageText';
import { GENERATED, INVISIBLE, LINE_HYPHEN, UNICODE_ERROR, boxAt, character, differentLine, strongRtl, validBox } from './types';
import type { RawPageText, Schema2Geometry, Schema2Interval, Schema2Projection } from './types';

/** Canonical text follows PDFium character order, never a visual re-sort. */
export function buildPdfiumPageText(raw: RawPageText, geometry: Schema2Geometry): Schema2Projection {
    const parts: string[] = [], intervals: Schema2Interval[] = [], tokenBreaks: number[] = [];
    const charU16 = new Uint32Array(raw.n + 1), reasons = new Set<string>();
    const roles = new Map<number, number>();
    raw.struct?.mcids.forEach((id, i) => roles.set(id, raw.struct!.roles[i]));
    let length = 0, itemIndex = 0, previousLineChar = -1;
    let current: { first: number; object: number; text: string; box: number[]; role: PdfSemanticRole; dir: string; transform: number[]; fontName: string; ids: string[] } | undefined;
    let previousItem: { x: number; y: number; width: number; height: number } | undefined;
    const append = (s: string) => { parts.push(s); length += s.length; };
    const flush = () => {
        if (!current) return;
        const c = current, width = Math.max(0, c.box[2] - c.box[0]), height = Math.max(0, c.box[3] - c.box[1]);
        if (previousItem) {
            const dx = c.transform[4] - previousItem.x, dy = c.transform[5] - previousItem.y;
            if (dy < -Math.max(height, previousItem.height, 1) * 2 || (Math.abs(dy) < 2 && dx < -Math.max(previousItem.width, 30)))
                reasons.add('Possible columns or non-linear reading order; compare the original.');
        }
        const last = parts.at(-1) ?? '';
        if (length && c.text && !/\s$/u.test(last) && !/^\s/u.test(c.text)) tokenBreaks.push(length);
        const from = length;
        append(c.text);
        let rtl = 0, ltr = 0;
        for (const ch of c.text) if (/\p{Letter}/u.test(ch)) { if (strongRtl(ch.codePointAt(0)!)) rtl++; else ltr++; }
        const direction = c.dir === 'ttb' ? 'ttb' : rtl > ltr ? 'rtl' : 'ltr';
        intervals.push({ from, to: length, itemIndex: itemIndex++, syntheticLF: false, syntheticSpace: false,
            charStart: c.first, transform: c.transform, width, height, dir: direction, fontName: c.fontName,
            markedContentIds: c.ids, role: c.role });
        previousItem = { x: c.transform[4], y: c.transform[5], width, height };
        current = undefined;
    };
    const synthetic = (s: string, lf: boolean) => {
        flush();
        const last = intervals.at(-1);
        const from = length;
        append(s);
        intervals.push({ from, to: length, itemIndex: itemIndex++, syntheticLF: lf, syntheticSpace: !lf,
            transform: last?.transform ?? [1, 0, 0, 1, 0, 0], width: 0, height: 0,
            dir: last?.dir ?? 'ltr', fontName: last?.fontName ?? '', markedContentIds: last?.markedContentIds ?? [], role: last?.role ?? 'prose' });
    };
    for (let i = 0; i < raw.n; i++) {
        const flags = raw.flags[i], cp = raw.codepoints[i], generated = !!(flags & GENERATED);
        if (flags & INVISIBLE) reasons.add('Includes invisible text (likely OCR); highlights may not match the image.');
        if (flags & UNICODE_ERROR || !cp) reasons.add('Encoding may be incomplete or incorrect.');
        if (generated && (cp === 13 || cp === 10)) {
            flush(); charU16[i] = length;
            if (!(cp === 10 && i > 0 && (raw.flags[i - 1] & GENERATED) && raw.codepoints[i - 1] === 13)) synthetic('\n', true);
            previousLineChar = -1;
            continue;
        }
        if (generated && cp === 32) {
            flush(); charU16[i] = length; synthetic(' ', false); previousLineChar = -1; continue;
        }
        const obj = raw.object[i], box = boxAt(raw, i), size = Math.max(0, raw.fontSize[i] || 0);
        const a = raw.matrix[i * 4], b = raw.matrix[i * 4 + 1], c = raw.matrix[i * 4 + 2], d = raw.matrix[i * 4 + 3];
        const angle = Math.atan2(b, a), rotated = Math.abs(Math.sin(angle)) > Math.sin(5 * Math.PI / 180);
        if (previousLineChar >= 0 && differentLine(raw, previousLineChar, i)) { flush(); previousLineChar = -1; }
        if (!generated && previousLineChar >= 0 && rotated) {
            const prevBox = boxAt(raw, previousLineChar), dx = Math.cos(angle), dy = Math.sin(angle);
            if (validBox(prevBox) && validBox(box)) {
                const edges = (r: readonly number[]) => [r[0] * dx + r[1] * dy, r[0] * dx + r[3] * dy, r[2] * dx + r[1] * dy, r[2] * dx + r[3] * dy];
                const before = edges(prevBox), after = edges(box);
                if (Math.min(...after) - Math.max(...before) > size * .3) synthetic(' ', false);
            }
        }
        const code = flags & LINE_HYPHEN ? '-' : character(cp);
        const mcid = obj >= 0 ? raw.objects.mcid[obj] : -1;
        const tag = roles.get(mcid), taggedRole: PdfSemanticRole = tag === 1 ? 'code' : tag === 2 ? 'formula' : 'prose';
        const vertical = Math.abs(Math.cos(angle)) <= Math.sin(20 * Math.PI / 180);
        const ambiguous = vertical || Math.abs(b) > Math.abs(a) * .2;
        if (ambiguous) reasons.add('Rotated or vertical text keeps PDF content order.');
        const role: PdfSemanticRole = ambiguous ? 'ambiguous' : taggedRole;
        const dir = vertical ? 'ttb' : strongRtl(cp) ? 'rtl' : 'ltr';
        if (current && (current.object !== obj || generated || current.role !== role)) flush();
        charU16[i] = length + (current?.text.length ?? 0);
        if (!current) {
            const font = obj >= 0 ? raw.objects.font[obj] : -1;
            current = { first: i, object: obj, text: '', box: validBox(box) ? [...box] : [0, 0, 0, 0], role, dir,
                transform: [a * size, b * size, c * size, d * size, raw.origin[i * 2], raw.origin[i * 2 + 1]],
                fontName: raw.fontNames[font] ?? '', ids: mcid >= 0 ? [String(mcid)] : [] };
        } else if (validBox(box)) {
            if (!validBox(current.box)) current.box = [...box];
            else { current.box[0] = Math.min(current.box[0], box[0]); current.box[1] = Math.min(current.box[1], box[1]); current.box[2] = Math.max(current.box[2], box[2]); current.box[3] = Math.max(current.box[3], box[3]); }
        }
        current.text += code;
        previousLineChar = i;
        if (flags & LINE_HYPHEN) { synthetic('\n', true); previousLineChar = -1; }
    }
    flush(); charU16[raw.n] = length;
    if (raw.truncated) reasons.add('Text extraction was truncated because this page exceeds the character limit.');
    const text = parts.join('');
    if ([...reasons].some(reason => reason.startsWith('Possible columns'))) {
        for (const interval of intervals) if (interval.role === 'prose') interval.role = 'ambiguous';
    }
    if (!text.trim()) reasons.add('No selectable text on this page. Images, blank pages and scans can have no text. OCR is not provided.');
    if (tokenBreaks.length) reasons.add('PDF item boundaries are preserved; missing spaces are not invented.');
    return { model: { schema: 2, physicalPageIndex: geometry.physicalPageIndex, text, intervals, tokenBreaks,
        quality: !text.trim() ? 'none' : reasons.size ? 'partial' : 'available', reasons: [...reasons],
        geometry: { physicalPageIndex: geometry.physicalPageIndex, viewBox: [0, 0, geometry.width, geometry.height],
            rotation: geometry.rotation, userUnit: 1, width: geometry.width, height: geometry.height, viewportTransform: [1, 0, 0, 1, 0, 0] } }, charU16 };
}
