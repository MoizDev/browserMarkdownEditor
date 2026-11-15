export interface BoardPrintSource {
    /** Must use one synchronously pinned export revision. */
    pdf(signal: AbortSignal): Promise<Blob>;
    readonly pageCount: number;
    /** Fallback pages are rendered from that same pin at 200 dpi. `maxSide` caps the longer side in pixels (the thumbnails ask for one). */
    pngPage(page: number, signal: AbortSignal, maxSide?: number): Promise<Blob>;
    release(): void;
}
