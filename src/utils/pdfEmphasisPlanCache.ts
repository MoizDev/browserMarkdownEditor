import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfEmphasisPlan } from './pdfNativeEmphasis';

type Entry = { plan?: PdfEmphasisPlan; bytes: number };
const pages = new WeakMap<PDFPageProxy, Entry>();
const lru = new Map<Entry, number>();
let used = 0;
const budget = 16 * 1024 * 1024;

/** Entries contain only operation metadata, never a page, display list, font,
 * context or render cursor. The page owner invalidates at cleanup. */
export function getPdfEmphasisPlan(page: PDFPageProxy): PdfEmphasisPlan | undefined {
    const entry = pages.get(page);
    if (!entry?.plan) return undefined;
    lru.delete(entry);
    lru.set(entry, entry.bytes);
    return entry.plan;
}
export function rememberPdfEmphasisPlan(page: PDFPageProxy, plan: PdfEmphasisPlan): boolean {
    forgetPdfEmphasisPlan(page);
    let bytes = 256;
    for (const font of plan.fontIds.values()) bytes += 80 + font.length * 2;
    for (const paints of plan.paints.values()) {
        bytes += 64;
        for (const paint of paints) bytes += 64 + paint.char.length * 2;
    }
    if (bytes > budget) return false;
    const entry: Entry = { plan, bytes };
    pages.set(page, entry);
    lru.set(entry, bytes);
    used += bytes;
    while (used > budget) {
        const oldest = lru.keys().next().value as Entry | undefined;
        if (!oldest) break;
        lru.delete(oldest);
        used -= oldest.bytes;
        oldest.plan = undefined;
    }
    return true;
}
export function forgetPdfEmphasisPlan(page: PDFPageProxy): void {
    const entry = pages.get(page);
    if (!entry) return;
    if (lru.delete(entry)) used -= entry.bytes;
    entry.plan = undefined;
    pages.delete(page);
}
