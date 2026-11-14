import { pdfPageLinks } from '../pdfLinkModel';
import type { PdfPool, PdfPoolDocument } from '../pool/types';
import type { PdfTileProducer } from '../layer/tileLayer';
import type { TiledDocumentPool } from './documentSession';

/** Bridges the retained pool lease to the pane without letting a component open
 * or close workers. The producer is built against that exact source lease. */
export function tiledPoolAdapter(pool: PdfPool, producer: (document: PdfPoolDocument) => PdfTileProducer): TiledDocumentPool {
    return {
        async open(blob, token, source, signal) {
            const document = await pool.open({ blob, token, source, signal, priority: 0 });
            try {
                const pages = document.info.pages;
                return {
                    pages, poolDocument: document, producer: producer(document),
                    async links(page, linkSignal) {
                        if (!Number.isSafeInteger(page) || page < 0 || page >= pages.length) return [];
                        const raw = await document.links(page, { priority: 1, signal: linkSignal });
                        return pdfPageLinks(raw, pages[page], pages.length);
                    },
                    close: () => document.close(),
                };
            } catch (error) {
                await document.close();
                throw error;
            }
        },
    };
}
