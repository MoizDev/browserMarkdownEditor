import type { PdfFindEngine } from './pdfFind';
import type { PdfTextAnchorOptions, PdfTextAnchorResolution } from './pdfTextAnchors';
import type { PdfPageText } from './pdfPageText';

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
    queryId: string; hits: readonly PdfFindHit[]; totalHits: number; done: boolean; pagesDone: number;
    pagesTotal: number; truncated: boolean; unavailablePages: readonly number[]; textlessPages: number;
}
export interface PdfTextReaderOptions {
    initialPageIndex: number;
    onStatus?: (status: { phase: 'loading' | 'ready' | 'partial' | 'error'; message?: string; progress?: { done: number; total?: number } }) => void;
}
export interface PdfTextReader {
    readonly generation: number;
    getPageCount(signal?: AbortSignal): Promise<number>;
    getPage(index0: number, signal?: AbortSignal, priority?: 0 | 1 | 2 | 3): Promise<PdfTextPage>;
    readonly findEngine: PdfFindEngine;
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

export function pdfTextAnchor(page: Pick<PdfPageText, 'text' | 'physicalPageIndex'>, offsetUTF16 = 0, alignHint = 0): PdfTextAnchor {
    let offset = Math.max(0, Math.min(page.text.length, Math.floor(offsetUTF16)));
    // DOM offsets are UTF-16; do not leave the caret inside a surrogate pair.
    if (offset && /[\uDC00-\uDFFF]/u.test(page.text[offset] ?? '') && /[\uD800-\uDBFF]/u.test(page.text[offset - 1])) offset--;
    return { physicalPageIndex: page.physicalPageIndex, offsetUTF16: offset, affinity: 'after',
        quote: page.text.slice(offset, offset + 48), before: page.text.slice(Math.max(0, offset - 48), offset),
        after: page.text.slice(offset + 48, offset + 96), alignHint };
}
