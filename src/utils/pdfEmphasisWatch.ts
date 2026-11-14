import type { PdfDocumentSession } from './pdfDocumentSession';
import { classicEmphasisKey, classicEmphasisResult } from './pdfEmphasisProfile';
import { probeClassicPdfEmphasis } from './pdfEmphasisProbe';
import { getPdfEmphasisPlan } from './pdfEmphasisPlanCache';
import type { PdfNativeEmphasisResult } from './pdfNativeEmphasis';
import type { PdfEmphasisIdentity } from './pdfEmphasisIdentity';

function afterPaint(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => {
            cancelAnimationFrame(frame);
            if (timer !== undefined) clearTimeout(timer);
            reject(new DOMException('PDF probe cancelled', 'AbortError'));
        };
        const frame = requestAnimationFrame(() => {
            timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 0);
        });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    });
}

/** The visible consumer owns a watch, not the render task. A zoom cancels its
 * raster without restarting this whole-page proof; leaving the page releases
 * the watch and cancels only when its last consumer has gone. */
export function watchPdfEmphasis(session: PdfDocumentSession, identity: PdfEmphasisIdentity, index: number,
    publish: (result: PdfNativeEmphasisResult | undefined) => void): () => void {
    const lifetime = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let release: (() => void) | undefined;
    void (async () => {
        const geometry = await session.acquirePage(index, 'render', lifetime.signal);
        let profile: string;
        try {
            const page = geometry.page;
            profile = JSON.stringify([page.view, page.rotate, page.userUnit]);
        } finally { geometry.release(); }
        lifetime.signal.throwIfAborted();
        let key = classicEmphasisKey(identity.token, index, profile);
        const notify = () => { if (!lifetime.signal.aborted) publish(classicEmphasisResult(session.emphasisVerdicts.getVerdict(key))); };
        unsubscribe = session.emphasisVerdicts.subscribe(key, notify);
        notify();
        release = session.emphasisVerdicts.ensureVerdict(key, async signal => {
            await afterPaint(signal);
            const lease = await session.acquireRender(index, signal);
            try { return await probeClassicPdfEmphasis(lease.page, signal, getPdfEmphasisPlan(lease.page),
                work => session.health.guard(work), () => session.health.assertComplete(index)); }
            finally { lease.release(); }
        });
        void identity.hash.then(hash => {
            if (lifetime.signal.aborted) return;
            const hashed = classicEmphasisKey(hash, index, profile);
            if (session.emphasisVerdicts.promote(key, hashed)) key = hashed;
        }).catch(() => {});
    })().catch(error => {
        if (!lifetime.signal.aborted) {
            console.error('Could not start PDF emphasis probe:', error);
            publish({ glyphs: 0, candidates: 0, painted: 0, eligible: 0, skipped: 0, supported: false, reason: 'glyph-data' });
        }
    });
    return () => {
        lifetime.abort();
        unsubscribe?.();
        release?.();
    };
}
