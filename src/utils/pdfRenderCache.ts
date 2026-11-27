import type { PageOverlay } from './pdfOverlay';

export interface PdfRenderData {
    original: Uint8Array;
    overlays: Array<PageOverlay | undefined>;
}

const renderCache = new Map<string, PdfRenderData>();

export function setPdfRenderData(path: string, data: PdfRenderData): void {
    renderCache.set(path, data);
}

export function getPdfRenderData(path: string): PdfRenderData | undefined {
    return renderCache.get(path);
}

export function clearPdfRenderData(path: string): void {
    renderCache.delete(path);
}

export function movePdfRenderData(from: string, to: string): void {
    const data = renderCache.get(from);
    if (!data) return;
    renderCache.delete(from);
    renderCache.set(to, data);
}
