export interface BoardPrintSource {
    /** Must use one synchronously pinned export revision. */
    pdf(signal: AbortSignal): Promise<Blob>;
    readonly pageCount: number;
    /** Fallback pages are rendered from that same pin at 200 dpi. */
    pngPage(page: number, signal: AbortSignal): Promise<Blob>;
    release(): void;
}
