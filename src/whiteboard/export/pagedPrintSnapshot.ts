import type { PageDisplayList, Rect } from '../../platform/types';
import type { DisplayPdfWriter } from './capturePdf';
import { createExportImageResolver } from './exportImage';
import type { BoardPrintSource } from './print';
import { snapshotPaintSource, type PinExportSnapshot } from './snapshot';
import { streamPageDisplayList } from './streamPage';
import { streamRasterPng } from './streamRaster';

/** The supplied pin includes all sheets and the host's real backdrop at one revision. */
export function pinPagedPrintSource(pin: PinExportSnapshot, pageRects: readonly Readonly<Rect>[], writer: DisplayPdfWriter): BoardPrintSource {
    const pages = pageRects.map(page => ({ ...page }));
    if (!pages.length || pages.some(page => ![page.x, page.y, page.width, page.height].every(Number.isFinite)
        || page.width <= 0 || page.height <= 0)) throw new RangeError('Invalid print pages');
    const snapshot = pin(), lifetime = new AbortController();
    let released = false;
    const active = (signal: AbortSignal) => {
        if (released) throw new DOMException('Print snapshot released', 'AbortError');
        return AbortSignal.any([signal, lifetime.signal]);
    };
    return {
        pageCount: pages.length,
        async pdf(signal) {
            const combined = active(signal), source = await snapshotPaintSource(snapshot, combined);
            const images = createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, combined);
            const output: { width: number; height: number; displayList: PageDisplayList }[] = [];
            for (let page = 0; page < pages.length; page++) {
                combined.throwIfAborted();
                const world = pages[page];
                output.push({ width: world.width, height: world.height,
                    displayList: await streamPageDisplayList(source, page, world, 1, images, combined) });
            }
            const bytes = await writer({ schema: 1, pages: output }, { signal: combined });
            combined.throwIfAborted();
            return new Blob([bytes.slice().buffer], { type: 'application/pdf' });
        },
        async pngPage(page, signal) {
            const world = pages[page];
            if (!Number.isSafeInteger(page) || !world) throw new RangeError('Invalid print page');
            const combined = active(signal), source = await snapshotPaintSource(snapshot, combined);
            return streamRasterPng(source, snapshot.images, world, 200 / 72, combined, { background: '#ffffff' });
        },
        release() { if (!released) { released = true; lifetime.abort(); snapshot.release(); } },
    };
}
