export interface PdfiumJbig2Region {
    readonly id: number;
    readonly box: readonly [number, number, number, number];
}
export interface PdfiumJbig2Regions {
    readonly regions: readonly PdfiumJbig2Region[];
    readonly partial: boolean;
}
