import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { bindPdfNativeEmphasis, makePdfEmphasisPlan } from './pdfNativeEmphasis';
import { completedClassicDisplayList } from './pdfClassicDisplayList';
import { rememberPdfEmphasisPlan } from './pdfEmphasisPlanCache';
import type { PdfEmphasisPlan, PdfNativeEmphasisResult } from './pdfNativeEmphasis';

/** One bounded, whole-page final-composition comparison. It owns its canvases
 * and render tasks; the caller must retain the page lease until it settles. */
export async function probeClassicPdfEmphasis(page: PDFPageProxy, signal: AbortSignal, suppliedPlan?: PdfEmphasisPlan,
    guard: <T>(work: Promise<T>) => Promise<T> = work => work, assertComplete: () => void = () => {}): Promise<PdfNativeEmphasisResult> {
    signal.throwIfAborted();
    const base = page.getViewport({ scale: 1 });
    let scale = Math.min(1.5, Math.sqrt(2 ** 20 / (base.width * base.height)));
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('page-budget');
    let viewport = page.getViewport({ scale });
    let width = Math.max(1, Math.ceil(viewport.width)), height = Math.max(1, Math.ceil(viewport.height));
    // Integer canvas rounding can exceed the nominal area by a row/column.
    // Reduce only as far as necessary; never allocate beyond the proof budget.
    if (width * height > 2 ** 20) {
        let low = 0, high = scale;
        for (let n = 0; n < 32; n++) {
            const mid = (low + high) / 2;
            if (Math.max(1, Math.ceil(base.width * mid)) * Math.max(1, Math.ceil(base.height * mid)) <= 2 ** 20) low = mid;
            else high = mid;
        }
        scale = low;
        if (!(scale > 0)) throw new Error('page-budget');
        viewport = page.getViewport({ scale });
        width = Math.max(1, Math.ceil(viewport.width)); height = Math.max(1, Math.ceil(viewport.height));
    }
    if (width * height > 2 ** 20) throw new Error('page-budget');
    const off = document.createElement('canvas');
    const on = document.createElement('canvas');
    off.width = on.width = width;
    off.height = on.height = height;
    const offCtx = off.getContext('2d'), onCtx = on.getContext('2d');
    if (!offCtx || !onCtx) {
        off.width = off.height = on.width = on.height = 0;
        throw new Error('Could not allocate PDF emphasis probe');
    }
    let task: RenderTask | undefined;
    let binding: ReturnType<typeof bindPdfNativeEmphasis> | undefined;
    const cancel = () => task?.cancel();
    signal.addEventListener('abort', cancel);
    try {
        signal.throwIfAborted();
        task = page.render({ canvas: off, canvasContext: offCtx, viewport });
        await guard(task.promise);
        assertComplete();
        signal.throwIfAborted();
        const list = completedClassicDisplayList(task);
        if (!list) throw new Error('renderer-version');
        const plan = suppliedPlan ?? makePdfEmphasisPlan(list);
        if (!plan.result.supported) throw new Error(plan.result.reason ?? 'glyph-data');
        if (!rememberPdfEmphasisPlan(page, plan)) throw new Error('page-budget');
        binding = bindPdfNativeEmphasis(page, onCtx, plan);
        signal.throwIfAborted();
        task = page.render({ canvas: on, canvasContext: onCtx, viewport, operationsFilter: binding.operationsFilter });
        await guard(task.promise);
        assertComplete();
        signal.throwIfAborted();
        let different = false;
        for (let y = 0; y < off.height && !different; y += 64) {
            signal.throwIfAborted();
            const height = Math.min(64, off.height - y);
            const a = offCtx.getImageData(0, y, off.width, height).data;
            const b = onCtx.getImageData(0, y, on.width, height).data;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { different = true; break; }
        }
        return { ...binding.result, eligible: different ? binding.result.eligible : 0,
            painted: different ? binding.result.painted : 0 };
    } finally {
        signal.removeEventListener('abort', cancel);
        if (task) { task.cancel(); await task.promise.catch(() => {}); }
        binding?.dispose();
        off.width = off.height = on.width = on.height = 0;
    }
}
