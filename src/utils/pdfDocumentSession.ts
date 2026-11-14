import { version as pdfjsVersion, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { PdfDisplayGeometry } from './pdfOverlay';
import { openClassicPdf, loadClassicPdf, closeClassicPdf } from './pdfClassicOpen';
import { createClassicPdfHealth } from './pdfClassicHealth';
import { PdfEmphasisVerdicts } from './pdfEmphasisVerdicts';
import { assertPdfCopyAllowed, classicPdfCapabilities, type PdfCapabilities } from './pdfCapabilities';
import { createPdfEmphasisIdentity } from './pdfEmphasisIdentity';
import type { PdfEmphasisIdentity } from './pdfEmphasisIdentity';
import { forgetPdfEmphasisPlan } from './pdfEmphasisPlanCache';
import type { ClassicPdfHealth } from './pdfClassicHealth';
import { mapPool } from './pool';
import { discardParsedPage, forgetParsedPages, parsedPageBusy, parsedPageIdle, parsedPageReservation, parsedPageVisibility, type ParsedPageCacheEntry } from './pdfParsedPageCache';

export interface PdfPageLease { page: PDFPageProxy; release(): void }
export interface PdfDocumentSession {
    readonly generation: number;
    readonly health: ClassicPdfHealth;
    readonly emphasisVerdicts: PdfEmphasisVerdicts;
    readonly emphasisIdentity: PdfEmphasisIdentity;
    acquire(): Promise<{ document: PDFDocumentProxy; release(): void }>;
    capabilities(): Promise<PdfCapabilities>;
    acquirePage(index0: number, consumer: 'render' | 'text' | 'thumbnail' | 'agent', signal?: AbortSignal): Promise<PdfPageLease>;
    acquireRender(index0: number, signal?: AbortSignal): Promise<PdfPageLease>;
    geometry(): Promise<PdfDisplayGeometry[]>;
    handoff(index0: number): void;
    setVisible(visible: boolean, currentPage?: number): void;
    markRendered(index0: number): void;
    memory(): { idlePages: number; reservationBytes: number; parsedBytes: null; decodedImageBytes: null; canvasBytes: null; workerHeapBytes: null };
    dispose(): Promise<void>;
}

const aborted = () => new DOMException('PDF operation cancelled', 'AbortError');

/** The retained pane owns disposal; changing surfaces releases consumers, never
 * the document. In particular, an old surface cannot destroy a new one's proxy. */
export function createPdfDocumentSession(bytes: Uint8Array, generation: number, purpose: 'viewer' | 'agent' = 'viewer'): PdfDocumentSession {
    const opening = new AbortController();
    const health = createClassicPdfHealth();
    const emphasisVerdicts = new PdfEmphasisVerdicts();
    const emphasisIdentity = createPdfEmphasisIdentity(bytes);
    let taskReady = false;
    let loadingTask: Promise<PDFDocumentLoadingTask> | undefined = openClassicPdf({ bytes, purpose, signal: opening.signal, diagnostic: health.record, progress: health.progress }).then(openedTask => { taskReady = true; return openedTask; });
    let loadedDocument: Promise<PDFDocumentProxy> | undefined = loadingTask.then(loadClassicPdf);
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
    let geometryPromise: Promise<PdfDisplayGeometry[]> | undefined;
    let capabilitiesPromise: Promise<PdfCapabilities> | undefined;
    const capabilities = () => {
        if (!capabilitiesPromise) capabilitiesPromise = documentReady().then(doc => health.guard(classicPdfCapabilities(doc)));
        return capabilitiesPromise;
    };
    const handoffs = new Map<number, () => void>();
    function makeEntry(index: number, doc: PDFDocumentProxy): Entry {
        const entry: Entry = {
            owner, index, users: 0, visible, current: currentPage, rendered: false, lastUsed: 0,
            promise: health.guard(doc.getPage(index + 1)),
            evict() {
                if (entry.users || pages.get(index) !== entry) return;
                if (!entry.page) {
                    void entry.promise.then(() => { if (!entry.users && pages.get(index) === entry) entry.evict(); }).catch(() => {});
                    return;
                }
                pages.delete(index);
                forgetPdfEmphasisPlan(entry.page);
                entry.page.cleanup();
            },
        };
        void entry.promise.then(page => { entry.page = page; }, () => {
            discardParsedPage(entry);
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
    function documentReady(): Promise<PDFDocumentProxy> {
        if (closing || !loadedDocument) return Promise.reject(aborted());
        return health.guard(loadedDocument);
    }
    return {
        generation,
        health,
        emphasisVerdicts,
        emphasisIdentity,
        capabilities,
        async acquire() {
            const release = hold();
            try {
                const doc = await documentReady();
                if (closing) throw aborted();
                return { document: doc, release };
            } catch (error) { release(); throw error; }
        },
        async acquirePage(index0, consumer, signal) {
            if (signal?.aborted) throw aborted();
            const releaseDocument = hold();
            let entry: Entry | undefined;
            try {
                const doc = await documentReady();
                if (consumer === 'text' || consumer === 'agent') assertPdfCopyAllowed(await health.guard(capabilities(), signal));
                if (closing || signal?.aborted) throw aborted();
                if (!Number.isInteger(index0) || index0 < 0 || index0 >= doc.numPages) throw new RangeError('PDF page is outside this document');
                entry = pages.get(index0);
                if (!entry) {
                    entry = makeEntry(index0, doc);
                    pages.set(index0, entry);
                }
                parsedPageBusy(entry);
                entry.users++;
                handoffs.get(index0)?.();
                const owned = entry;
                let held = true;
                const release = () => {
                    if (!held) return;
                    held = false;
                    if (--owned.users === 0 && !closing && pages.get(index0) === owned) parsedPageIdle(owned);
                    releaseDocument();
                };
                try {
                    const page = await health.guard(entry.promise, signal);
                    if (closing || signal?.aborted) throw aborted();
                    return { page, release };
                } catch (error) { release(); throw error; }
            } catch (error) {
                // releaseDocument is idempotent, including failed page acquisition.
                releaseDocument();
                throw error;
            }
        },
        handoff(index0) {
            if (!visible || closing || handoffs.has(index0)) return;
            const entry = pages.get(index0);
            if (!entry) return;
            const releaseDocument = hold();
            parsedPageBusy(entry);
            entry.users++;
            const release = () => {
                if (handoffs.get(index0) !== release) return;
                handoffs.delete(index0);
                clearTimeout(timer);
                if (--entry.users === 0 && !closing && pages.get(index0) === entry) parsedPageIdle(entry);
                releaseDocument();
            };
            handoffs.set(index0, release);
            const timer = setTimeout(release, 5000);
        },
        geometry() {
            if (!geometryPromise) {
                const pending = (async () => {
                    const docLease = await this.acquire();
                    try {
                        return await mapPool(Array.from({ length: docLease.document.numPages }, (_, i) => i), async index => {
                            const lease = await this.acquirePage(index, 'render');
                            try {
                                const page = lease.page, viewport = page.getViewport({ scale: 1 });
                                const [a, b, c, d, e, f] = viewport.transform;
                                const determinant = a * d - b * c;
                                if (![a, b, c, d, e, f, viewport.width, viewport.height, determinant].every(Number.isFinite) ||
                                    determinant === 0 || viewport.width <= 0 || viewport.height <= 0) {
                                    throw new Error(`Invalid display geometry for PDF page ${index + 1}.`);
                                }
                                return {
                                    width: viewport.width, height: viewport.height,
                                    toUserSpace: [d / determinant, -b / determinant, -c / determinant, a / determinant,
                                        (c * f - d * e) / determinant, (b * e - a * f) / determinant] as PdfDisplayGeometry['toUserSpace'],
                                    rotation: page.rotate, userUnit: page.userUnit, pageIndex: index,
                                    sourceFingerprint: docLease.document.fingerprints[0] ?? '', engine: `pdfjs/${pdfjsVersion}`,
                                };
                            } finally { lease.release(); }
                        });
                    } finally { docLease.release(); }
                })();
                geometryPromise = pending;
                void pending.catch(() => { if (geometryPromise === pending) geometryPromise = undefined; });
            }
            return geometryPromise;
        },
        async acquireRender(index0, signal) {
            const lease = await this.acquirePage(index0, 'render', signal);
            const previous = renderQueues.get(index0) ?? Promise.resolve();
            let unlock!: () => void;
            const gate = new Promise<void>(resolve => { unlock = resolve; });
            const tail = previous.then(() => gate);
            renderQueues.set(index0, tail);
            try {
                await new Promise<void>((resolve, reject) => {
                    const abort = () => { signal?.removeEventListener('abort', abort); reject(aborted()); };
                    if (signal?.aborted) { abort(); return; }
                    signal?.addEventListener('abort', abort, { once: true });
                    void previous.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
                });
            } catch (error) {
                // The next waiter must still follow the previous active render,
                // but this cancelled waiter no longer owns a page lease.
                void previous.then(unlock);
                lease.release();
                void tail.then(() => { if (renderQueues.get(index0) === tail) renderQueues.delete(index0); });
                throw error;
            }
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
            if (!visible) for (const release of handoffs.values()) release();
            parsedPageVisibility(owner, visible, pages.values(), currentPage);
        },
        markRendered(index0) {
            const entry = pages.get(index0);
            if (entry) entry.rendered = true;
        },
        memory() {
            return { ...parsedPageReservation(owner), parsedBytes: null, decodedImageBytes: null, canvasBytes: null, workerHeapBytes: null };
        },
        dispose() {
            if (disposal) return disposal;
            closing = true;
            health.close();
            for (const release of handoffs.values()) release();
            forgetParsedPages(owner);
            // Startup has no lease yet; once loaded, retain the original
            // document/page lease ordering rather than destroying mid-render.
            if (!taskReady) opening.abort();
            const pendingTask = loadingTask;
            loadingTask = undefined;
            loadedDocument = undefined;
            disposal = (async () => {
                await emphasisVerdicts.dispose();
                if (leases) await new Promise<void>(resolve => { finish = resolve; });
                const loaded = await pendingTask?.catch(() => undefined);
                if (loaded) await closeClassicPdf(loaded, health.stalled);
                for (const entry of pages.values()) if (entry.page) forgetPdfEmphasisPlan(entry.page);
                pages.clear();
            })();
            return disposal;
        },
    };
}
