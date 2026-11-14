// Reading a PDF that is NOT open, for the AI agent: the text of a page range
// (vault_read) and one page as a picture (vault_view).
//
// IMPORTS pdf.js, SO IT IS ONLY EVER REACHED THROUGH `import()` — from
// vaultAgentTools.ts. A static import of this module anywhere would pull pdf.js
// into whichever chunk holds the importer (see the pdf-and-drawings skill: the
// split is import discipline, nothing else). An OPEN PDF is never read here:
// its pane's reporter answers from the document it already has loaded.
//
// Every call opens the document and destroys it again, through the app's one
// shared worker (utils/pdfWorker.ts) — an agent reads a closed PDF a few times
// per run, and a held-open document would be a second copy of it in memory for
// the rest of the session.

import { pdfPageGeometry, projectPdfPageV1 } from './pdfPageText';
import { createPdfDocumentSession, type PdfDocumentSession } from './pdfDocumentSession';

async function withPdf<T>(bytes: Uint8Array, read: (session: PdfDocumentSession, pageCount: number) => Promise<T>): Promise<T> {
    const session = createPdfDocumentSession(bytes, 0, 'agent');
    try {
        const doc = await session.acquire();
        try { return await session.health.guard(read(session, doc.document.numPages)); }
        finally { doc.release(); }
    } finally { await session.dispose(); }
}

/** A page's text in reading order, one line per text line pdf.js reports. */
async function pageText(session: PdfDocumentSession, pageNumber: number): Promise<string> {
    const lease = await session.acquirePage(pageNumber - 1, 'agent');
    try {
        const content = await session.health.guard(lease.page.getTextContent({ disableNormalization: true, includeMarkedContent: true }));
        return projectPdfPageV1(content.items, pdfPageGeometry(lease.page)).text;
    } finally { lease.release(); }
}

export interface PdfTextResult {
    pageCount: number;
    pages: Array<{ page: number; text: string }>;
}

/**
 * The text of pages `first`… (1-based) until `maxChars` of text is gathered or
 * `maxPages` pages are read — whichever comes first. At least one page is
 * returned whenever `first` exists, even past `maxChars`.
 */
export async function readPdfText(bytes: Uint8Array, first: number, maxPages: number, maxChars: number): Promise<PdfTextResult> {
    return withPdf(bytes, async (session, pageCount) => {
        const pages: PdfTextResult['pages'] = [];
        let used = 0;
        for (let p = first; p <= pageCount && pages.length < maxPages; p++) {
            const text = await pageText(session, p);
            if (pages.length > 0 && used + text.length > maxChars) break;
            pages.push({ page: p, text });
            used += text.length;
        }
        return { pageCount, pages };
    });
}

/** Page `pageNumber` (1-based) as a PNG, long side ≤ `maxSide` px, on white. */
export async function renderPdfPage(bytes: Uint8Array, pageNumber: number, maxSide: number): Promise<{ png: Blob; pageCount: number } | { pageCount: number; png: null }> {
    return withPdf(bytes, async (session, pageCount) => {
        if (pageNumber < 1 || pageNumber > pageCount) return { pageCount, png: null };
        const lease = await session.acquireRender(pageNumber - 1);
        const page = lease.page;
        let canvas: HTMLCanvasElement | undefined;
        try {
            session.markRendered(pageNumber - 1);
            const unit = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: maxSide / Math.max(unit.width, unit.height, 1) });
            canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('no 2D canvas context');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            await session.health.guard(page.render({ canvas, canvasContext: context, viewport }).promise);
            session.health.assertComplete(pageNumber - 1);
            const output = canvas;
            const png = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/png'));
            if (!png) throw new Error(`could not rasterize page ${pageNumber}`);
            return { png, pageCount };
        } finally {
            if (canvas) canvas.width = canvas.height = 0;
            lease.release();
        }
    });
}
