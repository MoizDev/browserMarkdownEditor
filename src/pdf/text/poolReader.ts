import { createPdfFindEngine } from '../../utils/pdfFind';
import type { PdfFindPageText } from '../../utils/pdfFind';
import { PDF_TEXT_LIMITS } from '../../utils/pdfReadingText';
import type { PdfTextAnchor, PdfTextPage, PdfTextReader, PdfTextReaderOptions } from '../../utils/pdfReadingText';
import { resolvePdfTextAnchor } from '../../utils/pdfTextAnchors';
import type { PdfTextAnchorOptions, PdfTextAnchorResolution } from '../../utils/pdfTextAnchors';

/** A document-bound adapter around page.text. The pool owns deduplication,
 * cancellation and priority promotion across all its callers. */
export interface PdfPoolTextSource {
    readonly generation: number;
    /** Raw immutable docKey plus extraction schema, not a path. */
    readonly cacheKey?: string;
    readonly pageCount: number;
    text(page: number, priority: 0 | 1 | 2 | 3, signal: AbortSignal): Promise<PdfFindPageText>;
    model(page: number, priority: 0 | 1 | 2 | 3, signal: AbortSignal): Promise<PdfTextPage>;
}
const abort = () => new DOMException('PDF text operation cancelled', 'AbortError');

/** The Text and Original surfaces share this reader and its one find index. */
export function createPdfPoolTextReader(source: PdfPoolTextSource, options: PdfTextReaderOptions): PdfTextReader {
    const lifetime = new AbortController();
    let visibility = new AbortController(), visible = true, hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let center = options.initialPageIndex, retainedBytes = 0, active = 0, extractions = 0;
    const cache = new Map<number, { page: PdfTextPage; bytes: number }>();
    const signalFor = (signal?: AbortSignal) => AbortSignal.any([lifetime.signal, visibility.signal, ...(signal ? [signal] : [])]);
    const pageCount = async (signal?: AbortSignal) => {
        if (signalFor(signal).aborted) throw abort();
        return source.pageCount;
    };
    const retain = (page: PdfTextPage) => {
        const bytes = page.text.length * 2 + page.intervals.reduce((n, i) => n + 192 + i.fontName.length * 2 + i.markedContentIds.join('').length * 2, 0) + page.tokenBreaks.length * 8;
        if (bytes > PDF_TEXT_LIMITS.retainedBytes) return;
        const old = cache.get(page.physicalPageIndex);
        if (old) retainedBytes -= old.bytes;
        cache.delete(page.physicalPageIndex);
        while (cache.size >= PDF_TEXT_LIMITS.retainedPages || retainedBytes + bytes > PDF_TEXT_LIMITS.retainedBytes) {
            const victim = cache.keys().next().value as number | undefined;
            if (victim === undefined) break;
            retainedBytes -= cache.get(victim)!.bytes; cache.delete(victim);
        }
        cache.set(page.physicalPageIndex, { page, bytes }); retainedBytes += bytes;
    };
    const getPage = async (index: number, external?: AbortSignal, priority: 0 | 1 | 2 | 3 = 0) => {
        const signal = signalFor(external);
        if (signal.aborted) throw abort();
        if (!Number.isInteger(index) || index < 0 || index >= source.pageCount) throw new RangeError('PDF page is out of range.');
        const hit = cache.get(index);
        if (hit) { cache.delete(index); cache.set(index, hit); return hit.page; }
        if (index === center && priority <= 1) options.onStatus?.({ phase: 'loading', message: `Extracting physical page ${index + 1}…` });
        active++;
        try {
            const page = await source.model(index, priority, signal);
            if (signal.aborted) throw abort();
            if (page.schema !== 2 || page.physicalPageIndex !== index) throw new Error('The PDF text worker returned the wrong page.');
            retain(page); extractions++;
            if (index === center && priority <= 1) options.onStatus?.({ phase: page.quality === 'available' ? 'ready' : 'partial', message: page.reasons.join(' ') || undefined });
            return page;
        } catch (error) {
            if (!signal.aborted && index === center && priority <= 1) options.onStatus?.({ phase: 'error', message: String(error) });
            throw error;
        } finally { active--; }
    };
    const findEngine = createPdfFindEngine({ cacheKey: source.cacheKey, pageCount: signal => pageCount(signal), page: (page, signal) => source.text(page, 1, signalFor(signal)) });
    const resolveAnchor = async (anchor: PdfTextAnchor, opts: PdfTextAnchorOptions): Promise<PdfTextAnchorResolution> => {
        const signal = signalFor(opts.signal);
        const count = await pageCount(signal);
        if (!count) throw new RangeError('This PDF has no pages.');
        const page = Math.min(count - 1, Math.max(0, Math.floor(Number.isFinite(anchor.physicalPageIndex) ? anchor.physicalPageIndex : 0)));
        center = page;
        return resolvePdfTextAnchor(await getPage(page, signal, 0), { ...anchor, physicalPageIndex: page }, { ...opts, signal });
    };
    return {
        generation: source.generation, getPageCount: pageCount, getPage, findEngine, resolveAnchor,
        async navigate(anchor) { return (await resolveAnchor(anchor, { sameSchema: true })).anchor; },
        setWindow(index) { center = index; },
        setVisible(next) {
            if (lifetime.signal.aborted || next === visible) return;
            visible = next;
            findEngine.setVisible(next);
            if (next) { visibility = new AbortController(); if (hiddenTimer !== undefined) clearTimeout(hiddenTimer); hiddenTimer = undefined; }
            else { visibility.abort(); hiddenTimer = setTimeout(() => { findEngine.clearIndex(); hiddenTimer = undefined; }, 60_000); }
        },
        dispose() {
            lifetime.abort(); visibility.abort(); findEngine.dispose();
            if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
            cache.clear(); retainedBytes = 0;
        },
        diagnostics: () => ({ retainedPages: cache.size, retainedBytes, queued: 0, active: active > 0, extractions }),
    };
}
