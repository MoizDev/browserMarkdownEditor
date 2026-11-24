import { pdfTextAnchor } from '../../utils/pdfReadingText';
import type { PdfTextAnchor, PdfTextReader } from '../../utils/pdfReadingText';
import type { PdfViewPos } from '../../utils/pdfViewState';

/** Map the original page checkpoint to the nearest canonical item. */
export async function tiledOriginalToText(reader: PdfTextReader, position: PdfViewPos, signal?: AbortSignal): Promise<PdfTextAnchor> {
    const page = await reader.getPage(position.page, signal, 0);
    const [, b, , d, , f] = page.geometry.viewportTransform;
    let nearest = Infinity, offset = 0;
    for (const item of page.intervals) {
        if (item.syntheticLF || item.role === 'ambiguous') continue;
        const y = b * item.transform[4] + d * item.transform[5] + f;
        const distance = Math.abs(y - position.offset * page.geometry.height);
        if (distance < nearest) { nearest = distance; offset = item.from; }
    }
    if (signal?.aborted) throw new DOMException('PDF text navigation cancelled', 'AbortError');
    return pdfTextAnchor(page, offset);
}

/** Preserve the original zoom while mapping a canonical text anchor back to
 * its physical page; unavailable glyph geometry falls back to the page top. */
export async function tiledTextToOriginal(reader: PdfTextReader, anchor: PdfTextAnchor,
    checkpoint: PdfViewPos, signal?: AbortSignal): Promise<{ position: PdfViewPos; mapped: boolean }> {
    const page = await reader.getPage(anchor.physicalPageIndex, signal, 0);
    if (signal?.aborted) throw new DOMException('PDF text navigation cancelled', 'AbortError');
    const item = page.intervals.find(value => !value.syntheticLF && value.from <= anchor.offsetUTF16 && value.to > anchor.offsetUTF16);
    const position: PdfViewPos = { ...checkpoint, page: anchor.physicalPageIndex, offset: 0 };
    if (!item || item.role === 'ambiguous' || item.transform.length < 6 || !page.geometry.height) return { position, mapped: false };
    const [, b, , d, , f] = page.geometry.viewportTransform;
    position.offset = Math.max(0, Math.min(1, (b * item.transform[4] + d * item.transform[5] + f) / page.geometry.height));
    return { position, mapped: true };
}
