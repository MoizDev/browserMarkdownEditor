import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, GpuPass, RectI, TextureHandle } from '../../platform/render/gfx/api';
import type { FrameBudget, FrameToken, GpuReleaseReason, OffscreenPasses } from '../../platform/render/types';
import { auditCount, auditStage, auditTape, renderAuditEnabled, type AuditStage } from '../../platform/render/renderAudit';
import { filterWindows } from './paintWindows';
import type { PaintBand } from './material';
import type { PaintItem, PaintSource } from './paintStream';
import type { CanvasPaintAdapter, PreparedPaint2d } from './reference/canvasPaintAdapter';
import { paintItem2d, type PaintResources2d, type PreparedPath2d } from './reference/paint2d';
import { InkCoverageUnionPath2dJob, Path2dJob, type PathOrigin2d } from './reference/coverage2d';
import { isBudgetRefusal } from './budgetRefusal';
import { TILE_SIZE } from './imageSampling';
import type { Blend, ItemRoute, PreparedRun } from './gpu/contracts';
import { createTileComposer, type GeometryPins, type ResourcedRoute, type TileLay, type TileRoutes } from './gpu/tileComposer';
import { createTileParts } from './gpu/tileParts';
import { createTileStore, tileWorld } from './gpu/tileStore';
import { createPath, withPreparedClips } from './gpu/routePath';
import { createInkRoutes, inkRouteFor } from './gpu/routeInk';
import { createImageRoute } from './gpu/routeImage';
import { createTextRoute, type TextRoute } from './gpu/routeText';

const SIZE = TILE_SIZE;
const NO_INK: ReadonlySet<string> = new Set();
const TILE_BYTES = SIZE * SIZE * 4;
const QUAD = Object.freeze({ opacity: 1, sampling: 'linear', coverage: 'none' } as const);
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

interface EvictingRoute extends ItemRoute { evictTextures?(bytes: number, frameId: number): number }

interface CpuRun extends PreparedRun {
    readonly route: 'cpu';
    readonly texture: TextureHandle;
    readonly device: GfxDevice;
    readonly lease: ByteLease;
    readonly generation: number;
}
type CpuRoute = ItemRoute & ResourcedRoute;

function createCpuRoute(host: LayerHost, surface: string, lay: TileLay): CpuRoute {
    let resources: PaintResources2d | null = null;
    let scratch: OffscreenCanvas | null = null;
    let scratchLease: ByteLease | null = null;
    const live = new Set<CpuRun>();
    const current = (run: CpuRun): boolean => run.device === host.device() && run.generation === host.generation;
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
            if (!scratch) {
                const cpuLease = host.allocator.cpu.reserve(TILE_BYTES);
                if (!cpuLease) return { status: 'denied', pool: 'cpu', bytes: TILE_BYTES };
                scratchLease = cpuLease;
                scratch = new OffscreenCanvas(SIZE, SIZE);
            }
            const lease = host.allocator.gpu.reserve(TILE_BYTES);
            if (!lease) return { status: 'denied', pool: 'gpu', bytes: TILE_BYTES };
            if (!budget.claimUpload(TILE_BYTES)) { host.allocator.gpu.release(lease); return { status: 'deferred' }; }
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
                bitmap = scratch.transferToImageBitmap();
                texture = device.createTexture(SIZE, SIZE, 'rgba8', ['sample', 'copy-dst'], lease);
                device.writeTexture(texture, { x: 0, y: 0, width: SIZE, height: SIZE },
                    { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                auditCount(surface, 'cpu-raster', 1, { px: SIZE * SIZE });
                const run: CpuRun = { route: 'cpu', blend, texture, device, lease, generation: host.generation };
                live.add(run);
                return { status: 'ready', value: run };
            } catch (error) {
                if (texture) device.destroy(texture); else host.allocator.gpu.release(lease);
                if (isBudgetRefusal(error)) return { status: 'denied', pool: 'gpu', bytes: TILE_BYTES };
                auditCount(surface, 'fallback:cpu-failed', 1, { px: SIZE * SIZE });
                host.reportGpuError(error);
                return { status: 'denied', pool: 'gpu', bytes: TILE_BYTES };
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
            if (current(cpu)) cpu.device.destroy(cpu.texture);
        },
        release(): void {
            // Cleared before any destroy: a destroy that throws must not leave a run counted with its lease already returned.
            const runs = [...live];
            live.clear();
            for (const run of runs) if (current(run)) run.device.destroy(run.texture);
            if (scratchLease) host.allocator.cpu.release(scratchLease);
            scratchLease = null;
            scratch = null;
            resources = null;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            let gpuBytes = 0;
            for (const run of live) if (current(run)) gpuBytes += run.lease.bytes;
            return { gpuBytes, cpuBytes: scratchLease?.bytes ?? 0 };
        },
    };
    return route;
}

export interface GpuPaintAdapter {
    prepare(view: ViewState, budget: FrameBudget, omit?: ReadonlySet<string>): boolean;
    contentKey(): number;
    listInvalid(view: ViewState): boolean;
    warm(prepared: PreparedPaint2d, maxMs: number): boolean;
    readyFrame(): PaintSource | null;
    readyPaint(): PreparedPaint2d | null;
    readyInkNodeIds(): ReadonlySet<string> | null;
    encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void;
    offscreenSettled(submitted: boolean): void;
    drawGpu(pass: GpuPass, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void;
    coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean };
    release(reason: GpuReleaseReason): void;
    needsFrame(): boolean;
    memoryBlocked(): boolean;
    holding(): boolean;
    incomplete(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    cpuWorkingSet(): { mandatoryBytes: number; prefetchBytes: number };
    evictGpu(bytes: number, frameId: number): number;
    textureHeld(imageKey: string): boolean;
    protectFrame(frameId: number, view: ViewState): void;
    evictCpu(bytes: number): number;
    gpuMandatoryBytes(viewport: { width: number; height: number }): number;
    drawnInkNodeIds(): ReadonlySet<string>;
    drawnLiveNodeIds(band: PaintBand): ReadonlySet<string>;
    drewNothing(band: PaintBand): boolean;
    plannedLiveNodeIds(band: PaintBand): ReadonlySet<string>;
    dispose(): void;
}

export function createGpuPaintAdapter(reference: CanvasPaintAdapter, host: LayerHost, report: (error: unknown) => void,
    options: {
        readonly streaming?: boolean;
        readonly audit?: string;
        readonly opaqueWorld?: () => readonly Rect[];
        readonly liveOverlay?: boolean;
        readonly liveMatchesTiles?: boolean;
        readonly inputActive?: () => boolean;
        readonly pins?: GeometryPins;
        readonly liveNodes?: ReadonlySet<string>;
    } = {}): GpuPaintAdapter {
    const surface = options.audit ?? 'board';
    if (options.streaming) auditCount(surface, 'option:streaming-ignored');
    let disposed = false;
    let lastFrame = -1;
    let filtered: { source: PreparedPaint2d; out: PreparedPaint2d } | null = null;
    const forComposer = (prepared: PreparedPaint2d): PreparedPaint2d => {
        const include = options.liveNodes;
        if (!include) return prepared;
        if (filtered?.source === prepared) return filtered.out;
        const out: PreparedPaint2d = { ...prepared, windows: filterWindows(prepared.windows, item => include.has(item.nodeId)) };
        filtered = { source: prepared, out };
        return out;
    };
    let pendingPrepared: PreparedPaint2d | null = null;
    let presented: PreparedPaint2d | null = null;
    let ledger: { device: GfxDevice; generation: number } | null = null;
    let omitPrepared: ReadonlySet<string> | null = null;
    let lastView: ViewState | null = null;
    let inkMemo: { frame: number; paint: PreparedPaint2d; set: ReadonlySet<string> } | null = null;
    const lay = createLay(host);
    const cpu = createCpuRoute(host, surface, lay);
    const ink = createInkRoutes(host, surface);
    const pathRoute = createPath(host, surface);
    const wakes: Record<'store' | 'retry', number | null> = { store: null, retry: null };
    const armWake = (slot: 'store' | 'retry', deadline: number | null): void => {
        wakes[slot] = deadline;
        const now = performance.now();
        for (const other of ['store', 'retry'] as const) if (other !== slot && wakes[other] !== null && wakes[other] <= now) wakes[other] = null;
        let first: number | null = null;
        for (const at of [wakes.store, wakes.retry]) if (at !== null && (first === null || at < first)) first = at;
        host.wakeAt(first);
    };
    const withWake = (slot: 'store' | 'retry'): LayerHost => new Proxy(host, {
        get: (target, key) => key === 'wakeAt' ? (deadline: number | null) => armWake(slot, deadline) : Reflect.get(target, key, target),
    });
    const store = createTileStore(withWake('store'), surface);
    const imageRoute = createImageRoute(host, surface);
    const textRoute = createTextRoute(host, surface) as TextRoute;
    const routes: TileRoutes = {
        path: pathRoute.route,
        inkAnalytic: ink.analytic,
        inkUnion: ink.union,
        image: imageRoute,
        text: textRoute,
        cpu,
    };
    const parts = createTileParts(host, surface);
    const evictRoutes = (bytes: number, frameId: number, keepRecent = false): number => {
        pathRoute.beginFrame(frameId); ink.beginFrame(frameId);
        let freed = pathRoute.coverage.evict(bytes);
        if (freed < bytes) freed += pathRoute.evictAreas(bytes - freed, keepRecent);
        if (freed < bytes) freed += ink.evictGpu(bytes - freed, keepRecent);
        if (freed < bytes) freed += imageRoute.evictTextures(bytes - freed, frameId);
        if (freed < bytes) freed += textRoute.evictTextures?.(bytes - freed, frameId) ?? 0;
        if (freed > 0) composer.noteEvicted();
        return freed;
    };
    const composer = createTileComposer({
        host: withWake('retry'), audit: surface, parts, store, routes,
        tileWorld, inkRouteFor, lay, admitClips: pathRoute.admitClips, withPreparedClips,
        layQuads: (pass, texture, quads) => host.drawTexturedQuads(pass, texture, quads, QUAD),
        ...(options.opaqueWorld ? { opaqueWorld: options.opaqueWorld } : {}),
        ...(options.liveOverlay ? { liveOverlay: true } : {}),
        ...(options.liveMatchesTiles ? { liveMatchesTiles: true } : {}),
        ...(options.inputActive ? { inputActive: options.inputActive } : {}),
        ...(options.pins ? { pins: options.pins } : {}),
        slowGpu: () => host.trouble() === 'slow-gpu',
        reclaimRoutes: (bytes, frame) => evictRoutes(bytes, frame, true),
    });

    return {
        warm(prepared: PreparedPaint2d, maxMs: number): boolean {
            return composer.warm(forComposer(prepared), maxMs);
        },
        prepare(view: ViewState, budget: FrameBudget, omit?: ReadonlySet<string>): boolean {
            if (budget.phase === 'background') {
                const pending = pendingPrepared;
                pendingPrepared = null;
                if (disposed || !pending || lastFrame !== budget.frameId) return true;
                try {
                    return timed(surface, 'prepare', () => composer.prepare(view, budget, forComposer(pending), omit));
                } catch (error) {
                    if (isBudgetRefusal(error)) return true;
                    host.reportGpuError(error);
                    return true;
                }
            }
            pendingPrepared = null;
            if (disposed || lastFrame === budget.frameId) return true;
            lastFrame = budget.frameId;
            pathRoute.beginFrame(budget.frameId); ink.beginFrame(budget.frameId);
            const prepared = reference.borrowPrepared(), device = host.device();
            if (!prepared || !device || !documentMatches(prepared.root, budget.token) || !documentMatches(prepared.sourceFrame, budget.token) ||
                device.generation !== budget.token.deviceGeneration || host.generation !== budget.token.deviceGeneration) {
                if (renderAuditEnabled()) {
                    auditCount(surface, !prepared ? 'prepare:hidden:no-paint' : !device ? 'prepare:hidden:no-device' : 'prepare:hidden:document');
                    if (!device) auditCount(surface, `prepare:hidden:no-device:f${budget.frameId}`);
                }
                const bridge = !device && !!prepared && documentMatches(prepared.root, budget.token) && documentMatches(prepared.sourceFrame, budget.token);
                if (!bridge) { composer.release('hidden'); presented = null; ledger = null; }
                omitPrepared = null;
                return true;
            }
            omitPrepared = omit?.size ? omit : null;
            ledger = { device, generation: host.generation };
            armWake('store', null);
            let changed = true;
            try {
                changed = timed(surface, 'prepare', () => composer.prepare(view, budget, forComposer(prepared), omit));
            } catch (error) {
                if (isBudgetRefusal(error)) return true;
                // Reported, not rethrown: a throw here aborted the board's frame on every prepare while the content stayed in view.
                // On a device the error goes to the GPU channel, so the pane demotes to canvas2d instead of failing the open.
                host.reportGpuError(error);
                return true;
            }
            presented = prepared;
            lastView = view;
            if (budget.phase === 'foreground') { pendingPrepared = prepared; return false; }
            return changed;
        },
        readyFrame(): PaintSource | null { return disposed ? null : presented?.sourceFrame ?? null; },
        readyPaint(): PreparedPaint2d | null { return disposed ? null : presented; },
        readyInkNodeIds(): ReadonlySet<string> | null {
            if (disposed || !presented) return null;
            const nodes = presented.root.inkNodeIds;
            if (!nodes.size) return nodes;
            if (!lastView) return new Set();
            if (inkMemo && inkMemo.frame === lastFrame && inkMemo.paint === presented) return inkMemo.set;
            const set = composer.inkComposed(lastView, nodes);
            inkMemo = { frame: lastFrame, paint: presented, set };
            return set;
        },
        offscreenSettled(submitted: boolean): void {
            if (!disposed) composer.offscreenSettled(submitted);
        },
        encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void {
            if (disposed) return;
            timed(surface, 'encodeOffscreen', () => composer.encodeOffscreen(passes, view, band));
        },
        drawGpu(pass: GpuPass, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void {
            if (disposed) return;
            if (omitNodes?.size && !sameOmit(omitNodes, omitPrepared)) auditCount(surface, 'omit:draw-unapplied');
            timed(surface, 'draw', () => composer.drawGpu(pass, view, band));
        },
        coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean } {
            const base = composer.coverage(view);
            return presented && reference.readyFrame() !== presented.sourceFrame ? { ...base, staleVersion: true } : base;
        },
        release(reason: GpuReleaseReason): void {
            if (renderAuditEnabled()) auditTape(`adapter-release:${surface}:${reason}`);
            composer.release(reason);
            if (reason === 'hidden') parts.release();
            presented = null; omitPrepared = null; lastFrame = -1; ledger = null; inkMemo = null; pendingPrepared = null; filtered = null;
        },
        needsFrame(): boolean { return !disposed && composer.needsFrame(); },
        memoryBlocked(): boolean { return !disposed && composer.memoryBlocked(); },
        holding(): boolean { return !disposed && composer.holding(); },
        incomplete(): boolean { return !disposed && composer.incomplete(); },
        drawnInkNodeIds(): ReadonlySet<string> { return disposed ? NO_INK : composer.drawnInkNodeIds(); },
        drawnLiveNodeIds(band: PaintBand): ReadonlySet<string> { return disposed ? NO_INK : composer.drawnLiveNodeIds(band); },
        drewNothing(band: PaintBand): boolean { return disposed || composer.drewNothing(band); },
        plannedLiveNodeIds(band: PaintBand): ReadonlySet<string> { return disposed ? NO_INK : composer.plannedLiveNodeIds(band); },
        contentKey(): number { return disposed ? -1 : composer.contentKey(); },
        listInvalid(view: ViewState): boolean { return !disposed && composer.listInvalid(view); },
        gpuMandatoryBytes(viewport: { width: number; height: number }): number {
            return disposed || !presented ? 0 : composer.mandatoryBytes(viewport.width, viewport.height);
        },
        evictGpu(bytes: number, frameId: number): number {
            if (disposed || !(bytes > 0)) return 0;
            let freed = evictRoutes(bytes, frameId);
            if (freed < bytes && lastView) freed += store.evict(bytes - freed, frameId, lastView, composer.liveEviction());
            if (freed > 0) composer.noteEvicted();
            return freed;
        },
        textureHeld(imageKey: string): boolean { return !disposed && imageRoute.textureHeld(imageKey); },
        protectFrame(frameId: number, view: ViewState): void {
            if (!disposed) store.touchVisible(view, frameId);
        },
        evictCpu(bytes: number): number {
            return disposed || !(bytes > 0) ? 0 : pathRoute.evictCpu(bytes);
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            const device = host.device();
            const held = ledger !== null && (device === null || ledger.device === device) && ledger.generation === host.generation;
            return { gpuBytes: held ? composer.memory().gpuBytes : 0, cpuBytes: cpu.memory().cpuBytes };
        },
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
