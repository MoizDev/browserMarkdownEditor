import type { PdfTiledDocumentSession } from '../session/documentSession';
import type { PdfTextReader } from '../../utils/pdfReadingText';
import { createPdfPoolTextReader } from './poolReader';
import type { PdfPoolTextSource } from './poolReader';

const readerSlot = Symbol('pdf-text-reader');

/** Session ownership keeps one canonical find index across Original/Text and
 * pane remounts; a byte-generation change receives a new session and reader.
 * The source must therefore be session-owned, never a closure over a pane. */
export function sessionPdfTextReader(session: PdfTiledDocumentSession, source: PdfPoolTextSource,
    initialPageIndex: number): PdfTextReader {
    const existing = session.getSlot<PdfTextReader>(readerSlot);
    if (existing) return existing;
    const reader = createPdfPoolTextReader(source, { initialPageIndex });
    try { session.setSlot(readerSlot, reader, () => reader.dispose()); }
    catch (error) { reader.dispose(); throw error; }
    return reader;
}
