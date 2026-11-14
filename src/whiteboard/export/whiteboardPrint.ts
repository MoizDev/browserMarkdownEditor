import type { Rect } from '../../platform/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardRuntime } from '../host/runtime';
import type { MediaEntry } from '../model/media';
import type { PaintNodeSource } from '../render/paintStream';
import { measureBoardPaintBounds } from '../render/worldBounds';
import { createBoardExportSnapshot } from './boardSnapshot';
import type { DisplayPdfWriter } from './capturePdf';
import { createExportImageResolver } from './exportImage';
import { streamIncrementalPdf, type IncrementalPdfWriter } from './incrementalPdf';
import { createLazyIncrementalPdfWriter } from './lazyPdfWriter';
import type { BoardPrintSource } from './print';
import { snapshotPaintSource } from './snapshot';
import { streamPageDisplayList } from './streamPage';
import { streamRasterPng } from './streamRaster';

export interface NativeWhiteboardPrintOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly writer?: DisplayPdfWriter | IncrementalPdfWriter;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly onError: (error: unknown) => void;
}

/** Print is always light; this captures the selected roots or current sheet before any await. */
export function pinNativeWhiteboardPrint(options: NativeWhiteboardPrintOptions): BoardPrintSource {
    const { runtime, memory } = options, writer = options.writer ?? createLazyIncrementalPdfWriter(), doc = runtime.session.doc, scene = runtime.scene;
    if (doc.host.kind !== 'whiteboard' || !scene || !scene.ready || scene.revision !== doc.rev)
        throw new Error('Whiteboard print scene is not ready');
    const selection = runtime.selection.getSnapshot();
    if (!doc.sheets.has(selection.sheet)) throw new Error('Whiteboard print sheet is unavailable');
    const selected = selection.selected.length ? [...selection.selected] : null;
    const pin = createBoardExportSnapshot({ runtime, request: { sheetId: selection.sheet, theme: 'light' },
        ...(selected ? { selectedNodeIds: selected } : {}), readMedia: options.readMedia, onError: options.onError });
    const snapshot = pin(), lifetime = new AbortController();
    let released = false, sourceWork: Promise<PaintNodeSource> | undefined, boundsWork: Promise<Readonly<Rect>> | undefined;
    const active = (signal: AbortSignal) => {
        if (released) throw new DOMException('Whiteboard print released', 'AbortError');
        return AbortSignal.any([signal, lifetime.signal]);
    };
    const source = () => sourceWork ??= snapshotPaintSource(snapshot, lifetime.signal)
        .catch(error => { sourceWork = undefined; throw error; });
    const bounds = () => boundsWork ??= (async () => {
        const paint = await source();
        const measured = await measureBoardPaintBounds(paint, { memory, signal: lifetime.signal, toleranceWorld: 0.01 });
        lifetime.signal.throwIfAborted();
        const box = measured.bounds, error = measured.errorWorld;
        if (!box || !box.every(Number.isFinite) || !Number.isFinite(error) || error < 0) throw new Error('Nothing to print');
        const world = { x: box[0] - error, y: box[1] - error,
            width: box[2] - box[0] + 2 * error, height: box[3] - box[1] + 2 * error };
        if (!(world.width > 0 && world.height > 0)) throw new Error('Nothing to print');
        return Object.freeze(world);
    })().catch(error => { boundsWork = undefined; throw error; });
    return {
        pageCount: 1,
        async pdf(signal) {
            const combined = active(signal), world = await bounds(), paint = await source();
            combined.throwIfAborted();
            const images = createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, combined);
            let bytes: Uint8Array;
            if (typeof writer !== 'function' && writer.kind === 'incremental-pdf') {
                bytes = await streamIncrementalPdf({ revision: snapshot.revision, pageCount: 1,
                    async page() { return { source: paint, world, outputScale: 0.75 }; } }, 0.75, images, writer, combined);
            } else if (typeof writer === 'function') {
                const page = await streamPageDisplayList(paint, 0, world, 0.75, images, combined);
                bytes = await writer({ schema: 1, pages: [{ width: world.width * 0.75, height: world.height * 0.75,
                    displayList: { page: 0, items: [{ kind: 'group', transform: [0.75, 0, 0, 0.75, 0, 0], items: page.items }] } }] }, { signal: combined });
            } else throw new TypeError('Unsupported whiteboard print writer');
            combined.throwIfAborted();
            return new Blob([bytes.slice().buffer], { type: 'application/pdf' });
        },
        async pngPage(page, signal) {
            if (page !== 0) throw new RangeError('Invalid whiteboard print page');
            const combined = active(signal), world = await bounds(), paint = await source();
            combined.throwIfAborted();
            return streamRasterPng(paint, snapshot.images, world, 200 / 96, combined, { background: '#ffffff' });
        },
        release() { if (!released) { released = true; lifetime.abort(); snapshot.release(); } },
    };
}
