import { createTileGrid, exactScale, intersectingTiles, makeTileKey, pageAt, renderTokenKey } from '../../platform/render';
import type { ByteLease, PageStack, Rect, RenderToken, ViewState } from '../../platform/render';
import type { CaptureRequest, CaptureSnapshot } from '../../platform/render/capture';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { PdfTileProducer } from './tileLayer';
import type { PdfTileRequest } from './tileDemand';
import { pdfVariantRevision } from '../fonts/profiles';
import { consumePdfTileArrival } from '../pool/arrivalWindow';

export interface PdfCaptureLease {
    readonly document: { readonly producer: PdfTileProducer };
    readonly signal: AbortSignal;
    release(): void;
}

export interface PdfCaptureSource {
    readonly token: RenderToken;
    readonly source: 'outer' | 'original';
    readonly variant: 'plain' | 'emphasis';
    readonly fontEpoch?: number;
    /** Frozen by the source owner for the lifetime of this capture. */
    readonly pageVariant?: (page: number) => 'plain' | 'emphasis';
    readonly revision: string;
    readonly stack: Readonly<PageStack>;
    /** Called immediately at snapshot creation, before the capture queue can wait. */
    retain(): Promise<PdfCaptureLease>;
}

interface CapturedTile {
    readonly request: PdfTileRequest;
    readonly bitmap: ImageBitmap;
    readonly lease: ByteLease;
}

/** A capture owns a session source lease, never the displayed pane or its GPU resources (C4.5). */
export function createPdfCaptureSnapshot(source: PdfCaptureSource, request: CaptureRequest,
    memory: MemoryAllocator): CaptureSnapshot {
    const token = Object.freeze({ ...source.token });
    const { source: sourceRole, variant, revision } = source;
    const stack: PageStack = { width: source.stack.width, height: source.stack.height,
        rects: source.stack.rects.map(rect => ({ ...rect })) };
    const controller = new AbortController();
    const tiles: CapturedTile[] = [];
    let retained: PdfCaptureLease | null = null;
    let released = false;
    let detach: (() => void) | null = null;
    const pending = source.retain().then(lease => {
        if (released) { lease.release(); throw new DOMException('Capture released', 'AbortError'); }
        retained = lease;
        const abort = () => controller.abort(lease.signal.reason);
        if (lease.signal.aborted) abort();
        else { lease.signal.addEventListener('abort', abort, { once: true }); detach = () => lease.signal.removeEventListener('abort', abort); }
        return lease;
    });
    // A cancelled queued capture can release before its source promise settles.
    void pending.catch(() => {});
    const clear = () => {
        for (const tile of tiles.splice(0)) { tile.bitmap.close(); memory.release(tile.lease); }
    };
    const draw = (ctx: CanvasRenderingContext2D, view: ViewState) => {
        const factor = view.camera.z * view.viewport.dpr;
        for (let i = Math.max(0, pageAt(stack, view.camera.y)); i < stack.rects.length; i++) {
            const page = stack.rects[i];
            if (page.y >= view.camera.y + view.viewport.height / view.camera.z) break;
            ctx.fillStyle = '#fff';
            ctx.fillRect((page.x - view.camera.x) * factor, (page.y - view.camera.y) * factor,
                page.width * factor, page.height * factor);
        }
        for (const { request: tile, bitmap } of tiles) {
            const clip = tile.tile.clip, edges = tile.tile.edges, scale = tile.scale.scale;
            const width = clip.right - clip.left, height = clip.bottom - clip.top;
            ctx.drawImage(bitmap, 1 + (clip.left - edges.left) * scale, 1 + (clip.top - edges.top) * scale,
                width * scale, height * scale, (clip.left - view.camera.x) * factor,
                (clip.top - view.camera.y) * factor, width * factor, height * factor);
        }
    };
    return {
        token, revision, signal: controller.signal,
        layers: request.layers.includes('pdf-page') ? [{ id: 'pdf-page', draw2d: draw }] : [],
        async prepare(capture, route, signal) {
            if (route !== '2d') return 'incomplete';
            const lease = await pending;
            const combined = AbortSignal.any([signal, controller.signal]);
            combined.throwIfAborted();
            clear();
            const region: Readonly<Rect> = capture.worldRect;
            const scale = exactScale(capture.view.camera.z * capture.view.viewport.dpr);
            const documentToken = renderTokenKey(token);
            for (let page = Math.max(0, pageAt(stack, region.y)); page < stack.rects.length; page++) {
                const box = stack.rects[page];
                if (box.y >= region.y + region.height) break;
                if (box.x >= region.x + region.width || box.x + box.width <= region.x ||
                    box.y + box.height <= region.y || box.width <= 0 || box.height <= 0) continue;
                const grid = createTileGrid(box, scale);
                const content = { documentToken, sourceRole, pageOrRegion: String(page),
                    contentRevision: pdfVariantRevision(source.pageVariant?.(page) ?? variant, source.fontEpoch ?? 0),
                    colourVersion: 0, tileSchema: 1 as const };
                for (const tile of intersectingTiles(grid, region)) {
                    combined.throwIfAborted();
                    const reservation = memory.reserve(tile.textureWidth * tile.textureHeight * 4);
                    if (!reservation) return 'incomplete';
                    const tileRequest: PdfTileRequest = { key: makeTileKey(content, grid, tile), page, tile, scale,
                        level: 'exact', priority: 'visible-hole', distance: 0 };
                    let bitmap: ImageBitmap | null = null;
                    try {
                        bitmap = await lease.document.producer.render(tileRequest, combined);
                        consumePdfTileArrival(bitmap);
                        combined.throwIfAborted();
                        if (bitmap.width !== tile.textureWidth || bitmap.height !== tile.textureHeight) {
                            throw new Error('PDF capture tile has unexpected dimensions');
                        }
                        tiles.push({ request: tileRequest, bitmap, lease: reservation });
                        bitmap = null;
                    } catch (error) {
                        bitmap?.close();
                        memory.release(reservation);
                        throw error;
                    }
                }
            }
            return 'exact';
        },
        release() {
            if (released) return;
            released = true;
            controller.abort();
            detach?.(); detach = null;
            clear();
            retained?.release(); retained = null;
        },
    };
}
