import { flushRecord, readRecord, scopedKey, writeStoredValue } from './storage';

const POSITIONS_KEY = 'pdfViewPositions';
const THUMBNAILS_KEY = 'pdfThumbnailsOpen';

export interface PdfViewPos {
    page: number;
    offset: number;
    zoom?: number;
}

export function readPdfViewPos(path: string): PdfViewPos | undefined {
    const pos = readRecord<PdfViewPos>(POSITIONS_KEY)[scopedKey(path)];
    if (!pos || !Number.isFinite(pos.page)) return undefined;
    return {
        page: Math.max(0, Math.floor(pos.page)),
        offset: Number.isFinite(pos.offset) ? Math.min(1, Math.max(0, pos.offset)) : 0,
        zoom: typeof pos.zoom === 'number' && Number.isFinite(pos.zoom) ? Math.max(0.4, Math.min(4, pos.zoom)) : undefined,
    };
}

export function writePdfViewPos(path: string, pos: PdfViewPos, flush = true): void {
    readRecord<PdfViewPos>(POSITIONS_KEY)[scopedKey(path)] = {
        page: pos.page,
        offset: Math.round(pos.offset * 1000) / 1000,
        ...(pos.zoom !== undefined ? { zoom: Math.round(pos.zoom * 1000) / 1000 } : {}),
    };
    if (flush) flushRecord(POSITIONS_KEY);
}

export function flushPdfViewPositions(): void {
    flushRecord(POSITIONS_KEY);
}

export function readThumbnailsOpen(): boolean {
    try {
        return localStorage.getItem(THUMBNAILS_KEY) === 'true';
    } catch {
        return false;
    }
}

export function writeThumbnailsOpen(open: boolean): void {
    writeStoredValue(THUMBNAILS_KEY, String(open));
}

const INVERT_KEY = 'pdfInverted';

let inverted = (() => {
    try {
        return localStorage.getItem(INVERT_KEY) === 'true';
    } catch {
        return false;
    }
})();
const invertListeners = new Set<() => void>();

export function getPdfInverted(): boolean {
    return inverted;
}

export function setPdfInverted(next: boolean): void {
    if (next === inverted) return;
    inverted = next;
    writeStoredValue(INVERT_KEY, String(next));
    for (const listener of invertListeners) listener();
}

export function subscribePdfInverted(listener: () => void): () => void {
    invertListeners.add(listener);
    return () => { invertListeners.delete(listener); };
}

const navigationRevisions = new Map<string, number>();
export type PdfNavigationCause = 'user-scroll' | 'user-navigation' | 'search' | 'link' | 'annotation';
export function readPdfNavigationRevision(path: string): number {
    return navigationRevisions.get(scopedKey(path)) ?? 0;
}
export function recordPdfNavigation(path: string, _cause: PdfNavigationCause): number {
    const revision = readPdfNavigationRevision(path) + 1;
    navigationRevisions.set(scopedKey(path), revision);
    return revision;
}
