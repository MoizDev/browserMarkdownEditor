import type { VectorOp } from './pdfVector';

export interface PdfDisplayGeometry {
    width: number;
    height: number;
    toUserSpace: [number, number, number, number, number, number];
    rotation: number;
    userUnit: number;
    pageIndex: number;
    sourceFingerprint: string;
    engine: string;
}

export interface PageOverlay {
    geometry?: PdfDisplayGeometry;
    vector?: VectorOp[];
    raster?: Uint8Array;
    layers?: PageOverlay[];
}

export function isEmptyOverlay(overlay: PageOverlay | undefined): boolean {
    return !overlay || (!overlay.vector?.length && !overlay.raster?.length && !overlay.layers?.some(layer => !isEmptyOverlay(layer)));
}
