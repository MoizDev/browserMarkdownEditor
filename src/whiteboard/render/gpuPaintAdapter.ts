// The board's GPU paint adapter: the surface the layers call, over the tile composer (gpu/tileComposer.ts). The composer
// tiles the paint on the GPU; this file holds what only the device and the reference can supply: the tile laying (a
// modulate slice is a modulate group), the CPU raster that takes the items no GPU route draws, and the route wiring.
// Design: planning/60-implementation/gpu-handoff/PLAN.md §3.3.
import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, GpuPass, RectI, TextureHandle } from '../../platform/render/gfx/api';
import type { FrameBudget, FrameToken, GpuReleaseReason, OffscreenPasses } from '../../platform/render/types';
import { auditCount, auditStage, renderAuditEnabled, type AuditStage } from '../../platform/render/renderAudit';
import type { PaintBand } from './material';
import type { PaintItem, PaintSource } from './paintStream';
import type { CanvasPaintAdapter, PreparedPaint2d } from './reference/canvasPaintAdapter';
import { paintItem2d, type PaintResources2d, type PreparedPath2d } from './reference/paint2d';
import { InkCoverageUnionPath2dJob, Path2dJob, type PathOrigin2d } from './reference/coverage2d';
import { isBudgetRefusal } from './budgetRefusal';
import { TILE_SIZE } from './imageSampling';
import type { Blend, ItemRoute, PreparedRun } from './gpu/contracts';
import { createTileComposer, type ResourcedRoute, type TileLay, type TileRoutes } from './gpu/tileComposer';
import { createTileParts } from './gpu/tileParts';
import { createTileStore, tileId, tileWorld } from './gpu/tileStore';
import { createPath, withPreparedClips } from './gpu/routePath';
import { createInkRoutes, inkRouteFor } from './gpu/routeInk';
import { createImageRoute } from './gpu/routeImage';
import { createTextRoute } from './gpu/routeText';

const SIZE = TILE_SIZE;
const TILE_BYTES = SIZE * SIZE * 4;
/** The quad that lays a composed tile: the whole texture onto its destination, linear, no coverage classification. */
const QUAD = Object.freeze({ opacity: 1, sampling: 'linear', coverage: 'none' } as const);
/** A modulate tile is laid as an isolated group composited by fixed-function modulate (dst·k, h10): no backdrop copy. The
 * composer draws the other multiply slices, the ones not over opaque rects, through its own multiply group (counted). */
const MODULATE_GROUP = Object.freeze({ opacity: 1, blend: 'modulate', colourEffect: 'none' } as const);

type DocumentIdentity = Pick<FrameToken, 'vaultEpoch' | 'documentId' | 'bytesGeneration' | 'session'>;
function documentMatches(source: { readonly token: DocumentIdentity }, token: FrameToken): boolean {
    const t = source.token;
    return t.vaultEpoch === token.vaultEpoch && t.documentId === token.documentId &&
        t.bytesGeneration === token.bytesGeneration && t.session === token.session;
}
function sameOmit(a: ReadonlySet<string> | null | undefined, b: ReadonlySet<string> | null | undefined): boolean {
    const x = a?.size ? a : null, y = b?.size ? b : null;
    if (!x || !y) return x === y;
    if (x.size !== y.size) return false;
    for (const id of y) if (!x.has(id)) return false;
    return true;
}
function timed<T>(surface: string, stage: AuditStage, fn: () => T): T {
    if (!renderAuditEnabled()) return fn();
    const t0 = performance.now();
    try { return fn(); } finally { auditStage(surface, stage, performance.now() - t0); }
}

/** Lays a composed tile on the surface. A modulate tile is wrapped in a modulate group, so it multiplies what is under it. */
function createLay(host: LayerHost): TileLay {
    const bounds: RectI = { x: 0, y: 0, width: 0, height: 0 };
    return (pass: GpuPass, texture: TextureHandle, source: Readonly<Rect>, dest: Readonly<Rect>, blend: Blend): void => {
        if (blend !== 'modulate') { host.drawTexturedQuad(pass, texture, source, dest, QUAD); return; }
        // The group's origin is never negative: a tile that starts left of or above the surface is grouped from 0 (the device
        // refuses a negative origin); its part off the surface is clipped by the surface anyway.
        bounds.x = Math.max(0, Math.floor(dest.x)); bounds.y = Math.max(0, Math.floor(dest.y));
        bounds.width = Math.ceil(dest.x + dest.width) - bounds.x; bounds.height = Math.ceil(dest.y + dest.height) - bounds.y;
        const group = pass.beginGroup(bounds, MODULATE_GROUP);
        host.drawTexturedQuad(pass, texture, source, dest, QUAD);
        pass.endGroup(group);
    };
}

/** A route that keeps a cache the governor can reclaim (the text atlas pages, the image textures); absent when it keeps none. */
interface EvictingRoute extends ItemRoute { evictTextures?(bytes: number, frameId: number): number }

/** A run the CPU route rasters: one tile-sized texture, uploaded once. */
interface CpuRun extends PreparedRun {
    readonly route: 'cpu';
    readonly texture: TextureHandle;
    readonly device: GfxDevice;
}
type CpuRoute = ItemRoute & ResourcedRoute;

/** The route for what no GPU route draws: each run is rastered on the CPU, once, into a tile-sized scrap and drawn as a quad.
 * A modulate run is painted multiply over white, which is exactly the k the modulate cover produces; an over run is painted
 * over transparency. The composer counts every such run as fallback:item-cpu, so this route counts only its raster and upload. */
function createCpuRoute(host: LayerHost, surface: string, lay: TileLay): CpuRoute {
    let resources: PaintResources2d | null = null;
    let scratch: OffscreenCanvas | null = null;
    // The scratch canvas is CPU memory the governor must see: it is leased on the layer's CPU pool, and only that lease is reported.
    let scratchLease: ByteLease | null = null;
    const live = new Set<CpuRun>();
    // Path geometry of a fragment or ink part, built once per item and device scale: the reference holds only its own items' paths.
    const paths = new WeakMap<PaintItem, { scale: number; prepared: PreparedPath2d }>();
    const pathOf = (item: PaintItem, scale: number, paint: PaintResources2d): PreparedPath2d => {
        if (item.kind !== 'path' && item.kind !== 'ink') return paint.path(item);
        const cached = paths.get(item);
        if (cached && cached.scale === scale) return cached.prepared;
        let prepared: PreparedPath2d;
        if (item.kind === 'path') {
            const first = item.d[0];
            const origin: PathOrigin2d = first && first[0] !== 'Z' ? [first[1], first[2]] : [0, 0];
            const job = new Path2dJob(item.d, origin);
            while (job.step(4096) === 'pending') { /* bounded by the path's own commands */ }
            const path = job.result;
            if (!path) throw new Error('CPU raster: path construction was cancelled');
            prepared = { path, origin: job.origin };
        } else {
            const [a, b, c, d] = item.localToWorld;
            const job = new InkCoverageUnionPath2dJob(item.coverage, scale * Math.hypot(a, b, c, d));
            while (job.step(4096) === 'pending') { /* bounded by the coverage's own chunks */ }
            const path = job.result;
            if (!path) throw new Error('CPU raster: ink outline construction was cancelled');
            prepared = { path, origin: job.origin };
        }
        paths.set(item, { scale, prepared });
        return prepared;
    };
    const multiplied = (item: PaintItem): PaintItem => item.kind === 'image'
        ? { ...item, blend: 'multiply' }
        : { ...item, material: { ...item.material, blend: 'multiply' } } as PaintItem;

    const route: CpuRoute = {
        id: 'cpu',
        accepts: (item): item is PaintItem => true,
        useResources(next: PaintResources2d): void { resources = next; },
        admit(items, view, blend, budget) {
            const paint = resources;
            const device = host.device();
            if (!paint || !device) return { status: 'unsupported', why: 'no-paint-or-device' };
            if (!budget.claimUpload(TILE_BYTES)) return { status: 'deferred' };
            if (!scratch) {
                const cpuLease = host.allocator.cpu.reserve(TILE_BYTES);
                if (!cpuLease) return { status: 'denied', pool: 'cpu', bytes: TILE_BYTES };
                scratchLease = cpuLease;
                scratch = new OffscreenCanvas(SIZE, SIZE);
            }
            const lease = host.allocator.gpu.reserve(TILE_BYTES);
            if (!lease) return { status: 'denied', pool: 'gpu', bytes: TILE_BYTES };
            let texture: TextureHandle | null = null;
            let bitmap: ImageBitmap | null = null;
            try {
                const ctx = scratch.getContext('2d');
                if (!ctx) throw new Error('Offscreen 2D canvas unavailable');
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalCompositeOperation = 'source-over';
                ctx.clearRect(0, 0, SIZE, SIZE);
                if (blend === 'modulate') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE); }
                const s = view.camera.z;
                ctx.setTransform(s, 0, 0, s, -view.camera.x * s, -view.camera.y * s);
                const withPaths: PaintResources2d = { ...paint, path: item => pathOf(item, s, paint) };
                for (const item of items) paintItem2d(ctx, blend === 'modulate' ? multiplied(item) : item, withPaths);
                auditCount(surface, 'cpu-raster', 1, { px: SIZE * SIZE });
                bitmap = scratch.transferToImageBitmap();
                texture = device.createTexture(SIZE, SIZE, 'rgba8', ['sample', 'copy-dst'], lease);
                auditCount(surface, 'upload:image', 1, { bytes: TILE_BYTES });
                device.writeTexture(texture, { x: 0, y: 0, width: SIZE, height: SIZE },
                    { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                const run: CpuRun = { route: 'cpu', blend, texture, device };
                live.add(run);
                return { status: 'ready', value: run };
            } catch (error) {
                // A texture owns its lease: destroying it returns the bytes; without one, the lease goes back itself.
                if (texture) device.destroy(texture); else host.allocator.gpu.release(lease);
                if (isBudgetRefusal(error)) return { status: 'denied', pool: 'gpu', bytes: TILE_BYTES };
                throw error;
            } finally {
                bitmap?.close();
            }
        },
        draw(pass: GpuPass, run: PreparedRun): void {
            if (run.route !== 'cpu') throw new Error('CPU route drew a run of another route');
            const cpu = run as CpuRun;
            const whole: Rect = { x: 0, y: 0, width: SIZE, height: SIZE };
            lay(pass, cpu.texture, whole, whole, cpu.blend);
        },
        retire(run: PreparedRun): void {
            if (run.route !== 'cpu') throw new Error('CPU route retired a run of another route');
            const cpu = run as CpuRun;
            if (!live.delete(cpu)) return;
            cpu.device.destroy(cpu.texture);
        },
        release(): void {
            for (const run of live) run.device.destroy(run.texture);
            live.clear();
            if (scratchLease) host.allocator.cpu.release(scratchLease);
            scratchLease = null;
            scratch = null;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            return { gpuBytes: live.size * TILE_BYTES, cpuBytes: scratchLease?.bytes ?? 0 };
        },
    };
    return route;
}

export interface GpuPaintAdapter {
    /** Indexes the reference's paint, composes what the view needs within the frame's limit. `omit` is the drag's omitted nodes. */
    prepare(view: ViewState, budget: FrameBudget, omit?: ReadonlySet<string>): void;
    /** The paint the composed tiles were built from, once a paint has been prepared. */
    readyFrame(): PaintSource | null;
    readyPaint(): PreparedPaint2d | null;
    readyInkNodeIds(): ReadonlySet<string> | null;
    /** Encodes the composed tiles of one band onto the frame's offscreen targets. */
    encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void;
    /** Lays one band's tiles. `omitNodes` is accepted for the callers that still pass it; the omission is applied in prepare. */
    drawGpu(pass: GpuPass, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void;
    coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean };
    release(reason: GpuReleaseReason): void;
    needsFrame(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    cpuWorkingSet(): { mandatoryBytes: number; prefetchBytes: number };
    /** The governor's GPU pressure: frees up to `bytes` of idle GPU memory, path coverage sets first, then composed tiles
     * not used this frame. Returns the bytes freed. */
    evictGpu(bytes: number, frameId: number): number;
    dispose(): void;
}

export function createGpuPaintAdapter(reference: CanvasPaintAdapter, host: LayerHost, report: (error: unknown) => void,
    options: {
        /** Accepted for the live-stroke layer's call site, which h6 removes. The composer redraws a stroke's dirty rects
         * through the same path as any content, so this flag no longer changes what is drawn; it is counted. */
        readonly streaming?: boolean;
        readonly audit?: string;
        /** Rects whose surface is opaque: a multiply slice inside one composes by modulate, elsewhere by isolation. */
        readonly opaqueWorld?: () => readonly Rect[];
    } = {}): GpuPaintAdapter {
    const surface = options.audit ?? 'board';
    if (options.streaming) auditCount(surface, 'option:streaming-ignored');
    let disposed = false;
    let lastFrame = -1;
    let presented: PreparedPaint2d | null = null;
    let omitPrepared: ReadonlySet<string> | null = null;
    // The view the composed tiles were last prepared for: the store keeps the tiles on it, so its eviction spares them.
    let lastView: ViewState | null = null;
    let inkMemo: { frame: number; paint: PreparedPaint2d; set: ReadonlySet<string> } | null = null;
    const lay = createLay(host);
    const cpu = createCpuRoute(host, surface, lay);
    const ink = createInkRoutes(host, surface);
    // One path route and its clip admission share one coverage kit: the composer admits every route's clips through it.
    const pathRoute = createPath(host, surface);
    const store = createTileStore(host, surface);
    const imageRoute = createImageRoute(host, surface);
    const textRoute: EvictingRoute = createTextRoute(host, surface);
    const routes: TileRoutes = {
        path: pathRoute.route,
        inkAnalytic: ink.analytic,
        inkUnion: ink.union,
        image: imageRoute,
        text: textRoute,
        cpu,
    };
    const composer = createTileComposer({
        host, audit: surface, parts: createTileParts(host, surface), store, routes,
        tileId, tileWorld, inkRouteFor, lay, admitClips: pathRoute.admitClips, withPreparedClips,
        ...(options.opaqueWorld ? { opaqueWorld: options.opaqueWorld } : {}),
        // The compose limit halves while the host reports a slow GPU, read each frame (PLAN 3.1).
        slowGpu: () => host.trouble() === 'slow-gpu',
    });

    return {
        prepare(view: ViewState, budget: FrameBudget, omit?: ReadonlySet<string>): void {
            if (disposed || lastFrame === budget.frameId) return;
            lastFrame = budget.frameId;
            pathRoute.coverage.beginFrame(budget.frameId);
            const prepared = reference.borrowPrepared(), device = host.device();
            if (!prepared || !device || !documentMatches(prepared.root, budget.token) || !documentMatches(prepared.sourceFrame, budget.token) ||
                device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) {
                composer.release('hidden');
                presented = null; omitPrepared = null;
                return;
            }
            omitPrepared = omit?.size ? omit : null;
            try {
                timed(surface, 'prepare', () => composer.prepare(view, budget, prepared, omit));
            } catch (error) {
                if (isBudgetRefusal(error)) return;
                report(error);
                throw error;
            }
            presented = prepared;
            lastView = view;
        },
        readyFrame(): PaintSource | null { return disposed ? null : presented?.sourceFrame ?? null; },
        readyPaint(): PreparedPaint2d | null { return disposed ? null : presented; },
        readyInkNodeIds(): ReadonlySet<string> | null {
            if (disposed || !presented) return null;
            const nodes = presented.root.inkNodeIds;
            if (!nodes.size) return nodes;
            if (!lastView) return new Set();
            // Memoized per prepare: the composer only changes in prepare, and the board asks several times a frame.
            if (inkMemo && inkMemo.frame === lastFrame && inkMemo.paint === presented) return inkMemo.set;
            const set = composer.inkComposed(lastView, nodes);
            inkMemo = { frame: lastFrame, paint: presented, set };
            return set;
        },
        encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void {
            if (disposed) return;
            timed(surface, 'encodeOffscreen', () => composer.encodeOffscreen(passes, view, band));
        },
        drawGpu(pass: GpuPass, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void {
            if (disposed) return;
            // A drag's omission that reaches the draw but not the prepare is drawn in the tiles: counted, so it cannot pass silently.
            if (omitNodes?.size && !sameOmit(omitNodes, omitPrepared)) auditCount(surface, 'omit:draw-unapplied');
            timed(surface, 'draw', () => composer.drawGpu(pass, view, band));
        },
        coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean } {
            const base = composer.coverage(view);
            return presented && reference.readyFrame() !== presented.sourceFrame ? { ...base, staleVersion: true } : base;
        },
        release(reason: GpuReleaseReason): void {
            composer.release(reason);
            presented = null; omitPrepared = null; lastFrame = -1;
        },
        needsFrame(): boolean { return !disposed && composer.needsFrame(); },
        evictGpu(bytes: number, frameId: number): number {
            if (disposed || !(bytes > 0)) return 0;
            // Route caches first, then composed tiles: each frees only what this frame did not use. The sum is what was freed.
            pathRoute.coverage.beginFrame(frameId);
            let freed = pathRoute.coverage.evict(bytes);
            if (freed < bytes) freed += imageRoute.evictTextures(bytes - freed, frameId);
            if (freed < bytes) freed += textRoute.evictTextures?.(bytes - freed, frameId) ?? 0;
            if (freed < bytes && lastView) freed += store.evict(bytes - freed, frameId, lastView);
            return freed;
        },
        // GPU bytes are the composer's: each is leased by its owner (the store, a route) on the layer's GPU pool, reported once.
        // CPU bytes are this route's own leased scratch only: a route's CPU bytes that are not leased (the text scratch, the path
        // geometry cache) are not reported, since the governor would refuse to admit bytes it has not reserved.
        memory(): { gpuBytes: number; cpuBytes: number } { return { gpuBytes: composer.memory().gpuBytes, cpuBytes: cpu.memory().cpuBytes }; },
        cpuWorkingSet(): { mandatoryBytes: number; prefetchBytes: number } {
            return { mandatoryBytes: composer.memory().cpuBytes, prefetchBytes: 0 };
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            composer.dispose();
            presented = null; omitPrepared = null;
        },
    };
}
