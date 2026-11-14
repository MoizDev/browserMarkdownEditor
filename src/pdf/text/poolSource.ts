import type { PdfPoolDocument } from '../pool/types';
import type { PageTextReply, PdfTextDetail } from '../worker/protocol';
import type { PdfPoolTextSource } from './poolReader';
import { validatePdfTextReply } from './validate';
import { exactPdfTextGeometry } from './exactGeometry';

/** The session's retained pool lease is the only engine-facing text source. */
export function pdfPoolTextSource(document: PdfPoolDocument): PdfPoolTextSource {
    const docKey = document.docKey;
    const request = async (page: number, detail: PdfTextDetail, priority: 0 | 1 | 2 | 3, signal: AbortSignal): Promise<PageTextReply> => {
        if (document.closed || signal.aborted) throw new DOMException('PDF text operation cancelled', 'AbortError');
        const reply = await document.text(page, detail, { priority, signal });
        if (document.closed || signal.aborted) throw new DOMException('PDF text operation cancelled', 'AbortError');
        if (reply.docKey !== docKey || reply.page !== page || reply.schema !== 2) throw new Error('The PDF text worker returned a stale page.');
        const geometry = detail === 'text' ? undefined : await exactPdfTextGeometry(document, page, priority, signal);
        await validatePdfTextReply(reply, geometry, detail, signal);
        if (signal.aborted || document.closed || document.docKey !== docKey) throw new DOMException('PDF text operation cancelled', 'AbortError');
        return reply;
    };
    return {
        generation: document.token.bytesGeneration,
        cacheKey: `pdfium-page-v1:${docKey}`,
        pageCount: document.info.pageCount,
        async text(page, priority, signal) {
            const reply = await request(page, 'text', priority, signal);
            return { text: reply.text, tokenBreaks: reply.tokenBreaks, quality: reply.quality };
        },
        async model(page, priority, signal) {
            const reply = await request(page, 'model', priority, signal);
            if (!reply.model || !reply.digest || reply.model.schema !== 2 || reply.model.physicalPageIndex !== page || reply.model.text !== reply.text)
                throw new Error('The PDF text worker returned an incomplete page model.');
            return { ...reply.model, digest: reply.digest };
        },
    };
}
