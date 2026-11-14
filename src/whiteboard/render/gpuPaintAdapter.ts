import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { GfxDevice, GpuPass, TextureHandle } from '../../platform/render/gfx/api';
import type { FrameBudget, FrameToken, GpuReleaseReason } from '../../platform/render/types';
import type { PaintBand } from './material';
import { PaintBoundsJob } from './paintBounds';
import type { PaintFrame, PaintItem } from './paintStream';
import type { CanvasPaintAdapter } from './reference/canvasPaintAdapter';
import { paintItem2d } from './reference/paint2d';

const EDGE = 512, GUTTER = 2, SIZE = EDGE + GUTTER * 2;
const GPU_BYTES = SIZE * SIZE * 4, CPU_BYTES = GPU_BYTES * 2;
interface CachedTile { texture: TextureHandle; device: GfxDevice; refs: number; key: string }
interface Tile { item: PaintItem; x: number; y: number; cached: CachedTile }
interface Plan {
    frame: PaintFrame; token: FrameToken; device: GfxDevice; projection: string; scale: number;
    x0: number; y0: number; x1: number; y1: number;
    band: PaintBand; item: number; x: number; y: number; tiles: Record<PaintBand, Tile[]>;
    boundsJob: PaintBoundsJob | null; tileBounds: { x0: number; y0: number; x1: number; y1: number } | null; itemKey: string;
}
function sameToken(a: FrameToken, b: FrameToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId && a.bytesGeneration === b.bytesGeneration &&
        a.session === b.session && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}
function projection(view: ViewState): string {
    const { camera: c, viewport: v } = view;
    return [c.x, c.y, c.z, v.width, v.height, v.dpr].join(':');
}
function documentMatches(frame: PaintFrame, token: FrameToken): boolean {
    const t = frame.token;
    return t.vaultEpoch === token.vaultEpoch && t.documentId === token.documentId &&
        t.bytesGeneration === token.bytesGeneration && t.session === token.session;
}

function contentKey(item: PaintItem): string {
    const common = [item.kind, item.key, item.geometryKey, item.localToWorld,
        item.clips.map(clip => [clip.key, clip.fillRule, clip.localToWorld, clip.d])];
    if (item.kind === 'image') return JSON.stringify([common, item.imageKey, item.rect, item.sourceRect, item.opacity, item.blend, item.inverted]);
    if (item.kind === 'text') return JSON.stringify([common, item.material, item.paint, item.faces]);
    if (item.kind === 'path') return JSON.stringify([common, item.material, item.fillRule]);
    return JSON.stringify([common, item.material]);
}

/** Item-isolated raster tiles preserve ordering and permit exact node omission. */
export function createGpuPaintAdapter(reference: CanvasPaintAdapter, host: LayerHost, report: (error: unknown) => void) {
    let staged: Plan | null = null, ready: Plan | null = null, disposed = false, denied = false;
    let currentToken: FrameToken | null = null, lastFrame = -1, scratch = 0;
    let deniedFrame: PaintFrame | null = null, deniedProjection = '', movingScale = 0;
    const cache = new Map<string, CachedTile>();
    const drop = (plan: Plan | null) => {
        if (!plan) return;
        for (const band of ['underlay', 'content'] as const) for (const tile of plan.tiles[band]) {
            const entry = tile.cached;
            if (--entry.refs === 0) { cache.delete(entry.key); entry.device.destroy(entry.texture); }
        }
    };
    const validDevice = (plan: Plan) => !!currentToken && sameToken(plan.token, currentToken) &&
        host.device() === plan.device && host.generation === plan.token.deviceGeneration;
    const valid = (plan: Plan, view: ViewState, scale: number) => validDevice(plan) && projection(view) === plan.projection && plan.scale === scale;
    const rasterScale = (view: ViewState, demand: number): number => {
        if (!view.moving) { movingScale = 0; return demand; }
        if (movingScale >= demand && movingScale <= demand * 1.2 * Math.SQRT2) return movingScale;
        movingScale = Math.pow(Math.SQRT2, Math.ceil(Math.log(demand) / Math.log(Math.SQRT2)));
        return movingScale;
    };
    const reset = () => { drop(staged); drop(ready); staged = ready = null; };
    return {
        prepare(view: ViewState, budget: FrameBudget): void {
            if (disposed || lastFrame === budget.frameId) return;
            lastFrame = budget.frameId; currentToken = { ...budget.token };
            const prepared = reference.borrowPrepared(), device = host.device(), demand = view.camera.z * view.viewport.dpr;
            if (!prepared || !device || !documentMatches(prepared.frame, budget.token) || device.generation !== budget.token.deviceGeneration ||
                host.generation !== budget.token.deviceGeneration || !Number.isFinite(demand) || demand <= 0) { reset(); return; }
            const scale = rasterScale(view, demand);
            if (denied && (deniedFrame !== prepared.frame || deniedProjection !== projection(view))) denied = false;
            if (ready && !validDevice(ready)) { drop(ready); ready = null; denied = false; }
            if (staged && (!valid(staged, view, scale) || staged.frame !== prepared.frame)) { drop(staged); staged = null; denied = false; }
            if ((ready?.frame === prepared.frame && valid(ready, view, scale)) || denied) return;
            if (!staged) {
                const x0 = Math.floor(view.camera.x * scale / EDGE), y0 = Math.floor(view.camera.y * scale / EDGE);
                const x1 = Math.ceil((view.camera.x + view.viewport.width / view.camera.z) * scale / EDGE);
                const y1 = Math.ceil((view.camera.y + view.viewport.height / view.camera.z) * scale / EDGE);
                if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Invalid board tile projection');
                staged = { frame: prepared.frame, token: { ...budget.token }, device, projection: projection(view), scale,
                    x0, y0, x1, y1, band: 'underlay', item: 0, x: x0, y: y0, tiles: { underlay: [], content: [] }, boundsJob: null, tileBounds: null, itemKey: '' };
            }
            const p = staged;
            try {
                while (!budget.shouldYield()) {
                    const items = p.frame[p.band];
                    if (p.item >= items.length) {
                        if (p.band === 'underlay') { p.band = 'content'; p.item = 0; continue; }
                        drop(ready); ready = p; staged = null; return;
                    }
                    const item = items[p.item];
                    if ((item.kind === 'image' ? item.blend : item.material.blend) !== 'normal') {
                        throw new Error('Unsupported GPU board paint: multiply blend');
                    }
                    if (!p.tileBounds) {
                        p.boundsJob ??= new PaintBoundsJob(item);
                        if (!p.boundsJob.step(1)) continue;
                        const bounds = p.boundsJob.result; p.boundsJob = null;
                        if (!bounds) { p.item++; continue; }
                        const x0 = Math.max(p.x0, Math.floor((bounds.x * scale - GUTTER) / EDGE));
                        const y0 = Math.max(p.y0, Math.floor((bounds.y * scale - GUTTER) / EDGE));
                        const x1 = Math.min(p.x1, Math.ceil(((bounds.x + bounds.width) * scale + GUTTER) / EDGE));
                        const y1 = Math.min(p.y1, Math.ceil(((bounds.y + bounds.height) * scale + GUTTER) / EDGE));
                        if (x0 >= x1 || y0 >= y1) { p.item++; continue; }
                        p.tileBounds = { x0, y0, x1, y1 }; p.x = x0; p.y = y0; p.itemKey = contentKey(item);
                    }
                    const tileKey = JSON.stringify([p.token.vaultEpoch, p.token.documentId, p.token.bytesGeneration, p.token.session,
                        p.token.viewLease, p.token.deviceGeneration, p.scale, p.x, p.y, p.itemKey]);
                    const existing = cache.get(tileKey);
                    if (existing) {
                        existing.refs++; p.tiles[p.band].push({ item, x: p.x, y: p.y, cached: existing });
                        const bounds = p.tileBounds;
                        if (++p.x >= bounds.x1) { p.x = bounds.x0; if (++p.y >= bounds.y1) { p.item++; p.tileBounds = null; } }
                        return;
                    }
                    const cpu = host.allocator.cpu.reserve(CPU_BYTES);
                    if (!cpu) { denied = true; deniedFrame = p.frame; deniedProjection = p.projection; return; }
                    scratch = cpu.bytes;
                    const gpu = host.allocator.gpu.reserve(GPU_BYTES);
                    if (!gpu) { host.allocator.cpu.release(cpu); scratch = 0; denied = true; deniedFrame = p.frame; deniedProjection = p.projection; return; }
                    if (!budget.claimUpload(GPU_BYTES)) { host.allocator.gpu.release(gpu); host.allocator.cpu.release(cpu); scratch = 0; return; }
                    let canvas: OffscreenCanvas | null = null, bitmap: ImageBitmap | null = null, texture: TextureHandle | null = null;
                    let attached = false;
                    try {
                        canvas = new OffscreenCanvas(SIZE, SIZE);
                        const ctx = canvas.getContext('2d');
                        if (!ctx) throw new Error('Offscreen 2D canvas unavailable');
                        ctx.setTransform(scale, 0, 0, scale, GUTTER - p.x * EDGE, GUTTER - p.y * EDGE);
                        paintItem2d(ctx, item, prepared.resources);
                        bitmap = canvas.transferToImageBitmap();
                        texture = device.createTexture(SIZE, SIZE, 'rgba8', ['sample', 'copy-dst'], gpu); attached = true;
                        device.writeTexture(texture, { x: 0, y: 0, width: SIZE, height: SIZE },
                            { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                        const cached: CachedTile = { texture, device, refs: 1, key: tileKey };
                        cache.set(tileKey, cached); p.tiles[p.band].push({ item, x: p.x, y: p.y, cached }); texture = null;
                    } finally {
                        bitmap?.close(); if (canvas) { canvas.width = 0; canvas.height = 0; }
                        if (texture) device.destroy(texture);
                        if (!attached) host.allocator.gpu.release(gpu);
                        host.allocator.cpu.release(cpu); scratch = 0;
                    }
                    const bounds = p.tileBounds;
                    if (++p.x >= bounds.x1) { p.x = bounds.x0; if (++p.y >= bounds.y1) { p.item++; p.tileBounds = null; } }
                    return;
                }
            } catch (error) { drop(staged); drop(ready); staged = ready = null; denied = true; deniedFrame = p.frame; deniedProjection = p.projection; report(error); throw error; }
        },
        readyFrame(): PaintFrame | null { return disposed ? null : ready?.frame ?? null; },
        drawGpu(pass: GpuPass, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void {
            if (!ready || !validDevice(ready)) return;
            const factor = view.camera.z * view.viewport.dpr / ready.scale;
            for (const tile of ready.tiles[band]) {
                if (omitNodes?.has(tile.item.nodeId)) continue;
                const source: Rect = { x: GUTTER, y: GUTTER, width: EDGE, height: EDGE };
                const dest: Rect = { x: (tile.x * EDGE - view.camera.x * ready.scale) * factor, y: (tile.y * EDGE - view.camera.y * ready.scale) * factor, width: EDGE * factor, height: EDGE * factor };
                host.drawTexturedQuad(pass, tile.cached.texture, source, dest, { opacity: 1, sampling: 'linear', coverage: ready.projection === projection(view) ? 'current' : 'standin' });
            }
        },
        release(_reason: GpuReleaseReason): void { reset(); denied = false; currentToken = null; lastFrame = -1; },
        needsFrame(): boolean { return !disposed && !denied && (!!staged || !ready || ready.frame !== reference.readyFrame()); },
        memory(): { gpuBytes: number; cpuBytes: number } {
            return { gpuBytes: cache.size * GPU_BYTES, cpuBytes: scratch };
        },
        cpuWorkingSet(): { mandatoryBytes: number; prefetchBytes: number } { return { mandatoryBytes: CPU_BYTES, prefetchBytes: 0 }; },
        dispose(): void { if (!disposed) { disposed = true; reset(); } },
    };
}
