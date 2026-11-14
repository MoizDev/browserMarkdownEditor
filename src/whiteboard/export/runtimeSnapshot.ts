import { pageAt } from '../../platform/render/pageStack';
import { paintWorldScope } from '../../platform/render/compositorProjection';
import type { CaptureRequest, CaptureSnapshot, CapturedLayer } from '../../platform/render/capture';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import type { ViewState } from '../../platform/types';
import { notebookBackdrop } from '../host/notebookBackdrop';
import type { BoardRuntime } from '../host/runtime';
import { createBoardHostImages } from '../media/hostImages';
import type { MediaEntry, MediaId } from '../model/media';
import type { SheetId } from '../model/ids';
import type { SceneSnapshot } from '../scene/types';
import { inkCoverageChunks, PaintStreamJob, type PaintFrame, type PaintItem } from '../render/paintStream';
import { paintItem2d } from '../render/reference/paint2d';
import { prepareRaster, type PreparedRaster } from './prepareRaster';

export interface BoardCaptureSnapshotOptions {
    readonly runtime: BoardRuntime;
    readonly sheetId: SheetId;
    readonly request: CaptureRequest;
    readonly memory: MemoryAllocator;
    /** Must remain usable for this captured entry after its originating view closes. */
    readonly readMedia: (entry: Readonly<MediaEntry>, signal: AbortSignal) => Promise<Blob>;
    readonly signal?: AbortSignal;
    /** The caller owns this pre-await scene pin until the capture has settled. */
    readonly pin?: SceneSnapshot;
    readonly selectedNodeIds?: ReadonlySet<string>;
    readonly onError: (error: unknown) => void;
}
const UNDERLAY = 'board-underlay', CONTENT = 'board-content', PAPER = 'notebook-paper';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function sameRequest(a: CaptureRequest, b: CaptureRequest): boolean {
    const x = a.worldRect, y = b.worldRect, av = a.view, bv = b.view;
    return a.theme === b.theme && a.inverted === b.inverted && a.policy === b.policy && a.predictions === b.predictions
        && a.chrome === b.chrome && a.unsealedInput === b.unsealedInput && a.layers.length === b.layers.length
        && a.layers.every((id, i) => id === b.layers[i]) && x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height
        && av.camera.x === bv.camera.x && av.camera.y === bv.camera.y && av.camera.z === bv.camera.z
        && av.viewport.width === bv.viewport.width && av.viewport.height === bv.viewport.height && av.viewport.dpr === bv.viewport.dpr;
}
function validBytes(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Capture working set exceeds accounting limits');
    return value;
}

/** Pins one Scene revision synchronously. It never uses the pane's current frame or GPU owner. */
export function createBoardCaptureSnapshot(options: BoardCaptureSnapshotOptions): CaptureSnapshot {
    const { runtime, sheetId, memory } = options, scene = runtime.scene, doc = runtime.session.doc, request = options.request;
    options.signal?.throwIfAborted();
    if (options.pin) {
        if (!options.pin.metadataNow().sheets.has(sheetId)) throw new Error('Board capture sheet is unavailable');
    } else if (!scene || !scene.ready || scene.revision !== doc.rev || !doc.sheets.has(sheetId)) throw new Error('Board capture scene is not ready');
    const selected = new Set(request.layers);
    if (selected.size !== request.layers.length || !selected.size || [...selected].some(id => id !== UNDERLAY && id !== CONTENT && id !== PAPER)) {
        throw new Error('Board capture requested an unavailable or presentation-only layer');
    }
    if (selected.has(PAPER) && (options.pin?.metadataNow().host.kind ?? doc.host.kind) !== 'notebook') throw new Error('Notebook paper is unavailable for this board');
    const { worldRect: r, view } = request;
    if (request.theme !== 'light' || request.inverted || request.predictions || request.chrome || request.unsealedInput
        || ![r.x, r.y, r.width, r.height, view.camera.x, view.camera.y, view.camera.z,
            view.viewport.width, view.viewport.height, view.viewport.dpr].every(Number.isFinite)
        || r.width <= 0 || r.height <= 0 || view.camera.z <= 0 || view.viewport.width <= 0 || view.viewport.height <= 0 || view.viewport.dpr <= 0) {
        throw new Error('Invalid board capture plan');
    }
    const frozen: CaptureRequest = { ...request, worldRect: { ...request.worldRect }, layers: [...request.layers],
        view: { ...request.view, camera: { ...request.view.camera }, viewport: { ...request.view.viewport } } };
    const pin = options.pin ?? scene!.pin(), token = Object.freeze({ ...pin.token }), revision = pin.revision;
    if ((!options.pin && revision !== doc.rev) || token.documentId !== runtime.session.owner.documentId || token.session !== runtime.session.owner.session) {
        if (!options.pin) pin.release();
        throw new Error('Board capture pin does not match the session');
    }
    const selectedNodeIds = options.selectedNodeIds && new Set(options.selectedNodeIds);
    const controller = new AbortController(), reservations: ByteLease[] = [];
    let released = false, cleaned = false, ready = false, inFlight: Promise<'exact'> | null = null;
    let images: ReturnType<typeof createBoardHostImages> | null = null, raster: PreparedRaster | null = null;
    let frame: PaintFrame | null = null, paperItems: PaintItem[] = [];
    const abort = () => { controller.abort(options.signal?.reason); release(); };
    const report = (error: unknown) => { try { options.onError(error); } catch { /* Preserve capture failure. */ } };
    const reserve = (bytes: number) => {
        validBytes(bytes); if (!bytes) return;
        const lease = memory.reserve(bytes); if (!lease) throw new Error('Insufficient shared memory for board capture');
        reservations.push(lease);
    };
    const cleanup = () => {
        if (cleaned) return; cleaned = true; ready = false;
        options.signal?.removeEventListener('abort', abort);
        try { raster?.dispose(); } catch (error) { report(error); } raster = null;
        try { images?.dispose(); } catch (error) { report(error); } images = null;
        frame = null; paperItems = [];
        for (const lease of reservations.splice(0)) try { memory.release(lease); } catch (error) { report(error); }
        if (!options.pin) try { pin.release(); } catch (error) { report(error); }
    };
    const release = () => {
        if (released) return; released = true; controller.abort();
        if (inFlight) void inFlight.finally(cleanup).catch(() => {}); else cleanup();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const draw = (band: 'paper' | 'underlay' | 'content') => (ctx: CanvasRenderingContext2D, view: ViewState) => {
        if (released || !ready || !frame || !raster) throw new Error('Board capture is not prepared');
        const items = band === 'paper' ? paperItems : frame[band], resources = raster.resources;
        paintWorldScope(ctx, view, () => { for (const item of items) paintItem2d(ctx, item, resources); });
    };
    const layers: CapturedLayer[] = [];
    if (selected.has(PAPER)) layers.push({ id: PAPER, draw2d: draw('paper') });
    if (selected.has(UNDERLAY)) layers.push({ id: UNDERLAY, draw2d: draw('underlay') });
    if (selected.has(CONTENT)) layers.push({ id: CONTENT, draw2d: draw('content') });
    const build = async (callerSignal: AbortSignal): Promise<'exact'> => {
        const signal = AbortSignal.any([controller.signal, callerSignal]);
        const check = () => { signal.throwIfAborted(); if (released) throw new DOMException('Board capture released', 'AbortError'); };
        let work = 0, started = performance.now();
        const checkpoint = async () => { check(); if (++work >= 256 || performance.now() - started >= 3) { await tick(); check(); work = 0; started = performance.now(); } };
        try {
            check();
            const captured = await pin.readDocument(signal); check();
            if (!captured.sheets.has(sheetId) || captured.rev !== revision) throw new Error('Board capture sheet or revision changed');
            const blobs = new Map<MediaId, Blob>();
            images = createBoardHostImages({ token, media: runtime.media,
                identity: { session: `capture:${crypto.randomUUID()}`, epoch: token.vaultEpoch, revision },
                entry: id => captured.media.get(id), current: candidate => !released && !controller.signal.aborted && sameToken(candidate, token),
                onError: report,
                async readBlob(id, imageSignal) {
                    imageSignal.throwIfAborted();
                    const hit = blobs.get(id); if (hit) return hit;
                    const entry = captured.media.get(id); if (!entry) throw new Error(`Captured media metadata is unavailable: ${id}`);
                    const value = await options.readMedia(structuredClone(entry), imageSignal); imageSignal.throwIfAborted();
                    if (released || !(value instanceof Blob) || value.size !== entry.bytes) throw new Error(`Captured media bytes are unavailable: ${id}`);
                    const copy = value.slice(0, value.size, value.type); blobs.set(id, copy); return copy;
                },
            });
            const underlay: PaintItem[] = [], content: PaintItem[] = [], inkNodeIds = new Set<string>();
            if (selected.has(UNDERLAY) || selected.has(CONTENT)) {
                const source = await pin.paintSource({ sheetId, world: frozen.worldRect, theme: 'light',
                    deviceScale: frozen.view.camera.z * frozen.view.viewport.dpr }, signal); check();
                if (!sameToken(source.token, token) || source.sceneRevision !== revision) throw new Error('Board capture source identity changed');
                let items = 0;
                const stream = new PaintStreamJob(source, (item, band) => {
                    if ((band === 'underlay' && !selected.has(UNDERLAY)) || (band === 'content' && !selected.has(CONTENT)) ||
                        (selectedNodeIds && !selectedNodeIds.has(item.nodeId))) return;
                    if (items++ % 256 === 0) reserve(256 * 128);
                    (band === 'underlay' ? underlay : content).push(item);
                    if (item.kind === 'ink') inkNodeIds.add(item.nodeId);
                });
                try {
                    for (;;) {
                        check(); const status = stream.step(256);
                        if (status === 'complete') break;
                        if (status !== 'pending') throw new Error(`Board capture source became ${status}`);
                        await tick(); check();
                    }
                } catch (error) { stream.cancel(); throw error; }
            }
            if (selected.has(PAPER)) {
                if (captured.host.kind !== 'notebook' || !pin.layout) throw new Error('Captured notebook paper is unavailable');
                const paper = captured.host.paper, boxes = pin.layout.rects, r = frozen.worldRect;
                if (boxes.length !== paper.pageCount || !Number.isFinite(paper.spacing) || paper.spacing <= 0) throw new Error('Invalid captured notebook paper');
                for (let page = Math.max(0, pageAt(pin.layout, r.y)); page < boxes.length; page++) {
                    const box = boxes[page]; if (box.y >= r.y + r.height) break;
                    if (box.x >= r.x + r.width || box.x + box.width <= r.x || box.y + box.height <= r.y) continue;
                    const rows = Math.ceil(box.height / paper.spacing) + 2, columns = Math.ceil(box.width / paper.spacing) + 2;
                    const commands = paper.ruling === 'dotted' ? rows * columns * 6 + 16
                        : paper.ruling === 'grid' ? 2 * (rows + columns) + 16 : paper.ruling === 'lined' ? 2 * rows + 16 : 16;
                    reserve(validBytes(commands * 80));
                    for (const item of notebookBackdrop(paper, page, box)) { paperItems.push(item); await checkpoint(); }
                    await checkpoint();
                }
            }
            frame = { token, sceneRevision: revision, underlay, content, inkNodeIds };
            const allUnderlay: PaintItem[] = [];
            for (const item of paperItems) { allUnderlay.push(item); await checkpoint(); }
            for (const item of underlay) { allUnderlay.push(item); await checkpoint(); }
            const rasterFrame: PaintFrame = { ...frame, underlay: allUnderlay };
            // This is the same conservative provisional profile as boardLayers:
            // native Path2D has no measurable byte size and is not allocated until after admission.
            let estimate = 0;
            const add = (bytes: number) => { estimate = validBytes(estimate + validBytes(bytes)); };
            for (const band of [rasterFrame.underlay, rasterFrame.content]) for (const item of band) {
                for (const clip of item.clips) { add(clip.d.length * 80); await checkpoint(); }
                if (item.kind === 'path') add(item.d.length * 80);
                else if (item.kind === 'ink') for (const coverage of inkCoverageChunks(item.coverage)) {
                    const g = coverage.geometry, primitives = coverage.segments.length / 6 + coverage.discs.length / 3;
                    add(coverage.segments.byteLength + coverage.discs.byteLength + coverage.centreline.byteLength
                        + coverage.radii.byteLength + g.cubics.byteLength + g.flags.byteLength + primitives * 40 * 80);
                    for (const map of coverage.arcMaps) { add(map.cubic.byteLength + map.pieces.byteLength); await checkpoint(); }
                    await checkpoint();
                }
                await checkpoint();
            }
            reserve(estimate); check();
            const prepared = await prepareRaster(rasterFrame, frozen.view.camera.z * frozen.view.viewport.dpr, images, signal);
            if (released || signal.aborted) { prepared.dispose(); signal.throwIfAborted(); throw new DOMException('Board capture released', 'AbortError'); }
            raster = prepared; ready = true; return 'exact';
        } catch (error) {
            if (!signal.aborted) report(error);
            release(); throw error;
        }
    };
    return {
        token, revision: String(revision), signal: controller.signal, layers,
        get isolation() { return ready ? [] : undefined; },
        prepare(next, route, signal) {
            if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Board capture cancelled', 'AbortError'));
            if (released) return Promise.reject(new DOMException('Board capture released', 'AbortError'));
            if (!sameRequest(frozen, next)) return Promise.reject(new Error('Board capture request changed'));
            if (route !== '2d') return Promise.resolve('incomplete');
            if (ready) return Promise.resolve('exact');
            if (!inFlight) { inFlight = build(signal); void inFlight.finally(() => { inFlight = null; if (released) cleanup(); }).catch(() => {}); }
            const pending = inFlight;
            return new Promise((resolve, reject) => {
                const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason ?? new DOMException('Board capture cancelled', 'AbortError')); };
                signal.addEventListener('abort', cancel, { once: true });
                pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
                if (signal.aborted) cancel();
            });
        },
        release,
    };
}
