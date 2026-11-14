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
interface Tile { item: PaintItem; x: number; y: number; texture: TextureHandle }
interface Plan {
    frame: PaintFrame; token: FrameToken; device: GfxDevice; projection: string; scale: number;
    x0: number; y0: number; x1: number; y1: number;
    band: PaintBand; item: number; x: number; y: number; tiles: Record<PaintBand, Tile[]>;
    boundsJob: PaintBoundsJob | null; tileBounds: { x0: number; y0: number; x1: number; y1: number } | null;
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

/** Item-isolated raster tiles preserve ordering and permit exact node omission. */
export function createGpuPaintAdapter(reference: CanvasPaintAdapter, host: LayerHost, report: (error: unknown) => void) {
    let staged: Plan | null = null, ready: Plan | null = null, disposed = false, denied = false;
    let currentToken: FrameToken | null = null, lastFrame = -1, scratch = 0;
    let deniedFrame: PaintFrame | null = null, deniedProjection = '';
    const drop = (plan: Plan | null) => {
        if (!plan) return;
        for (const band of ['underlay', 'content'] as const) for (const tile of plan.tiles[band]) plan.device.destroy(tile.texture);
    };
    const valid = (plan: Plan, view: ViewState) => !!currentToken && sameToken(plan.token, currentToken) &&
        host.device() === plan.device && host.generation === plan.token.deviceGeneration && projection(view) === plan.projection;
    const reset = () => { drop(staged); drop(ready); staged = ready = null; };
    return {
        prepare(view: ViewState, budget: FrameBudget): void {
            if (disposed || lastFrame === budget.frameId) return;
            lastFrame = budget.frameId; currentToken = { ...budget.token };
            const prepared = reference.borrowPrepared(), device = host.device(), scale = view.camera.z * view.viewport.dpr;
            if (!prepared || !device || !documentMatches(prepared.frame, budget.token) || device.generation !== budget.token.deviceGeneration ||
                host.generation !== budget.token.deviceGeneration || !Number.isFinite(scale) || scale <= 0) { reset(); return; }
            if (denied && (deniedFrame !== prepared.frame || deniedProjection !== projection(view))) denied = false;
            if (ready && !valid(ready, view)) { drop(ready); ready = null; denied = false; }
            if (staged && (!valid(staged, view) || staged.frame !== prepared.frame)) { drop(staged); staged = null; denied = false; }
            if (ready?.frame === prepared.frame || denied) return;
            if (!staged) {
                const x0 = Math.floor(view.camera.x * scale / EDGE), y0 = Math.floor(view.camera.y * scale / EDGE);
                const x1 = Math.ceil((view.camera.x * scale + view.viewport.width * view.viewport.dpr) / EDGE);
                const y1 = Math.ceil((view.camera.y * scale + view.viewport.height * view.viewport.dpr) / EDGE);
                if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Invalid board tile projection');
                staged = { frame: prepared.frame, token: { ...budget.token }, device, projection: projection(view), scale,
                    x0, y0, x1, y1, band: 'underlay', item: 0, x: x0, y: y0, tiles: { underlay: [], content: [] }, boundsJob: null, tileBounds: null };
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
                        p.tileBounds = { x0, y0, x1, y1 }; p.x = x0; p.y = y0;
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
                        p.tiles[p.band].push({ item, x: p.x, y: p.y, texture }); texture = null;
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
            if (!ready || !valid(ready, view)) return;
            for (const tile of ready.tiles[band]) {
                if (omitNodes?.has(tile.item.nodeId)) continue;
                const source: Rect = { x: GUTTER, y: GUTTER, width: EDGE, height: EDGE };
                const dest: Rect = { x: tile.x * EDGE - view.camera.x * ready.scale, y: tile.y * EDGE - view.camera.y * ready.scale, width: EDGE, height: EDGE };
                host.drawTexturedQuad(pass, tile.texture, source, dest, { opacity: 1, sampling: 'linear', coverage: 'current' });
            }
        },
        release(_reason: GpuReleaseReason): void { reset(); denied = false; currentToken = null; lastFrame = -1; },
        needsFrame(): boolean { return !disposed && !denied && (!!staged || !ready || ready.frame !== reference.readyFrame()); },
        memory(): { gpuBytes: number; cpuBytes: number } {
            const bytes = (p: Plan | null) => p ? (p.tiles.underlay.length + p.tiles.content.length) * GPU_BYTES : 0;
            return { gpuBytes: bytes(staged) + bytes(ready), cpuBytes: scratch };
        },
        cpuWorkingSet(): { mandatoryBytes: number; prefetchBytes: number } { return { mandatoryBytes: CPU_BYTES, prefetchBytes: 0 }; },
        dispose(): void { if (!disposed) { disposed = true; reset(); } },
    };
}
