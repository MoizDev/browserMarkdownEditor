export interface BoardPrintSource {
    pdf(signal: AbortSignal): Promise<Blob>;
    readonly pageCount: number;
    pngPage(page: number, signal: AbortSignal, maxSide?: number): Promise<Blob>;
    release(): void;
}
