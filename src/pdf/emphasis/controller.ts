import type { PdfPoolDocument } from '../pool/types';
import { getPdfFontEpoch, subscribePdfFontEpoch } from '../fonts/profiles';
import { validatePdfProbe } from '../pool/validateControl';
import { EMPHASIS_ALGORITHM, EMPHASIS_MAX_PROBE_PIXELS, EMPHASIS_REVISION, EMPHASIS_STROKE_EM } from './profile';
import type { EmphasisSpec, PageProbeResult } from './types';

export type PdfEmphasisCapability = { kind: 'active' | 'inactive' | 'unavailable' | 'unknown'; reason?: string };
export type PdfEmphasisVariant = { variant: 'plain'; profileKey: 'plain' } |
    { variant: 'emphasis'; profileKey: string; emphasis: EmphasisSpec };
export interface PdfEmphasisController {
    setVisiblePages(pages: readonly number[], focusedPage: number, visible: boolean): void;
    setEnabled(enabled: boolean): void;
    variant(page: number): PdfEmphasisVariant;
    capability(page: number): PdfEmphasisCapability;
    subscribe(listener: () => void): () => void;
    dispose(): void;
}

type Verdict = { result: PageProbeResult } | { error: true };
type Flight = { page: number; epoch: number; controller: AbortController; promise: Promise<PageProbeResult> };
const CACHE_LIMIT = 256, VISIBLE_LIMIT = 256;
const PLAIN: PdfEmphasisVariant = Object.freeze({ variant: 'plain', profileKey: 'plain' });
const REASONS: Record<NonNullable<PageProbeResult['reason']>, string> = {
    'no-text': 'No eligible visible text was found on this page.',
    'no-eligible-prefixes': 'No eligible word prefixes were found on this page.',
    'ambiguous-glyphs': 'This page’s glyph geometry cannot be safely emphasized.',
    'no-visible-change': 'No visible emphasis change was found at the bounded proof resolution.',
};

/** One controller belongs to one immutable document session, never a tile or pane.
 * Its abort signals own only its own pool waiters, not other consumers of the source. */
export function createPdfEmphasisController(document: PdfPoolDocument): PdfEmphasisController {
    const locale = new Intl.Segmenter(undefined, { granularity: 'word' }).resolvedOptions().locale;
    const emphasis: EmphasisSpec = Object.freeze({ algorithm: EMPHASIS_ALGORITHM, revision: EMPHASIS_REVISION,
        strokeEm: EMPHASIS_STROKE_EM, locale });
    const listeners = new Set<() => void>(), verdicts = new Map<number, Verdict>();
    let epoch = getPdfFontEpoch(document.docKey), enabled = false, visible = false, disposed = false;
    let pages: number[] = [], focused = -1, flight: Flight | undefined;
    const canCopy = () => !document.info.encrypted || (document.info.permissions !== null &&
        Number.isSafeInteger(document.info.permissions) && (document.info.permissions & 16) !== 0);
    const validPage = (page: number) => Number.isSafeInteger(page) && page >= 0 && page < document.info.pageCount;
    const key = (value: number) => JSON.stringify(['pdf-emphasis-v1', EMPHASIS_ALGORITHM, EMPHASIS_REVISION,
        EMPHASIS_STROKE_EM, locale, 'page-probe-v1', 'annotations-forms', 'opaque-white', value]);
    const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* Other subscribers still need the new state. */ } } };
    const cancel = () => { const old = flight; flight = undefined; old?.controller.abort(); };
    const remember = (page: number, verdict: Verdict) => {
        verdicts.delete(page); verdicts.set(page, verdict);
        while (verdicts.size > CACHE_LIMIT) verdicts.delete(verdicts.keys().next().value!);
    };
    const priority = (page: number): 0 | 3 => page === focused ? 0 : 3;
    const pump = () => {
        if (disposed || document.closed || !enabled || !visible || !canCopy() || flight) return;
        const ordered = pages.includes(focused) ? [focused, ...pages.filter(page => page !== focused)] : pages;
        const page = ordered.find(item => !verdicts.has(item));
        if (page === undefined) return;
        const controller = new AbortController(), currentEpoch = epoch;
        const args = { page, ...emphasis, profileKey: key(currentEpoch), maxPixels: EMPHASIS_MAX_PROBE_PIXELS };
        let promise: Promise<PageProbeResult>;
        try { promise = document.probe(args, { priority: priority(page), signal: controller.signal }); }
        catch { remember(page, { error: true }); notify(); queueMicrotask(pump); return; }
        const current: Flight = { page, epoch: currentEpoch, controller, promise };
        flight = current;
        notify();
        void promise.then(value => {
            if (flight !== current || controller.signal.aborted || disposed || document.closed || epoch !== currentEpoch) return;
            try { remember(page, { result: validatePdfProbe(value, { ...args, docKey: document.docKey }) }); }
            catch { remember(page, { error: true }); }
        }, () => {
            if (flight === current && !controller.signal.aborted && !disposed && !document.closed && epoch === currentEpoch) remember(page, { error: true });
        }).finally(() => {
            if (flight !== current) return;
            flight = undefined;
            if (!disposed) { notify(); pump(); }
        });
    };
    const unsubscribeFont = subscribePdfFontEpoch(document.docKey, () => {
        if (disposed) return;
        const next = getPdfFontEpoch(document.docKey);
        if (next === epoch) return;
        epoch = next; cancel(); verdicts.clear(); notify(); pump();
    });
    return {
        setVisiblePages(next, focusedPage, isVisible) {
            if (disposed) return;
            if (!Array.isArray(next) || next.length > VISIBLE_LIMIT || next.some(page => !validPage(page)) ||
                !Number.isSafeInteger(focusedPage) || focusedPage < -1 || focusedPage >= document.info.pageCount || typeof isVisible !== 'boolean') {
                throw new RangeError('Invalid PDF emphasis visibility');
            }
            const wasVisible = visible;
            pages = [...new Set(next)]; focused = focusedPage; visible = isVisible;
            if (!visible && wasVisible) {
                cancel();
                for (const [page, verdict] of verdicts) if ('error' in verdict) verdicts.delete(page);
            } else if (flight && (!pages.includes(flight.page) ||
                (pages.includes(focused) && focused !== flight.page && !verdicts.has(focused)))) cancel();
            if (flight) document.reprioritise(flight.promise, priority(flight.page));
            notify(); pump();
        },
        setEnabled(next) {
            if (disposed || enabled === next) return;
            enabled = next;
            if (!enabled) cancel();
            else for (const [page, verdict] of verdicts) if ('error' in verdict) verdicts.delete(page);
            notify(); pump();
        },
        variant(page) {
            if (disposed || document.closed || !enabled || !validPage(page) || !canCopy()) return PLAIN;
            const verdict = verdicts.get(page);
            return verdict && 'result' in verdict && verdict.result.capability === 'supported' && verdict.result.changedPixels > 0
                ? { variant: 'emphasis', profileKey: key(epoch), emphasis } : PLAIN;
        },
        capability(page) {
            if (disposed || document.closed) return { kind: 'unavailable', reason: 'PDF session is closed.' };
            if (!validPage(page)) return { kind: 'unavailable', reason: 'PDF page is unavailable.' };
            if (!canCopy()) return { kind: 'unavailable', reason: 'This PDF does not permit text extraction.' };
            const verdict = verdicts.get(page);
            if (!verdict) return { kind: 'unknown', reason: flight?.page === page ? 'Checking word emphasis…' : 'Word emphasis has not been checked on this page.' };
            if ('error' in verdict) return { kind: 'unavailable', reason: 'Word emphasis could not be verified. Retry when the page is available.' };
            if (verdict.result.capability === 'supported' && verdict.result.changedPixels > 0) return { kind: 'active' };
            return { kind: 'inactive', reason: verdict.result.reason ? REASONS[verdict.result.reason] : 'Word emphasis is unavailable on this page.' };
        },
        subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() { if (disposed) return; disposed = true; cancel(); unsubscribeFont(); verdicts.clear(); pages = []; listeners.clear(); },
    };
}
