import type { PdfOpenOptions, PdfPool, PdfPoolDocument } from '../pool/types';

export interface PdfAgentTextResult { pageCount: number; pages: Array<{ page: number; text: string }> }
const abort = () => new DOMException('PDF agent text cancelled', 'AbortError');

/** One awaited request at a time: agent reads cannot occupy multiple workers. */
export async function pdfAgentPages(document: PdfPoolDocument, requestedPages: readonly number[], signal: AbortSignal): Promise<Array<{ page: number; text: string }>> {
    const pages: Array<{ page: number; text: string }> = [], key = document.docKey;
    for (const page of requestedPages.slice(0, 50)) {
        if (signal.aborted || document.closed) throw abort();
        if (!Number.isInteger(page) || page < 1 || page > document.info.pageCount) continue;
        const reply = await document.text(page - 1, 'text', { priority: 0, signal });
        if (signal.aborted || document.closed) throw abort();
        if (reply.docKey !== key || reply.page !== page - 1 || reply.schema !== 2) throw new Error('The PDF text worker returned a stale page.');
        // The reporter returns strings without quality metadata. Refuse a
        // partial page rather than presenting warned extraction as complete.
        if (reply.quality === 'partial') throw new Error(`PDF page ${page} has extraction warnings: ${reply.reasons.join(' ') || 'Text may be incomplete.'}`);
        pages.push({ page, text: reply.text });
    }
    return pages;
}

/** Closed files take a transient pool lease, never a second parser or index. */
export async function readPdfAgentText(pool: PdfPool, options: PdfOpenOptions, first: number, maxPages: number,
    maxChars: number, signal: AbortSignal): Promise<PdfAgentTextResult> {
    const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
    if (combined.aborted) throw abort();
    const document = await pool.open({ ...options, priority: 0, signal: combined });
    try {
        const pages: PdfAgentTextResult['pages'] = [];
        const start = Number.isFinite(first) ? Math.max(1, Math.floor(first)) : 1;
        const limit = Number.isFinite(maxPages) ? Math.max(0, Math.min(50, Math.floor(maxPages))) : 0;
        const charLimit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
        let used = 0;
        for (let page = start; page <= document.info.pageCount && pages.length < limit; page++) {
            const [result] = await pdfAgentPages(document, [page], combined);
            if (!result) break;
            if (pages.length && used + result.text.length > charLimit) break;
            pages.push(result); used += result.text.length;
        }
        return { pageCount: document.info.pageCount, pages };
    } finally { await document.close(); }
}
