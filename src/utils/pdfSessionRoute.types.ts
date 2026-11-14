import type { PdfViewer } from './engineRouting';

/** App owns this slot for a document session; pane remounts only read it. */
export interface PdfRouteSession {
    getSlot<T>(key: symbol): T | undefined;
    setSlot<T>(key: symbol, value: T): void;
}

export type PdfRouteReader = (session: PdfRouteSession) => PdfViewer | undefined;
