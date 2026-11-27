import type { PdfViewer } from './engineRouting';

export interface PdfRouteSession {
    getSlot<T>(key: symbol): T | undefined;
    setSlot<T>(key: symbol, value: T): void;
}

export type PdfRouteReader = (session: PdfRouteSession) => PdfViewer | undefined;
