import { getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfWorker } from './pdfWorker';

export interface PdfPageLease { page: PDFPageProxy; release(): void }
export interface PdfDocumentSession {
    readonly generation: number;
    acquire(): Promise<{ document: PDFDocumentProxy; release(): void }>;
    acquirePage(index0: number, consumer: 'render' | 'text' | 'thumbnail' | 'agent', signal?: AbortSignal): Promise<PdfPageLease>;
    dispose(): Promise<void>;
}

const aborted = () => new DOMException('PDF operation cancelled', 'AbortError');

/** The retained pane owns disposal; changing surfaces releases consumers, never
 * the document. In particular, an old surface cannot destroy a new one's proxy. */
export function createPdfDocumentSession(bytes: Uint8Array, generation: number): PdfDocumentSession {
    const task = getDocument({ data: bytes.slice(), worker: pdfWorker() });
    // A pane can be closed before its first consumer awaits the loading task.
    void task.promise.catch(() => {});
    let closing = false;
    let leases = 0;
    let finish: (() => void) | undefined;
    let disposal: Promise<void> | undefined;
    const pages = new Map<number, { promise: Promise<PDFPageProxy>; users: number }>();
    function hold() {
        if (closing) throw aborted();
        leases++;
        let held = true;
        return () => {
            if (!held) return;
            held = false;
            if (--leases === 0) finish?.();
        };
    }
    return {
        generation,
        async acquire() {
            const release = hold();
            try {
                const document = await task.promise;
                if (closing) throw aborted();
                return { document, release };
            } catch (error) { release(); throw error; }
        },
        async acquirePage(index0, _consumer, signal) {
            if (signal?.aborted) throw aborted();
            const releaseDocument = hold();
            let entry: { promise: Promise<PDFPageProxy>; users: number } | undefined;
            try {
                const doc = await task.promise;
                if (closing || signal?.aborted) throw aborted();
                if (!Number.isInteger(index0) || index0 < 0 || index0 >= doc.numPages) throw new RangeError('PDF page is outside this document');
                entry = pages.get(index0);
                if (!entry) {
                    entry = { promise: doc.getPage(index0 + 1), users: 0 };
                    pages.set(index0, entry);
                }
                entry.users++;
                const owned = entry;
                let held = true;
                const release = () => {
                    if (!held) return;
                    held = false;
                    if (--owned.users === 0) {
                        void owned.promise.then(page => {
                            if (owned.users === 0 && pages.get(index0) === owned) {
                                pages.delete(index0);
                                page.cleanup();
                            }
                        }).catch(() => { if (pages.get(index0) === owned) pages.delete(index0); });
                    }
                    releaseDocument();
                };
                try {
                    const page = await entry.promise;
                    if (closing || signal?.aborted) throw aborted();
                    return { page, release };
                } catch (error) { release(); throw error; }
            } catch (error) {
                // releaseDocument is idempotent, including failed page acquisition.
                releaseDocument();
                throw error;
            }
        },
        dispose() {
            if (disposal) return disposal;
            closing = true;
            disposal = (async () => {
                if (leases) await new Promise<void>(resolve => { finish = resolve; });
                await task.destroy();
                pages.clear();
            })();
            return disposal;
        },
    };
}
