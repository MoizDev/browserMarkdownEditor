import type { PdfDocumentSession } from './pdfDocumentSession';
import { createPdfFindEngine } from './pdfFind';
import type { PdfFindEngine } from './pdfFind';
import { resolvePdfTextAnchor } from './pdfTextAnchors';
import type { PdfTextAnchorOptions, PdfTextAnchorResolution } from './pdfTextAnchors';
import { Limiter } from './pool';
import { pdfPageGeometry, projectPdfPageV1 } from './pdfPageText';
import type { PdfPageText, PdfProjectionItem, PdfSemanticRole } from './pdfPageText';

export interface PdfReaderIdentity {
    vaultId: string; vaultEpoch: number; documentId: string; byteGeneration: number;
    path: string; diskRev: number; rawVersion?: { lastModified: number; size: number; hash: string };
}
export interface PdfTextAnchor {
    physicalPageIndex: number; offsetUTF16: number; affinity: 'before' | 'after';
    quote: string; before: string; after: string; alignHint?: number;
}
export type LocationCause = 'restore' | 'layout' | 'user-scroll' | 'user-navigation' | 'search' | 'link' | 'annotation';
export const USER_TEXT_NAVIGATION_CAUSES = ['user-scroll', 'user-navigation', 'search', 'link'] as const;
export interface PdfTextPage extends PdfPageText { digest: string }
export interface PdfFindHit { anchor: PdfTextAnchor; snippet: string }
export interface PdfFindBatch {
    queryId: string; hits: readonly PdfFindHit[]; done: boolean; pagesDone: number;
    pagesTotal: number; truncated: boolean; unavailablePages: readonly number[]; textlessPages: number;
}
export interface PdfTextReaderOptions {
    initialPageIndex: number;
    onStatus?: (status: { phase: 'loading' | 'ready' | 'partial' | 'error'; message?: string; progress?: { done: number; total?: number } }) => void;
}
export interface PdfTextReader {
    readonly generation: number;
    getPageCount(signal?: AbortSignal): Promise<number>;
    getPage(index0: number, signal?: AbortSignal, priority?: 0 | 1): Promise<PdfTextPage>;
    readonly findEngine: PdfFindEngine;
    find(query: string, signal?: AbortSignal): AsyncIterable<PdfFindBatch>;
    navigate(anchor: PdfTextAnchor): Promise<PdfTextAnchor>;
    resolveAnchor(anchor: PdfTextAnchor, options: PdfTextAnchorOptions): Promise<PdfTextAnchorResolution>;
    setWindow(index0: number): void;
    setVisible(visible: boolean): void;
    dispose(): void;
    /** Bounded counters for diagnostics; does not retain page data. */
    diagnostics(): { retainedPages: number; retainedBytes: number; queued: number; active: boolean; extractions: number };
}
export interface PdfTextTypography {
    family: 'serif' | 'sans' | 'publisher'; size: number; leading: number;
    measure: 'compact' | 'comfortable' | 'wide'; margins: 'small' | 'medium' | 'large';
    theme: 'follow-app' | 'light' | 'sepia' | 'dark';
}
export const PDF_TEXT_LIMITS = { pageBytes: 1024 * 1024, pageItems: 50_000, retainedPages: 12,
    retainedBytes: 4 * 1024 * 1024, searchBytes: 16 * 1024 * 1024, searchHits: 10_000 } as const;
const abort = () => new DOMException('PDF text operation cancelled', 'AbortError');
const extractionPool = new Limiter(3);
const activeSessions = new WeakSet<PdfDocumentSession>();
const appWaiters = new Set<() => void>();
async function permit(signal: AbortSignal, session: PdfDocumentSession): Promise<() => void> {
    while (activeSessions.has(session)) {
        await new Promise<void>((resolve, reject) => {
            const wake = () => { cleanup(); resolve(); };
            const cancelled = () => { cleanup(); reject(abort()); };
            const cleanup = () => { appWaiters.delete(wake); signal.removeEventListener('abort', cancelled); };
            appWaiters.add(wake); signal.addEventListener('abort', cancelled, { once: true });
            if (signal.aborted) cancelled();
        });
    }
    if (signal.aborted) throw abort();
    activeSessions.add(session);
    return () => { activeSessions.delete(session); for (const wake of appWaiters) wake(); };
}

export function pdfTextAnchor(page: Pick<PdfPageText, 'text' | 'physicalPageIndex'>, offsetUTF16 = 0, alignHint = 0): PdfTextAnchor {
    let offset = Math.max(0, Math.min(page.text.length, Math.floor(offsetUTF16)));
    // DOM offsets are UTF-16; do not leave the caret inside a surrogate pair.
    if (offset && /[\uDC00-\uDFFF]/u.test(page.text[offset] ?? '') && /[\uD800-\uDBFF]/u.test(page.text[offset - 1])) offset--;
    return { physicalPageIndex: page.physicalPageIndex, offsetUTF16: offset, affinity: 'after',
        quote: page.text.slice(offset, offset + 48), before: page.text.slice(Math.max(0, offset - 48), offset),
        after: page.text.slice(offset + 48, offset + 96), alignHint };
}

export function createPdfTextReader(session: PdfDocumentSession, _identity: PdfReaderIdentity | undefined,
    options: PdfTextReaderOptions): PdfTextReader {
    const lifetime = new AbortController();
    let visibility = new AbortController(), visible = true;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    const cache = new Map<number, { page: PdfTextPage; bytes: number }>();
    let windowCenter = options.initialPageIndex;
    let retainedBytes = 0, extractions = 0, active = false;
    type Waiter = { resolve(value: PdfTextPage): void; reject(reason: unknown): void; cleanup(): void };
    type Request = { index: number; cancel: AbortController; priority: 0 | 1; waiters: Set<Waiter>; cancelTimer?: ReturnType<typeof setTimeout> };
    const queue: Request[] = [], requests = new Map<number, Request>();
    let activeRequest: Request | undefined;
    async function pageCount(signal?: AbortSignal) {
        if (lifetime.signal.aborted || signal?.aborted) throw abort();
        const lease = await session.acquire();
        try { if (lifetime.signal.aborted || signal?.aborted) throw abort(); return lease.document.numPages; }
        finally { lease.release(); }
    }
    function extract(index: number, signal: AbortSignal): Promise<PdfTextPage> {
        return extractionPool.run(() => extractPage(index, signal));
    }
    async function extractPage(index: number, signal: AbortSignal): Promise<PdfTextPage> {
        const releasePermit = await permit(signal, session);
        let lease: Awaited<ReturnType<PdfDocumentSession['acquirePage']>> | undefined;
        try {
            lease = await session.acquirePage(index, 'text', signal);
            const page = lease.page;
            const reader = page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }).getReader();
            // pdf.js requires an Error reason before marking its stream closed.
            // Without one, a late CLOSE throws on the already-cancelled reader.
            const cancel = () => { void reader.cancel(abort()).catch(() => {}); };
            signal.addEventListener('abort', cancel, { once: true });
            const items: PdfProjectionItem[] = [];
            let bytes = 0, mapBytes = 0, limited = false;
            const markedIds: string[] = [];
            try {
                while (true) {
                    if (signal.aborted) throw abort();
                    const { done, value } = await reader.read();
                    if (signal.aborted) throw abort();
                    if (done) break;
                    for (const item of value.items as PdfProjectionItem[]) {
                        if (!('str' in item)) {
                            if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
                                if (markedIds.length >= 128 || (item.id?.length ?? 0) > 1024) { limited = true; break; }
                                markedIds.push(item.id ?? '');
                            } else if (item.type === 'endMarkedContent') markedIds.pop();
                        }
                        const cost = 'str' in item ? item.str.length * 2 + (item.hasEOL ? 2 : 0) : 0;
                        const mapCost = 'str' in item ? 384 + item.fontName.length * 4 + markedIds.reduce((n, id) => n + id.length * 4 + 16, 0) : 64;
                        if (items.length >= PDF_TEXT_LIMITS.pageItems || bytes + cost > PDF_TEXT_LIMITS.pageBytes || bytes + cost + mapBytes + mapCost > PDF_TEXT_LIMITS.retainedBytes) { limited = true; break; }
                        bytes += cost; mapBytes += mapCost; items.push(item);
                    }
                    // A worker that already closed its sink can omit the
                    // cancel acknowledgement. The local stream closes now;
                    // waiting for that acknowledgement strands a partial page.
                    if (limited) { void reader.cancel(new Error('PDF text safety limit reached')).catch(() => {}); break; }
                }
            } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
            if (signal.aborted) throw abort();
            const roles = new Map<string, PdfSemanticRole>();
            // Tags help exclude known code/formula. Untagged content is still only
            // a best-effort projection, never a promise to reconstruct PDF semantics.
            const structure = await page.getStructTree().catch(() => null);
            if (signal.aborted) throw abort();
            function walk(node: { role?: string; id?: string; children?: unknown[] }, inherited: PdfSemanticRole = 'prose', depth = 0) {
                if (depth > 128 || roles.size > PDF_TEXT_LIMITS.pageItems) return;
                const role = node.role === 'Code' ? 'code' : node.role === 'Formula' ? 'formula' : inherited;
                if (node.id) roles.set(node.id, role);
                for (const child of node.children ?? []) if (child && typeof child === 'object') walk(child, role, depth + 1);
            }
            if (structure) walk(structure);
            const model = projectPdfPageV1(items, pdfPageGeometry(page), roles);
            if (limited) { model.quality = 'partial'; model.reasons = [...model.reasons, 'Extraction stopped at the 1 MiB text / 50,000 item / 4 MiB text-and-map / marked-content safety limit. The rest remains available in Original PDF.']; }
            const input = new TextEncoder().encode(JSON.stringify([model.schema, model.text, model.geometry]));
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), n => n.toString(16).padStart(2, '0')).join('');
            if (signal.aborted) throw abort();
            extractions++;
            return { ...model, digest };
        } finally { lease?.release(); releasePermit(); }
    }
    function retain(page: PdfTextPage): boolean {
        // Include map/string storage, not merely visible characters. This is an
        // explicit conservative estimate; JS engine object overhead is measured separately.
        const bytes = page.text.length * 2 + page.intervals.reduce((n, i) => n + 192 + i.fontName.length * 2 + i.markedContentIds.join('').length * 2, 0) + page.tokenBreaks.length * 8;
        if (bytes > PDF_TEXT_LIMITS.retainedBytes) return false;
        const old = cache.get(page.physicalPageIndex);
        if (old) retainedBytes -= old.bytes;
        cache.delete(page.physicalPageIndex);
        while (cache.size >= PDF_TEXT_LIMITS.retainedPages || retainedBytes + bytes > PDF_TEXT_LIMITS.retainedBytes) {
            const victim = [...cache.keys()].find(index => Math.abs(index - windowCenter) > 2);
            if (victim === undefined) return false;
            retainedBytes -= cache.get(victim)!.bytes; cache.delete(victim);
        }
        cache.set(page.physicalPageIndex, { page, bytes }); retainedBytes += bytes;
        return true;
    }

    async function pump() {
        if (active) return;
        active = true;
        try {
            while (queue.length && !lifetime.signal.aborted) {
                queue.sort((a, b) => a.priority - b.priority);
                const request = queue.shift()!; activeRequest = request;
                const signal = AbortSignal.any([lifetime.signal, request.cancel.signal]);
                try {
                    let model = cache.get(request.index)?.page;
                    if (request.index === windowCenter && request.priority === 0 && !model) options.onStatus?.({ phase: 'loading', message: `Extracting physical page ${request.index + 1}…` });
                    if (!model) { model = await extract(request.index, signal);
                        if (!signal.aborted && !retain(model) && request.priority === 0) {
                            throw new Error('Text window memory limit reached. Open this physical page directly to read it.');
                        } }
                    if (signal.aborted) throw abort();
                    if (request.index === windowCenter && request.priority === 0) options.onStatus?.({ phase: model.quality === 'available' ? 'ready' : 'partial', message: model.reasons.join(' ') || undefined });
                    for (const waiter of request.waiters) waiter.resolve(model);
                } catch (error) {
                    if (!signal.aborted && request.index === windowCenter && request.priority === 0) options.onStatus?.({ phase: 'error', message: String(error) });
                    for (const waiter of request.waiters) waiter.reject(error);
                }
                finally {
                    if (activeRequest === request) activeRequest = undefined;
                    if (request.cancelTimer !== undefined) clearTimeout(request.cancelTimer);
                    for (const waiter of request.waiters) waiter.cleanup();
                    if (requests.get(request.index) === request) requests.delete(request.index);
                }
                // Let navigation/cancellation enter before another page starts.
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        } finally { active = false; }
    }
    function getPage(index: number, callerSignal?: AbortSignal, priority: 0 | 1 = 0): Promise<PdfTextPage> {
        const signal = callerSignal ? AbortSignal.any([callerSignal, visibility.signal]) : visibility.signal;
        if (lifetime.signal.aborted || signal.aborted) return Promise.reject(abort());
        const found = cache.get(index);
        if (found) { cache.delete(index); cache.set(index, found); return Promise.resolve(found.page); }
        let request = requests.get(index);
        if (!request || request.cancel.signal.aborted) {
            request = { index, cancel: new AbortController(), priority, waiters: new Set() };
            requests.set(index, request); queue.push(request);
        }
        const job = request;
        job.priority = Math.min(priority, job.priority) as 0 | 1;
        if (job.cancelTimer !== undefined) { clearTimeout(job.cancelTimer); job.cancelTimer = undefined; }
        const promise = new Promise<PdfTextPage>((resolve, reject) => {
            const cancelled = () => {
                job.waiters.delete(waiter); waiter.cleanup(); reject(abort());
                // Do not discard queued demand until a refinement has had a
                // task to attach its own waiter to the same page.
                if (!job.waiters.size) job.cancelTimer = setTimeout(() => {
                    // A refinement may spend a task scanning cached pages
                    // before reaching this in-flight page. Finish that one
                    // stream once; hide/disposal still cancels it immediately.
                    if (job.waiters.size || activeRequest === job) return;
                    job.cancel.abort();
                    const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1);
                    if (requests.get(index) === job) requests.delete(index);
                }, 0);
            };
            const waiter: Waiter = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancelled) };
            job.waiters.add(waiter); signal?.addEventListener('abort', cancelled, { once: true });
        });
        void pump(); return promise;
    }
    const findEngine = createPdfFindEngine({ pageCount: signal => pageCount(signal), page: (index, signal) => getPage(index, signal, 1) });
    async function resolveAnchor(anchor: PdfTextAnchor, options: PdfTextAnchorOptions): Promise<PdfTextAnchorResolution> {
        const signal = AbortSignal.any([lifetime.signal, visibility.signal, ...(options.signal ? [options.signal] : [])]);
        const total = await pageCount(signal);
        const index = Math.min(total - 1, Math.max(0, Math.floor(Number.isFinite(anchor.physicalPageIndex) ? anchor.physicalPageIndex : 0)));
        windowCenter = index;
        const page = await getPage(index, signal);
        return resolvePdfTextAnchor(page, { ...anchor, physicalPageIndex: index }, { ...options, signal });
    }
    return {
        generation: session.generation,
        getPageCount: pageCount,
        getPage,
        findEngine,
        async *find(query, externalSignal) {
            const signal = AbortSignal.any([lifetime.signal, visibility.signal, ...(externalSignal ? [externalSignal] : [])]);
            const snippets = new Map<string, PdfFindHit>();
            for await (const batch of findEngine.search(query, windowCenter, signal)) {
                const hits: PdfFindHit[] = [];
                let snippetPage = -1, text = '', steps = 0, deadline = performance.now() + 4;
                for (const hit of batch.hits) {
                    if ((++steps & 127) === 0 && performance.now() >= deadline) {
                        await new Promise<void>(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 4;
                    }
                    if (signal.aborted) throw abort();
                    const key = `${hit.page}:${hit.from}:${hit.to}`;
                    let result = snippets.get(key);
                    if (!result) {
                        // Hits are in page order. Decode once for the group,
                        // not 10,000 copies of the same canonical page at the cap.
                        if (snippetPage !== hit.page) { text = (await findEngine.pageText(hit.page, signal)).text; snippetPage = hit.page; }
                        result = { anchor: pdfTextAnchor({ text, physicalPageIndex: hit.page }, hit.from),
                            snippet: text.slice(Math.max(0, hit.from - 32), Math.min(hit.to + 64, hit.from + 320)) };
                        snippets.set(key, result);
                    }
                    hits.push(result);
                }
                yield { queryId: String(batch.queryId), hits, done: batch.done, pagesDone: batch.pagesDone,
                    pagesTotal: batch.pagesTotal, truncated: batch.capped, textlessPages: batch.textlessPages,
                    unavailablePages: [...new Set([...batch.failedPages, ...batch.partialPages])] };
            }
        },
        resolveAnchor,
        async navigate(anchor) { return (await resolveAnchor(anchor, { sameSchema: true })).anchor; },
        setWindow(index0) { windowCenter = index0; },
        setVisible(next) {
            if (visible === next) return;
            visible = next;
            if (next) { visibility = new AbortController(); if (hiddenTimer !== undefined) clearTimeout(hiddenTimer); hiddenTimer = undefined; }
            else {
                visibility.abort(); for (const request of requests.values()) request.cancel.abort();
                hiddenTimer = setTimeout(() => { findEngine.clearIndex(); hiddenTimer = undefined; }, 60_000);
            }
        },
        dispose() {
            lifetime.abort(); visibility.abort(); findEngine.dispose();
            if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
            for (const request of requests.values()) {
                request.cancel.abort(); if (request.cancelTimer !== undefined) clearTimeout(request.cancelTimer);
                for (const waiter of request.waiters) { waiter.cleanup(); waiter.reject(abort()); }
            }
            queue.length = 0; requests.clear(); cache.clear(); retainedBytes = 0;
        },
        diagnostics: () => ({ retainedPages: cache.size, retainedBytes, queued: queue.length, active, extractions }),
    };
}
