/** Heuristic candidate bounds, clipped to the page, not evidence of decode failure. */
export interface PdfiumJbig2Region {
    readonly id: number;
    readonly box: readonly [number, number, number, number];
}
export interface PdfiumJbig2Regions {
    readonly regions: readonly PdfiumJbig2Region[];
    /** Enumeration could not establish all candidates within its work budget. */
    readonly partial: boolean;
}
