import type { PdfTiledDocumentSession } from '../session/documentSession';
import type { PdfTextReader } from '../../utils/pdfReadingText';
import { createPdfPoolTextReader } from './poolReader';
import type { PdfPoolTextSource } from './poolReader';

const readerSlot = Symbol('pdf-text-reader');
const visibleOwners = new WeakMap<PdfTextReader, Map<symbol, boolean>>();

/** Multiple surfaces can share one session reader. Hiding one must never abort
 * another's scan; only the last visible owner may pause or age out its index. */
export function retainPdfTextReaderVisibility(reader: PdfTextReader, initial: boolean): {
    setVisible(visible: boolean): void; release(): void;
} {
    let owners = visibleOwners.get(reader);
    if (!owners) { owners = new Map(); visibleOwners.set(reader, owners); }
    const group = owners, token = Symbol('PDF text surface');
    group.set(token, initial);
    const update = () => reader.setVisible([...group.values()].some(Boolean));
    update();
    let held = true;
    return {
        setVisible(visible) { if (held && group.get(token) !== visible) { group.set(token, visible); update(); } },
        release() {
            if (!held) return;
            held = false; group.delete(token); update();
            if (!group.size) visibleOwners.delete(reader);
        },
    };
}

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
