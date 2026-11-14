import { CLIPBOARD_WRITE_BLOCKED, copyText } from './clipboard';
import type { PdfTextReader } from './pdfReadingText';

const MAX_COPY_BYTES = 16 * 1024 * 1024;

/** Canonical pages, not the currently mounted overlays: Original and the tiled
 *  viewer must copy the same document even when most pages have no DOM. */
export async function copyPdfDocumentText(reader: Pick<PdfTextReader, 'getPageCount' | 'findEngine'>,
    signal: AbortSignal, normalize: (text: string) => string, notice: (message: string) => void): Promise<void> {
    try {
        const total = await reader.getPageCount(signal);
        signal.throwIfAborted();
        notice(`Copying ${total} pages…`);
        const parts: string[] = [], encoder = new TextEncoder();
        let bytes = 0, warnings = 0, deadline = performance.now() + 4;
        for (let index = 0; index < total; index++) {
            const page = await reader.findEngine.pageText(index, signal);
            signal.throwIfAborted();
            // LF boundaries cannot compose glyphs across pages. Normalize per
            // page so the byte cap is enforced before allocating the joined text.
            const text = normalize(page.text);
            bytes += encoder.encode(text).byteLength + (index ? 1 : 0);
            if (bytes > MAX_COPY_BYTES) {
                notice('PDF text exceeds the 16 MiB copy limit. Select a smaller passage to copy.');
                return;
            }
            parts.push(text);
            if (page.quality !== 'available') warnings++;
            if (performance.now() >= deadline) {
                notice(`Copying ${total} pages… (${index + 1}/${total})`);
                await new Promise<void>(resolve => setTimeout(resolve, 0));
                signal.throwIfAborted(); deadline = performance.now() + 4;
            }
        }
        signal.throwIfAborted();
        const copied = await copyText(parts.join('\n'));
        signal.throwIfAborted();
        notice(copied ? `Copied text from ${total} pages.${warnings ? ' Some pages have no text or text-order/extraction warnings.' : ''}`
            : `${CLIPBOARD_WRITE_BLOCKED} For a smaller passage, select it first.`);
    } catch (error) {
        if (!signal.aborted) notice(`Could not copy the whole PDF. Select a smaller passage to copy. ${error instanceof Error ? error.message : String(error)}`);
    }
}
