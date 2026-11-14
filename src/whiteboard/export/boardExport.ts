import type { Rect, Rgba } from '../../platform/types';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { BoardRuntime } from '../host/runtime';
import type { MediaEntry } from '../model/media';
import { colourCss } from '../render/colour';
import { measureBoardPaintBounds } from '../render/worldBounds';
import { createBoardExportSnapshot } from './boardSnapshot';
import { createExportImageResolver } from './exportImage';
import { ExportTooLarge, splicePngDensity } from './png';
import { snapshotPaintSource } from './snapshot';
import { streamRasterPng } from './streamRaster';
import { streamSvg } from './streamSvg';
import type { ExportRoute } from './scope';

export interface NativeBoardImageExportOptions {
    readonly runtime: BoardRuntime;
    readonly route: ExportRoute;
    readonly format: 'png' | 'svg';
    readonly theme: 'light' | 'dark';
    readonly background: Rgba;
    readonly transparent: boolean;
    readonly memory: MemoryAllocator;
    /** App-captured source survives a view close and never resolves an asset by filename alone. */
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly onError: (error: unknown) => void;
}
export interface NativeBoardImageExportResult {
    readonly blob: Blob;
    readonly revision: number;
    readonly scope: 'sheet' | 'selection';
    readonly world: Readonly<Rect>;
    readonly scale: number;
    /** Copy-as-PNG may reduce scale to the clipboard side limit. */
    readonly reduced: boolean;
}
export interface NativeBoardImageExportJob {
    readonly revision: number;
    run(signal: AbortSignal): Promise<NativeBoardImageExportResult>;
    runAs(format: 'png' | 'svg', signal: AbortSignal): Promise<NativeBoardImageExportResult>;
    release(): void;
}

function pageBounds(pages: readonly Readonly<Rect>[]): Rect {
    if (!pages.length) throw new Error('Nothing to export');
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const page of pages) {
        if (![page.x, page.y, page.width, page.height].every(Number.isFinite) || page.width <= 0 || page.height <= 0)
            throw new RangeError('Invalid notebook page geometry');
        left = Math.min(left, page.x); top = Math.min(top, page.y);
        right = Math.max(right, page.x + page.width); bottom = Math.max(bottom, page.y + page.height);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
}
function trim(bounds: readonly number[] | null, error: number): Rect {
    if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite) || !Number.isFinite(error) || error < 0)
        throw new Error('Nothing to export');
    const [left, top, right, bottom] = bounds;
    const width = right - left + 2 * error, height = bottom - top + 2 * error;
    if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Nothing to export');
    return { x: left - error, y: top - error, width, height };
}
function copyScale(world: Readonly<Rect>): number {
    const scale = Math.min(2, (8192 - 1e-7) / world.width, (8192 - 1e-7) / world.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new ExportTooLarge(0);
    return scale;
}

/** Capture one real C7 Scene/media lease before returning; the job never consults a live view. */
export function createNativeBoardImageExport(options: NativeBoardImageExportOptions): NativeBoardImageExportJob {
    const { runtime, format, route, transparent, memory } = options, doc = runtime.session.doc, scene = runtime.scene;
    if (!scene || !scene.ready || scene.revision !== doc.rev) throw new Error('Board export scene is not ready');
    if (doc.host.kind === 'pdf-ink') throw new Error('PDF-ink exports require the Core-composed backdrop source');
    const selection = runtime.selection.getSnapshot();
    const selected = route !== 'menu' && selection.selected.length > 0 ? [...selection.selected] : null;
    const sheet = selection.sheet, notebookPaper = doc.host.kind === 'notebook' ? doc.host.paper : null, notebook = notebookPaper !== null;
    if (!doc.sheets.has(sheet)) throw new Error('Board export sheet is unavailable');
    const paper = notebook && !selected;
    const pages = paper ? scene.layout?.rects.map(rect => ({ ...rect })) : undefined;
    if (paper && (!pages || pages.length !== notebookPaper!.pageCount)) throw new Error('Notebook export page geometry is unavailable');
    const fixedBounds = pages ? pageBounds(pages) : null;
    const background: Rgba = notebook ? [1, 1, 1, 1] : [options.background[0], options.background[1], options.background[2], options.background[3]];
    const pin = createBoardExportSnapshot({ runtime, request: { sheetId: sheet, theme: notebook ? 'light' : options.theme },
        ...(selected ? { selectedNodeIds: selected } : {}), includeNotebookPaper: paper,
        readMedia: options.readMedia, onError: options.onError });
    const snapshot = pin(), lifetime = new AbortController();
    let started = false, released = false;
    const release = () => { if (!released) { released = true; lifetime.abort(); snapshot.release(); } };
    const revision = snapshot.revision;
    const runAs = async (format: 'png' | 'svg', signal: AbortSignal): Promise<NativeBoardImageExportResult> => {
            if (released || started) throw new Error('Board image export job is no longer available');
            started = true;
            const active = AbortSignal.any([signal, lifetime.signal]);
            try {
                active.throwIfAborted();
                const source = await snapshotPaintSource(snapshot, active);
                active.throwIfAborted();
                let world = fixedBounds;
                if (!world) {
                    const measured = await measureBoardPaintBounds(source, { memory, signal: active, toleranceWorld: 0.01 });
                    active.throwIfAborted();
                    world = trim(measured.bounds, measured.errorWorld);
                }
                const color = paper || transparent ? undefined : background;
                const clipboard = route === 'copy' && format === 'png';
                const scale = format === 'svg' ? 1 : clipboard ? copyScale(world) : 2;
                let blob: Blob;
                if (format === 'png') {
                    blob = await streamRasterPng(source, snapshot.images, world, scale, active,
                        { clipboard, ...(color ? { background: colourCss(color) } : {}) });
                    if (clipboard) blob = await splicePngDensity(blob, world, active);
                } else {
                    const image = createExportImageResolver(snapshot.token, snapshot.images, snapshot.readImage, active);
                    blob = await streamSvg(source, world, scale, image, active, color);
                }
                active.throwIfAborted();
                return { blob, revision, scope: selected ? 'selection' : 'sheet', world: { ...world }, scale,
                    reduced: clipboard && scale < 2 - 1e-9 };
            } finally { release(); }
    };
    return { revision, run: signal => runAs(format, signal), runAs, release };
}
