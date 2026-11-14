import type { PageDisplayList, Rect } from '../../platform/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardRuntime } from '../host/runtime';
import type { MediaEntry } from '../model/media';
import { measureBoardPaintBounds } from '../render/worldBounds';
import type { PaintNodeSource } from '../render/paintStream';
import { createBoardExportSnapshot } from './boardSnapshot';
import type { DisplayPdfWriter } from './capturePdf';
import { createExportImageResolver } from './exportImage';
import type { PagedPrintStreamWriter } from './pagedPrintSnapshot';
import { streamIncrementalPdf, type IncrementalPdfWriter } from './incrementalPdf';
import type { BoardPrintSource } from './print';
import { snapshotPaintSource } from './snapshot';
import { streamPageDisplayList } from './streamPage';
import { streamRasterPng } from './streamRaster';

export interface NativeNotebookPrintOptions {
    readonly runtime: BoardRuntime;
    readonly memory: MemoryAllocator;
    readonly writer: DisplayPdfWriter | PagedPrintStreamWriter | IncrementalPdfWriter;
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly onError: (error: unknown) => void;
}

/** A notebook print command captures paper, all sheets and media before yielding. */
export function pinNativeNotebookPrint(options: NativeNotebookPrintOptions): BoardPrintSource {
    const { runtime } = options, doc = runtime.session.doc, scene = runtime.scene;
    if (doc.host.kind !== 'notebook' || !scene || !scene.ready || scene.revision !== doc.rev || !scene.layout)
        throw new Error('Notebook print scene is not ready');
    const selection = runtime.selection.getSnapshot();
    if (!doc.sheets.has(selection.sheet)) throw new Error('Notebook print sheet is unavailable');
    const selected = selection.selected.length ? [...selection.selected] : null;
    const pages = scene.layout.rects.map(rect => ({ ...rect }));
    if (pages.length !== doc.host.paper.pageCount || !pages.length) throw new Error('Notebook print page geometry is unavailable');
    const pin = createBoardExportSnapshot({ runtime, request: { sheetId: selection.sheet, theme: 'light' },
        ...(selected ? { selectedNodeIds: selected } : {}), includeNotebookPaper: !selected,
        readMedia: options.readMedia, onError: options.onError });
    const snapshot = pin(), lifetime = new AbortController(), writer = options.writer, memory = options.memory;
    let released = false, boundsWork: Promise<Readonly<Rect>> | undefined, selectionSource: Promise<PaintNodeSource> | undefined;
    const selectedSource = () => selectionSource ??= snapshotPaintSource(snapshot, lifetime.signal)
        .catch(error => { selectionSource = undefined; throw error; });
    const active = (signal: AbortSignal) => {
        if (released) throw new DOMException('Notebook print released', 'AbortError');
        return AbortSignal.any([signal, lifetime.signal]);
    };
    const selectedBounds = (signal: AbortSignal): Promise<Readonly<Rect>> => {
        if (!selected) throw new Error('Selection bounds requested for notebook pages');
        if (!boundsWork) boundsWork = (async () => {
            const source = await selectedSource();
            const result = await measureBoardPaintBounds(source, { memory, signal: lifetime.signal, toleranceWorld: 0.01 });
            lifetime.signal.throwIfAborted();
            const box = result.bounds, error = result.errorWorld;
            if (!box || !box.every(Number.isFinite) || !Number.isFinite(error) || error < 0) throw new Error('Nothing to print');
            const world = { x: box[0] - error, y: box[1] - error,
                width: box[2] - box[0] + 2 * error, height: box[3] - box[1] + 2 * error };
            if (!(world.width > 0 && world.height > 0)) throw new Error('Nothing to print');
            return Object.freeze(world);
        })().catch(error => { boundsWork = undefined; throw error; });
        const work = boundsWork;
        return new Promise((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Notebook print cancelled', 'AbortError')); };
            signal.addEventListener('abort', abort, { once: true });
            work.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
                error => { signal.removeEventListener('abort', abort); reject(error); });
            if (signal.aborted) abort();
        });
    };
    const worldAt = async (page: number, signal: AbortSignal): Promise<Readonly<Rect>> => {
        if (!Number.isSafeInteger(page) || page < 0 || page >= (selected ? 1 : pages.length)) throw new RangeError('Invalid notebook print page');
        return selected ? selectedBounds(signal) : pages[page];
    };
    const sourceAt = async (page: number, world: Readonly<Rect>, signal: AbortSignal) => {
        const source = selected ? await selectedSource() : await snapshotPaintSource(snapshot, signal, { world, page });
        signal.throwIfAborted();
        return source;
    };
    return {
        pageCount: selected ? 1 : pages.length,
        async pdf(signal) {
            const combined = active(signal), total = selected ? 1 : pages.length;
            const image = createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, combined);
            const render = async (page: number) => {
                const world = await worldAt(page, combined), source = await sourceAt(page, world, combined);
                const displayList = await streamPageDisplayList(source, page, world, 1, image, combined);
                return { width: world.width, height: world.height, displayList };
            };
            let bytes: Uint8Array;
            if (typeof writer !== 'function' && 'kind' in writer && writer.kind === 'incremental-pdf') {
                bytes = await streamIncrementalPdf({ revision: snapshot.revision, pageCount: total,
                    async page(page, pageSignal) {
                        const world = await worldAt(page, pageSignal), source = await sourceAt(page, world, pageSignal);
                        return { source, world };
                    } }, 1, image, writer, combined);
            } else if (typeof writer === 'function') {
                const output: { width: number; height: number; displayList: PageDisplayList }[] = [];
                for (let page = 0; page < total; page++) output.push(await render(page));
                bytes = await writer({ schema: 1, pages: output }, { signal: combined });
            } else {
                const stream = await writer.open({ revision: snapshot.revision, pageCount: total }, combined);
                if (!('append' in stream)) { await stream.cancel(); throw new TypeError('Unsupported notebook print writer'); }
                let finished = false;
                try {
                    for (let page = 0; page < total; page++) await stream.append(await render(page), combined);
                    bytes = await stream.finish(combined); combined.throwIfAborted(); finished = true;
                } finally { if (!finished) await stream.cancel(); }
            }
            combined.throwIfAborted();
            return new Blob([bytes.slice().buffer], { type: 'application/pdf' });
        },
        async pngPage(page, signal) {
            const combined = active(signal), world = await worldAt(page, combined), source = await sourceAt(page, world, combined);
            return streamRasterPng(source, snapshot.images, world, 200 / 72, combined, { background: '#ffffff' });
        },
        release() { if (!released) { released = true; lifetime.abort(); snapshot.release(); } },
    };
}
