import type { Rect } from '../../platform/types';
import type { DisplayPdfWriter } from './capturePdf';
import { createExportImageResolver } from './exportImage';
import type { BoardPrintSource } from './print';
import { snapshotPaintSource, type PinExportSnapshot } from './snapshot';
import { streamPageDisplayList } from './streamPage';
import { streamRasterPng } from './streamRaster';

/** A whiteboard print source takes exactly one scene/media lease for PDF and fallback. */
export function pinBoardPrintSource(pin: PinExportSnapshot, world: Readonly<Rect>, writer: DisplayPdfWriter): BoardPrintSource {
    const bounds = { ...world };
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0)
        throw new RangeError('Invalid print bounds');
    const snapshot = pin();
    let released = false;
    const lifetime = new AbortController();
    const check = (signal: AbortSignal) => {
        if (released) throw new DOMException('Print snapshot released', 'AbortError');
        return AbortSignal.any([signal, lifetime.signal]);
    };
    return {
        pageCount: 1,
        async pdf(signal) {
            const active = check(signal), source = await snapshotPaintSource(snapshot, active);
            const image = createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, active);
            const page = await streamPageDisplayList(source, 0, bounds, 0.75, image, active);
            const bytes = await writer({ schema: 1, pages: [{ width: bounds.width * 0.75, height: bounds.height * 0.75,
                displayList: { page: 0, items: [{ kind: 'group', transform: [0.75, 0, 0, 0.75, 0, 0], items: page.items }] } }] }, { signal: active });
            active.throwIfAborted();
            return new Blob([bytes.slice().buffer], { type: 'application/pdf' });
        },
        async pngPage(page, signal) {
            if (page !== 0) throw new RangeError('Invalid print page');
            const active = check(signal), source = await snapshotPaintSource(snapshot, active);
            return streamRasterPng(source, snapshot.images, bounds, 200 / 96, active, { background: '#ffffff' });
        },
        release() { if (!released) { released = true; lifetime.abort(); snapshot.release(); } },
    };
}
