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

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfWorker } from './pdfWorker';

async function withPdf<T>(bytes: Uint8Array, read: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
    // pdf.js detaches the buffer it is handed; give it a copy.
    const task = pdfjs.getDocument({ data: bytes.slice(), worker: pdfWorker() });
    try {
        return await read(await task.promise);
    } finally {
        await task.destroy();
    }
}

/** A page's text in reading order, one line per text line pdf.js reports. */
async function pageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
    const page = await doc.getPage(pageNumber);
    try {
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
            if (!('str' in item)) continue; // marked-content boundaries
            text += item.str;
            if (item.hasEOL) text += '\n';
        }
        return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    } finally {
        page.cleanup();
    }
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
    return withPdf(bytes, async doc => {
        const pages: PdfTextResult['pages'] = [];
        let used = 0;
        for (let p = first; p <= doc.numPages && pages.length < maxPages; p++) {
            const text = await pageText(doc, p);
            if (pages.length > 0 && used + text.length > maxChars) break;
            pages.push({ page: p, text });
            used += text.length;
        }
        return { pageCount: doc.numPages, pages };
    });
}

/** Page `pageNumber` (1-based) as a PNG, long side ≤ `maxSide` px, on white. */
export async function renderPdfPage(bytes: Uint8Array, pageNumber: number, maxSide: number): Promise<{ png: Blob; pageCount: number } | { pageCount: number; png: null }> {
    return withPdf(bytes, async doc => {
        if (pageNumber < 1 || pageNumber > doc.numPages) return { pageCount: doc.numPages, png: null };
        const page = await doc.getPage(pageNumber);
        try {
            const unit = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: maxSide / Math.max(unit.width, unit.height, 1) });
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('no 2D canvas context');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvas, canvasContext: context, viewport }).promise;
            const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!png) throw new Error(`could not rasterize page ${pageNumber}`);
            return { png, pageCount: doc.numPages };
        } finally {
            page.cleanup();
        }
    });
}
