/** Canonical PDF extraction: content order is evidence; visual reading order is
 * only a heuristic. Never normalize ligatures, whitespace or discretionary hyphens. */
export const PDF_PAGE_TEXT_SCHEMA = 'pdf-page-v1' as const;
export type PdfMatrix = readonly [number, number, number, number, number, number];
export interface PdfPageGeometry {
    physicalPageIndex: number; viewBox: readonly [number, number, number, number];
    rotation: number; userUnit: number; width: number; height: number; viewportTransform: PdfMatrix;
}
export interface PdfTextItem {
    str: string; hasEOL: boolean; transform: readonly number[];
    width: number; height: number; dir: string; fontName: string;
}
export interface PdfMarkedItem { type: string; id?: string }
export type PdfProjectionItem = PdfTextItem | PdfMarkedItem;
export type PdfSemanticRole = 'prose' | 'code' | 'formula' | 'ambiguous';
export interface PdfItemInterval {
    from: number; to: number; itemIndex: number; syntheticLF: boolean;
    transform: readonly number[]; width: number; height: number; dir: string; fontName: string;
    markedContentIds: readonly string[];
    /** Resolved from the PDF structure tree where available; never guessed prose. */
    role: PdfSemanticRole;
}
export interface PdfPageText {
    schema: 1; physicalPageIndex: number; text: string;
    intervals: readonly PdfItemInterval[]; tokenBreaks: readonly number[];
    quality: 'available' | 'partial' | 'none'; reasons: readonly string[]; geometry: PdfPageGeometry;
}

export function projectPdfPageV1(items: readonly PdfProjectionItem[], geometry: PdfPageGeometry,
    roles?: ReadonlyMap<string, PdfSemanticRole>): PdfPageText {
    const parts: string[] = [], intervals: PdfItemInterval[] = [], tokenBreaks: number[] = [];
    const ids: string[] = [], reasons = new Set<string>();
    let length = 0, previous: PdfTextItem | undefined;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        if (!('str' in item)) {
            if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') ids.push(item.id ?? '');
            else if (item.type === 'endMarkedContent') ids.pop();
            continue;
        }
        if (length && item.str && !/\s$/u.test(parts.at(-1) ?? '') && !/^\s/u.test(item.str)) tokenBreaks.push(length);
        let role: PdfSemanticRole = 'prose';
        for (const id of ids) { const tagged = roles?.get(id); if (tagged && tagged !== 'prose') role = tagged; }
        if ([...item.str].some(c => c === '\uFFFD' || (c.charCodeAt(0) < 32 && !'\t\n\r'.includes(c)))) reasons.add('Encoding may be incomplete or incorrect.');
        if (item.dir === 'ttb' || Math.abs(item.transform[1] ?? 0) > Math.abs(item.transform[0] ?? 0) * 0.2) {
            reasons.add('Rotated or vertical text keeps PDF content order.'); role = 'ambiguous';
        }
        if (previous && item.str && previous.str) {
            const dy = (item.transform[5] ?? 0) - (previous.transform[5] ?? 0);
            const dx = (item.transform[4] ?? 0) - (previous.transform[4] ?? 0);
            if (dy > Math.max(item.height, previous.height, 1) * 2 || (Math.abs(dy) < 2 && dx < -Math.max(previous.width, 30))) {
                reasons.add('Possible columns or non-linear reading order; compare the original.');
            }
        }
        const base = { itemIndex, transform: [...item.transform], width: item.width, height: item.height,
            dir: item.dir, fontName: item.fontName, markedContentIds: [...ids], role };
        parts.push(item.str);
        intervals.push({ ...base, from: length, to: length + item.str.length, syntheticLF: false });
        length += item.str.length;
        if (item.hasEOL) { parts.push('\n'); intervals.push({ ...base, from: length, to: ++length, syntheticLF: true }); }
        previous = item;
    }
    const text = parts.join('');
    if ([...reasons].some(reason => reason.startsWith('Possible columns'))) {
        for (const interval of intervals) if (interval.role === 'prose') interval.role = 'ambiguous';
    }
    if (!text.trim()) reasons.add('No selectable text on this page. Images, blank pages and scans can have no text. OCR is not provided.');
    if (tokenBreaks.length) reasons.add('PDF item boundaries are preserved; missing spaces are not invented.');
    return { schema: 1, physicalPageIndex: geometry.physicalPageIndex, text, intervals, tokenBreaks,
        quality: !text.trim() ? 'none' : reasons.size ? 'partial' : 'available', reasons: [...reasons], geometry };
}

/** Structural public pdf.js shape, without a runtime import into this pure module. */
export function pdfPageGeometry(page: {
    pageNumber: number; view: number[]; rotate: number; userUnit: number;
    getViewport(options: { scale: number }): { width: number; height: number; transform: number[] };
}): PdfPageGeometry {
    const vp = page.getViewport({ scale: 1 });
    return { physicalPageIndex: page.pageNumber - 1, viewBox: page.view.slice(0, 4) as unknown as PdfPageGeometry['viewBox'],
        rotation: page.rotate, userUnit: page.userUnit, width: vp.width, height: vp.height,
        viewportTransform: vp.transform.slice(0, 6) as unknown as PdfMatrix };
}
