import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { openClassicPdf } from './pdfClassicOpen';
import { forgetParsedPages, parsedPageBusy, parsedPageIdle, parsedPageVisibility, type ParsedPageCacheEntry } from './pdfParsedPageCache';

export interface PdfPageLease { page: PDFPageProxy; release(): void }
export interface PdfDocumentSession {
    readonly generation: number;
    acquire(): Promise<{ document: PDFDocumentProxy; release(): void }>;
    acquirePage(index0: number, consumer: 'render' | 'text' | 'thumbnail' | 'agent', signal?: AbortSignal): Promise<PdfPageLease>;
    acquireRender(index0: number, signal?: AbortSignal): Promise<PdfPageLease>;
    setVisible(visible: boolean, currentPage?: number): void;
    markRendered(index0: number): void;
    dispose(): Promise<void>;
}

const aborted = () => new DOMException('PDF operation cancelled', 'AbortError');

/** The retained pane owns disposal; changing surfaces releases consumers, never
 * the document. In particular, an old surface cannot destroy a new one's proxy. */
export function createPdfDocumentSession(bytes: Uint8Array, generation: number): PdfDocumentSession {
    const opening = new AbortController();
    let taskReady = false;
    const loadingTask = openClassicPdf({ bytes, purpose: 'viewer', signal: opening.signal }).then(openedTask => { taskReady = true; return openedTask; });
    const loadedDocument = loadingTask.then(openedTask => openedTask.promise);
    // A pane can be closed before its first consumer awaits worker startup.
    void loadedDocument.catch(() => {});
    let closing = false;
    let leases = 0;
    let finish: (() => void) | undefined;
    let disposal: Promise<void> | undefined;
    type Entry = ParsedPageCacheEntry & { promise: Promise<PDFPageProxy>; page?: PDFPageProxy };
    const owner = {};
    const pages = new Map<number, Entry>();
    let visible = true, currentPage = 0;
    const renderQueues = new Map<number, Promise<void>>();
    function makeEntry(index: number, doc: PDFDocumentProxy): Entry {
        const entry: Entry = {
            owner, index, users: 0, visible, current: currentPage, rendered: false, lastUsed: 0,
            promise: doc.getPage(index + 1),
            evict() {
                if (entry.users || pages.get(index) !== entry) return;
                if (!entry.page) {
                    void entry.promise.then(() => { if (!entry.users && pages.get(index) === entry) entry.evict(); }).catch(() => {});
                    return;
                }
                pages.delete(index);
                entry.page.cleanup();
            },
        };
        void entry.promise.then(page => { entry.page = page; }, () => {
            if (pages.get(index) === entry) pages.delete(index);
        });
        return entry;
    }
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
                const doc = await loadedDocument;
                if (closing) throw aborted();
                return { document: doc, release };
            } catch (error) { release(); throw error; }
        },
        async acquirePage(index0, _consumer, signal) {
            if (signal?.aborted) throw aborted();
            const releaseDocument = hold();
            let entry: Entry | undefined;
            try {
                const doc = await loadedDocument;
                if (closing || signal?.aborted) throw aborted();
                if (!Number.isInteger(index0) || index0 < 0 || index0 >= doc.numPages) throw new RangeError('PDF page is outside this document');
                entry = pages.get(index0);
                if (!entry) {
                    entry = makeEntry(index0, doc);
                    pages.set(index0, entry);
                }
                parsedPageBusy(entry);
                entry.users++;
                const owned = entry;
                let held = true;
                const release = () => {
                    if (!held) return;
                    held = false;
                    if (--owned.users === 0 && pages.get(index0) === owned) parsedPageIdle(owned);
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
        async acquireRender(index0, signal) {
            const lease = await this.acquirePage(index0, 'render', signal);
            const previous = renderQueues.get(index0) ?? Promise.resolve();
            let unlock!: () => void;
            const gate = new Promise<void>(resolve => { unlock = resolve; });
            const tail = previous.then(() => gate);
            renderQueues.set(index0, tail);
            await previous;
            if (closing || signal?.aborted) {
                unlock();
                lease.release();
                if (renderQueues.get(index0) === tail) renderQueues.delete(index0);
                throw aborted();
            }
            let held = true;
            return { page: lease.page, release() {
                if (!held) return;
                held = false;
                unlock();
                lease.release();
                if (renderQueues.get(index0) === tail) renderQueues.delete(index0);
            } };
        },
        setVisible(next, current = currentPage) {
            visible = next;
            currentPage = current;
            parsedPageVisibility(owner, visible, pages.values(), currentPage);
        },
        markRendered(index0) {
            const entry = pages.get(index0);
            if (entry) entry.rendered = true;
        },
        dispose() {
            if (disposal) return disposal;
            closing = true;
            forgetParsedPages(owner);
            // Startup has no lease yet; once loaded, retain the original
            // document/page lease ordering rather than destroying mid-render.
            if (!taskReady) opening.abort();
            disposal = (async () => {
                if (leases) await new Promise<void>(resolve => { finish = resolve; });
                const loaded = await loadingTask.catch(() => undefined);
                await loaded?.destroy();
                pages.clear();
            })();
            return disposal;
        },
    };
}
