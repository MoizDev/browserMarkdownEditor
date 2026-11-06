import type { PdfDocumentSession } from './pdfDocumentSession';
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
export interface PdfTextPage extends PdfPageText { digest: string }
export interface PdfFindHit { anchor: PdfTextAnchor; snippet: string }
export interface PdfFindBatch {
    queryId: string; hits: readonly PdfFindHit[]; done: boolean; pagesDone: number;
    pagesTotal: number; truncated: boolean; unavailablePages: readonly number[];
}
export interface PdfTextReaderOptions {
    initialPageIndex: number;
    onStatus?: (status: { phase: 'loading' | 'ready' | 'partial' | 'error'; message?: string; progress?: { done: number; total?: number } }) => void;
}
export interface PdfTextReader {
    readonly generation: number;
    getPageCount(signal?: AbortSignal): Promise<number>;
    getPage(index0: number, signal?: AbortSignal): Promise<PdfTextPage>;
    find(query: string, signal?: AbortSignal): AsyncIterable<PdfFindBatch>;
    navigate(anchor: PdfTextAnchor): Promise<PdfTextAnchor>;
    setWindow(index0: number): void;
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
    retainedBytes: 4 * 1024 * 1024, searchBytes: 16 * 1024 * 1024, searchHits: 500 } as const;
const abort = () => new DOMException('PDF text operation cancelled', 'AbortError');
let appActive = 0;
const activeSessions = new WeakSet<PdfDocumentSession>();
const appWaiters = new Set<() => void>();
async function permit(signal: AbortSignal, session: PdfDocumentSession): Promise<() => void> {
    while (appActive >= 3 || activeSessions.has(session)) {
        await new Promise<void>((resolve, reject) => {
            const wake = () => { cleanup(); resolve(); };
            const cancelled = () => { cleanup(); reject(abort()); };
            const cleanup = () => { appWaiters.delete(wake); signal.removeEventListener('abort', cancelled); };
            appWaiters.add(wake); signal.addEventListener('abort', cancelled, { once: true });
            if (signal.aborted) cancelled();
        });
    }
    if (signal.aborted) throw abort();
    appActive++; activeSessions.add(session);
    return () => { appActive--; activeSessions.delete(session); for (const wake of appWaiters) wake(); };
}

export function pdfTextAnchor(page: PdfPageText, offsetUTF16 = 0, alignHint = 0): PdfTextAnchor {
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
    const cache = new Map<number, { page: PdfTextPage; bytes: number }>();
    let windowCenter = options.initialPageIndex;
    let retainedBytes = 0, extractions = 0, active = false, querySerial = 0;
    type Request = { index: number; signal?: AbortSignal; priority: number; resolve(value: PdfTextPage): void; reject(reason: unknown): void; cleanup(): void };
    const queue: Request[] = [];
    async function pageCount(signal?: AbortSignal) {
        if (lifetime.signal.aborted || signal?.aborted) throw abort();
        const lease = await session.acquire();
        try { if (lifetime.signal.aborted || signal?.aborted) throw abort(); return lease.document.numPages; }
        finally { lease.release(); }
    }
    async function extract(index: number, signal: AbortSignal): Promise<PdfTextPage> {
        const releasePermit = await permit(signal, session);
        let lease: Awaited<ReturnType<PdfDocumentSession['acquirePage']>> | undefined;
        try {
            lease = await session.acquirePage(index, 'text', signal);
            const page = lease.page;
            const reader = page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }).getReader();
            const cancel = () => { void reader.cancel().catch(() => {}); };
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
                    if (limited) { await reader.cancel(); break; }
                }
            } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
            if (signal.aborted) throw abort();
            const roles = new Map<string, PdfSemanticRole>();
            // Tags help exclude known code/formula. Untagged content is still only
            // a best-effort projection, never a promise to reconstruct PDF semantics.
            const structure = await page.getStructTree().catch(() => null);
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
                const request = queue.shift()!;
                if (request.signal?.aborted) { request.cleanup(); request.reject(abort()); continue; }
                const signal = request.signal ? AbortSignal.any([lifetime.signal, request.signal]) : lifetime.signal;
                try {
                    let model = cache.get(request.index)?.page;
                    if (request.index === windowCenter && request.priority === 0 && !model) options.onStatus?.({ phase: 'loading', message: `Extracting physical page ${request.index + 1}…` });
                    if (!model) { model = await extract(request.index, signal);
                        if (!signal.aborted && !retain(model) && request.priority === 0) {
                            throw new Error('Text window memory limit reached. Open this physical page directly to read it.');
                        } }
                    if (signal.aborted) throw abort();
                    if (request.index === windowCenter && request.priority === 0) options.onStatus?.({ phase: model.quality === 'available' ? 'ready' : 'partial', message: model.reasons.join(' ') || undefined });
                    request.resolve(model);
                } catch (error) {
                    if (!signal.aborted && request.index === windowCenter && request.priority === 0) options.onStatus?.({ phase: 'error', message: String(error) });
                    request.reject(error);
                }
                finally { request.cleanup(); }
                // Let navigation/cancellation enter before another page starts.
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        } finally { active = false; }
    }
    function getPage(index: number, signal?: AbortSignal, priority = 0): Promise<PdfTextPage> {
        if (lifetime.signal.aborted || signal?.aborted) return Promise.reject(abort());
        const found = cache.get(index);
        if (found) { cache.delete(index); cache.set(index, found); return Promise.resolve(found.page); }
        return new Promise((resolve, reject) => {
            const cancelled = () => { const i = queue.indexOf(request); if (i >= 0) { queue.splice(i, 1); request.cleanup(); reject(abort()); } };
            const request: Request = { index, signal, priority, resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancelled) };
            signal?.addEventListener('abort', cancelled, { once: true });
            queue.push(request); void pump();
        });
    }
    return {
        generation: session.generation,
        getPageCount: pageCount,
        getPage,
        async *find(query, signal) {
            const queryId = String(++querySerial), total = await pageCount(signal);
            const hits: PdfFindHit[] = [], unavailablePages: number[] = [];
            let resultBytes = 0, truncated = false, done = 0;
            if (!query.trim() || query.length > 256) { yield { queryId, hits, done: true, pagesDone: 0, pagesTotal: total, truncated: query.length > 256, unavailablePages }; return; }
            const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
            for (let pageIndex = 0; pageIndex < total; pageIndex++) {
                if (signal?.aborted || lifetime.signal.aborted) throw abort();
                try {
                    const page = await getPage(pageIndex, signal, 10);
                    if (page.quality !== 'available') unavailablePages.push(pageIndex);
                    pattern.lastIndex = 0;
                    for (let match = pattern.exec(page.text); match; match = pattern.exec(page.text)) {
                        const anchor = pdfTextAnchor(page, match.index), snippet = page.text.slice(Math.max(0, match.index - 32), match.index + query.length + 64);
                        resultBytes += (snippet.length + anchor.quote.length + anchor.before.length + anchor.after.length) * 2 + 128;
                        if (hits.length >= PDF_TEXT_LIMITS.searchHits || resultBytes > PDF_TEXT_LIMITS.searchBytes) { truncated = true; break; }
                        hits.push({ anchor, snippet });
                    }
                } catch (error) { if (signal?.aborted || lifetime.signal.aborted) throw error; unavailablePages.push(pageIndex); }
                done++;
                yield { queryId, hits: [...hits], done: done === total || truncated, pagesDone: done, pagesTotal: total, truncated, unavailablePages: [...unavailablePages] };
                if (truncated) break;
            }
        },
        async navigate(anchor) {
            const total = await pageCount();
            const index = Math.min(total - 1, Math.max(0, Math.floor(Number.isFinite(anchor.physicalPageIndex) ? anchor.physicalPageIndex : 0)));
            windowCenter = index;
            const page = await getPage(index);
            let offset = Math.max(0, Math.min(page.text.length, Number.isFinite(anchor.offsetUTF16) ? anchor.offsetUTF16 : 0));
            if (anchor.quote && page.text.slice(offset, offset + anchor.quote.length) !== anchor.quote) {
                const first = page.text.indexOf(anchor.quote);
                if (first >= 0 && page.text.indexOf(anchor.quote, first + 1) < 0) offset = first;
                else options.onStatus?.({ phase: 'partial', message: 'Text changed; restored approximately within the physical page.' });
            }
            return pdfTextAnchor(page, offset, anchor.alignHint);
        },
        setWindow(index0) { windowCenter = index0; },
        dispose() { lifetime.abort(); for (const request of queue.splice(0)) { request.cleanup(); request.reject(abort()); } cache.clear(); retainedBytes = 0; },
        diagnostics: () => ({ retainedPages: cache.size, retainedBytes, queued: queue.length, active, extractions }),
    };
}
