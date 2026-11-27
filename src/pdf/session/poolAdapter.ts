import { pdfPageLinks } from '../pdfLinkModel';
import type { PdfPool, PdfPoolDocument } from '../pool/types';
import type { PdfTileProducer } from '../layer/tileLayer';
import type { TiledDocumentPool } from './documentSession';
import { createPdfEmphasisController } from '../emphasis/controller';
import type { PdfEmphasisController } from '../emphasis/controller';

export function tiledPoolAdapter(pool: PdfPool, producer: (document: PdfPoolDocument, emphasis: PdfEmphasisController) => PdfTileProducer): TiledDocumentPool {
    return {
        async open(blob, token, source, signal, password) {
            const document = await pool.open({ blob, token, source, signal, password, priority: 0 });
            const emphasis = createPdfEmphasisController(document);
            try {
                const pages = document.info.pages;
                return {
                    pages, poolDocument: document, producer: producer(document, emphasis), emphasis,
                    async links(page, linkSignal) {
                        if (!Number.isSafeInteger(page) || page < 0 || page >= pages.length) return [];
                        const raw = await document.links(page, { priority: 1, signal: linkSignal });
                        return pdfPageLinks(raw, pages[page], pages.length);
                    },
                    close: () => { emphasis.dispose(); return document.close(); },
                };
            } catch (error) {
                emphasis.dispose();
                await document.close();
                throw error;
            }
        },
    };
}
