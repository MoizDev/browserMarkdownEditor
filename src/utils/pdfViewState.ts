// Where a PDF was left, and whether its page strip is open — ONE record shared
// by the reader (PdfViewer) and the annotate canvas.
//
// Shared because they are two views of one document: pressing annotate on page
// 212 has to land on page 212, and leaving annotate on page 40 has to reopen the
// reader on page 40. Each used to keep its own idea of "where", so annotate
// opened on whatever its snapshot's camera last said — or, on a first open,
// zoomed out to fit every page of the document at once.
//
// Imports nothing heavy: both the reader and the annotate chunk load it, and it
// must not drag pdf.js or tldraw into the other.

import { flushRecord, readRecord, scopedKey } from './storage';

const POSITIONS_KEY = 'pdfViewPositions';
const THUMBNAILS_KEY = 'pdfThumbnailsOpen';

export interface PdfViewPos {
    /** 0-based index of the page under the top edge of the view. */
    page: number;
    /** How far into that page the top edge sits, as a fraction of its height. */
    offset: number;
    /** Zoom on top of fit-width (1 = fit width). */
    zoom?: number;
}

/** Where `path` was left, if anywhere. Values are the user's to edit in
 *  localStorage, so callers still clamp `page` to the document they have. */
export function readPdfViewPos(path: string): PdfViewPos | undefined {
    const pos = readRecord<PdfViewPos>(POSITIONS_KEY)[scopedKey(path)];
    if (!pos || !Number.isFinite(pos.page)) return undefined;
    return {
        page: Math.max(0, Math.floor(pos.page)),
        offset: Number.isFinite(pos.offset) ? Math.min(1, Math.max(0, pos.offset)) : 0,
        zoom: Number.isFinite(pos.zoom) ? pos.zoom : undefined,
    };
}

/**
 * Record where `path` is.
 *
 * `flush: false` updates only the in-memory record — a property write, cheap
 * enough for every frame of a pan. That is what the annotate canvas does, and it
 * matters: the reader reads this record WHILE RENDERING, in the very commit that
 * unmounts the canvas, so a position that only reached memory on a debounce
 * would reopen the reader a page or two behind. Disk can lag; memory must not.
 */
export function writePdfViewPos(path: string, pos: PdfViewPos, flush = true): void {
    // The record is held parsed in memory — mutate and write, no re-parse.
    readRecord<PdfViewPos>(POSITIONS_KEY)[scopedKey(path)] = {
        page: pos.page,
        offset: Math.round(pos.offset * 1000) / 1000,
        ...(pos.zoom !== undefined ? { zoom: Math.round(pos.zoom * 1000) / 1000 } : {}),
    };
    if (flush) flushRecord(POSITIONS_KEY);
}

/** Write whatever `writePdfViewPos(…, false)` has accumulated. */
export function flushPdfViewPositions(): void {
    flushRecord(POSITIONS_KEY);
}

/** Whether the page strip is open. One app-wide preference, not per file: it
 *  is about how you like to read, and a strip that opened on some PDFs and not
 *  others would read as broken. A blocked localStorage just means closed. */
export function readThumbnailsOpen(): boolean {
    try {
        return localStorage.getItem(THUMBNAILS_KEY) === 'true';
    } catch {
        return false;
    }
}

export function writeThumbnailsOpen(open: boolean): void {
    try {
        localStorage.setItem(THUMBNAILS_KEY, String(open));
    } catch { /* the toggle still works for this session */ }
}
