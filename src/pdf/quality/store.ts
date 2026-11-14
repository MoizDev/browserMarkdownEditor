import type { PdfiumJbig2Regions } from '../engine/pdfium/imageRegions.types';
import type { PageTileResult } from '../worker/protocol';
import { createPdfPageQuality } from './pageQuality';
import type { PdfPageQualitySnapshot } from './pageQuality';

const quality = createPdfPageQuality();
const unknown: Readonly<PdfPageQualitySnapshot> = Object.freeze({ state: 'unknown', complete: false });
// Only non-default snapshots are held. The controller admits at most 256 pages.
const snapshots = new Map<string, Map<number, Readonly<PdfPageQualitySnapshot>>>();
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* One subscriber must not prevent the others from observing a transition. */ }
    }
}
function update(docKey: string, page: number): void {
    const value = quality.snapshot(docKey, page), group = snapshots.get(docKey);
    const previous = group?.get(page) ?? unknown;
    if (previous.state === value.state && previous.complete === value.complete && previous.reason === value.reason) return;
    if (value.state === 'unknown' && !value.complete && value.reason === undefined) {
        group?.delete(page);
        if (group && !group.size) snapshots.delete(docKey);
    } else {
        const target = group ?? new Map<number, Readonly<PdfPageQualitySnapshot>>();
        if (!group) snapshots.set(docKey, target);
        target.set(page, Object.freeze({ ...value }));
    }
    notify();
}

export function setPdfPageRegions(docKey: string, page: number, regions: PdfiumJbig2Regions): void {
    quality.setRegions(docKey, page, regions);
    update(docKey, page);
}
export function observePdfPageTile(docKey: string, page: number, tile: PageTileResult): void {
    quality.observeTile(docKey, page, tile);
    update(docKey, page);
}
/** useSyncExternalStore may read repeatedly: unchanged values retain the same identity. */
export function getPdfPageQuality(docKey: string, page: number): Readonly<PdfPageQualitySnapshot> {
    return snapshots.get(docKey)?.get(page) ?? unknown;
}
export function subscribePdfPageQuality(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function releasePdfPageQuality(docKey: string): void {
    quality.clear(docKey);
    if (snapshots.delete(docKey)) notify();
}
