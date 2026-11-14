import { assertPdfCaptureAllowed, assertPdfCopyAllowed, tiledPdfCapabilities } from '../../utils/pdfCapabilities';
import { getPdfPageQuality } from '../quality/store';
import type { PdfOpenOptions, PdfPool, PdfPoolDocument } from '../pool/types';

export interface PdfAgentPage { page: number; text: string; quality?: 'partial'; warnings?: readonly string[] }
export interface PdfAgentTextResult { pageCount: number; pages: PdfAgentPage[] }
const abort = () => new DOMException('PDF agent operation cancelled', 'AbortError');
const deadline = (signal: AbortSignal, other?: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(20_000), ...(other ? [other] : [])]);
const check = (signal: AbortSignal, current: () => boolean, document?: PdfPoolDocument) => {
    signal.throwIfAborted();
    if (!current() || document?.closed) throw abort();
};

async function openAgentDocument(pool: PdfPool, options: PdfOpenOptions, signal: AbortSignal, current: () => boolean): Promise<PdfPoolDocument> {
    check(signal, current);
    let document: PdfPoolDocument;
    try { document = await pool.open({ ...options, priority: 0, signal }); }
    catch (error) {
        if (error instanceof Error && error.name === 'PasswordRequired') throw new Error('This PDF is password-protected; open it in the app to read it.');
        throw error;
    }
    try { check(signal, current, document); return document; }
    catch (error) { await document.close(); throw error; }
}

async function readPages(document: PdfPoolDocument, requestedPages: readonly number[], signal: AbortSignal,
    current: () => boolean): Promise<PdfAgentPage[]> {
    check(signal, current, document);
    assertPdfCopyAllowed(tiledPdfCapabilities(document.info));
    if (!Array.isArray(requestedPages) || requestedPages.length > 50) throw new RangeError('PDF text requests are limited to 50 pages.');
    const pages: PdfAgentPage[] = [], key = document.docKey;
    for (const page of requestedPages) {
        check(signal, current, document);
        if (!Number.isInteger(page) || page < 1 || page > document.info.pageCount) continue;
        const reply = await document.text(page - 1, 'text', { priority: 0, signal });
        check(signal, current, document);
        if (document.docKey !== key || reply.docKey !== key || reply.page !== page - 1 || reply.schema !== 2) throw new Error('The PDF text worker returned a stale page.');
        pages.push(reply.quality === 'partial'
            ? { page, text: reply.text, quality: 'partial', warnings: reply.reasons }
            : { page, text: reply.text });
    }
    return pages;
}

/** One awaited request at a time and one deadline for the whole page list. */
export async function pdfAgentPages(document: PdfPoolDocument, requestedPages: readonly number[], signal: AbortSignal,
    current: () => boolean = () => true): Promise<PdfAgentPage[]> {
    return readPages(document, requestedPages, deadline(signal), current);
}

/** Closed files take a transient pool lease, never a second parser or index. */
export async function readPdfAgentText(pool: PdfPool, options: PdfOpenOptions, first: number, maxPages: number,
    maxChars: number, signal: AbortSignal, current: () => boolean = () => true): Promise<PdfAgentTextResult> {
    const combined = deadline(signal, options.signal);
    const document = await openAgentDocument(pool, options, combined, current);
    try {
        check(combined, current, document);
        assertPdfCopyAllowed(tiledPdfCapabilities(document.info));
        const start = Number.isFinite(first) ? Math.max(1, Math.floor(first)) : 1;
        const limit = Number.isFinite(maxPages) ? Math.max(0, Math.min(50, Math.floor(maxPages))) : 0;
        const charLimit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
        const indices: number[] = [];
        for (let page = start; page <= document.info.pageCount && indices.length < limit; page++) indices.push(page);
        const pages: PdfAgentPage[] = [];
        let used = 0;
        for (const index of indices) {
            const [page] = await readPages(document, [index], combined, current);
            check(combined, current, document);
            if (!page) continue;
            used += page.text.length + (page.quality === 'partial' ? Math.min(1000, page.warnings?.join(' ').length ?? 0) + 24 : 0);
            if (used > charLimit) throw new RangeError('PDF text exceeds the requested character limit.');
            pages.push(page);
        }
        return { pageCount: document.info.pageCount, pages };
    } finally { await document.close(); }
}

/** Closed-file vault_view: a transient lease on the same engine, never a second parser. */
export async function renderPdfAgentPage(pool: PdfPool, options: PdfOpenOptions, page: number, maxSide: number,
    signal: AbortSignal, current: () => boolean = () => true): Promise<{ pageCount: number; png: Blob | null }> {
    const combined = deadline(signal, options.signal);
    const document = await openAgentDocument(pool, options, combined, current);
    try {
        check(combined, current, document);
        assertPdfCaptureAllowed(tiledPdfCapabilities(document.info));
        const count = document.info.pageCount, key = document.docKey;
        if (!Number.isInteger(page) || page < 1 || page > count) return { pageCount: count, png: null };
        if (!Number.isFinite(maxSide) || maxSide <= 0) throw new RangeError('Invalid PDF image size');
        const assertComplete = () => {
            check(combined, current, document);
            if (document.docKey !== key || getPdfPageQuality(key, page - 1).state === 'degraded') throw new Error('This PDF page may be incomplete and cannot be captured as complete.');
        };
        assertComplete();
        const geometry = await document.resolveGeometry(page - 1, { priority: 0, signal: combined });
        assertComplete();
        const scale = Math.min(maxSide, 1568) / Math.max(geometry.width, geometry.height);
        const bitmap = await document.renderPage(page - 1, scale, { priority: 0, variant: 'plain', profileKey: 'plain',
            maxPixels: 1568 * 1568, signal: combined });
        try {
            assertComplete();
            if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 1568 || bitmap.height > 1568) throw new RangeError('Invalid PDF capture dimensions');
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Could not render the PDF page.');
            context.fillStyle = '#fff'; context.fillRect(0, 0, bitmap.width, bitmap.height); context.drawImage(bitmap, 0, 0);
            const png = await canvas.convertToBlob({ type: 'image/png' });
            assertComplete();
            return { pageCount: count, png };
        } finally { bitmap.close(); }
    } finally { await document.close(); }
}
