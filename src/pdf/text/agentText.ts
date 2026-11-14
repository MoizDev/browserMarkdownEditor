import type { PdfOpenOptions, PdfPool, PdfPoolDocument } from '../pool/types';

export interface PdfAgentPage { page: number; text: string; quality?: 'partial'; warnings?: readonly string[] }
export interface PdfAgentTextResult { pageCount: number; pages: PdfAgentPage[] }
const abort = () => new DOMException('PDF agent text cancelled', 'AbortError');

async function openAgentDocument(pool: PdfPool, options: PdfOpenOptions, signal: AbortSignal): Promise<PdfPoolDocument> {
    try { return await pool.open({ ...options, priority: 0, signal }); }
    catch (error) {
        if (error instanceof Error && error.name === 'PasswordRequired') throw new Error('This PDF is password-protected; open it in the app to read it.');
        throw error;
    }
}

/** One awaited request at a time: agent reads cannot occupy multiple workers. */
export async function pdfAgentPages(document: PdfPoolDocument, requestedPages: readonly number[], signal: AbortSignal): Promise<PdfAgentPage[]> {
    const pages: PdfAgentPage[] = [], key = document.docKey;
    for (const page of requestedPages.slice(0, 50)) {
        if (signal.aborted || document.closed) throw abort();
        if (!Number.isInteger(page) || page < 1 || page > document.info.pageCount) continue;
        const reply = await document.text(page - 1, 'text', { priority: 0, signal });
        if (signal.aborted || document.closed) throw abort();
        if (reply.docKey !== key || reply.page !== page - 1 || reply.schema !== 2) throw new Error('The PDF text worker returned a stale page.');
        pages.push(reply.quality === 'partial'
            ? { page, text: reply.text, quality: 'partial', warnings: reply.reasons }
            : { page, text: reply.text });
    }
    return pages;
}

/** Closed files take a transient pool lease, never a second parser or index. */
export async function readPdfAgentText(pool: PdfPool, options: PdfOpenOptions, first: number, maxPages: number,
    maxChars: number, signal: AbortSignal): Promise<PdfAgentTextResult> {
    const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
    if (combined.aborted) throw abort();
    const document = await openAgentDocument(pool, options, combined);
    try {
        if (document.info.encrypted) throw new Error('This PDF is password-protected; open it in the app to read it.');
        const pages: PdfAgentTextResult['pages'] = [];
        const start = Number.isFinite(first) ? Math.max(1, Math.floor(first)) : 1;
        const limit = Number.isFinite(maxPages) ? Math.max(0, Math.min(50, Math.floor(maxPages))) : 0;
        const charLimit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
        let used = 0;
        for (let page = start; page <= document.info.pageCount && pages.length < limit; page++) {
            const [result] = await pdfAgentPages(document, [page], combined);
            if (!result) break;
            const warningBytes = result.quality === 'partial' ? Math.min(1000, result.warnings?.join(' ').length ?? 0) + 24 : 0;
            if (pages.length && used + result.text.length + warningBytes > charLimit) break;
            pages.push(result); used += result.text.length + warningBytes;
        }
        return { pageCount: document.info.pageCount, pages };
    } finally { await document.close(); }
}

/** Closed-file vault_view: a transient lease on the same engine and a bounded
 * plain physical page, never an off-screen pane or a second PDF parser. */
export async function renderPdfAgentPage(pool: PdfPool, options: PdfOpenOptions, page: number, maxSide: number,
    signal: AbortSignal): Promise<{ pageCount: number; png: Blob | null }> {
    const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
    if (combined.aborted) throw abort();
    const document = await openAgentDocument(pool, options, combined);
    try {
        if (document.info.encrypted) throw new Error('This PDF is password-protected; open it in the app to view it.');
        const count = document.info.pageCount;
        if (!Number.isInteger(page) || page < 1 || page > count) return { pageCount: count, png: null };
        if (!Number.isFinite(maxSide) || maxSide <= 0) throw new RangeError('Invalid PDF image size');
        const geometry = document.geometry(page - 1);
        const scale = Math.min(maxSide, 1568) / Math.max(geometry.width, geometry.height);
        const bitmap = await document.renderPage(page - 1, scale, { priority: 0, variant: 'plain', profileKey: 'plain',
            maxPixels: 1568 * 1568, signal: combined });
        try {
            combined.throwIfAborted();
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Could not render the PDF page.');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, bitmap.width, bitmap.height);
            context.drawImage(bitmap, 0, 0);
            const png = await canvas.convertToBlob({ type: 'image/png' });
            combined.throwIfAborted();
            return { pageCount: count, png };
        } finally { bitmap.close(); }
    } finally { await document.close(); }
}
