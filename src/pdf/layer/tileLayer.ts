import { pageAt, pagePresentation, tileKeyString } from '../../platform/render';
import type { ByteLease, FrameBudget, GfxDevice, GpuPass, GpuReleaseReason, Layer, LayerHost, MirrorView, Rect, TextureHandle, ViewState } from '../../platform/render';
import type { PdfMirrorPixels, PdfSessionMirrors } from './tileMirror';
import type { PdfVersionBridge } from './versionBridge';
import type { BorrowedMirror } from '../../platform/render';
import { covers, intersects } from './coverage';
import { PdfTileCache } from './tileCache';
import { PdfTexturePool, type PooledTexture } from './texturePool';
import { planPdfTileDemand } from './tileDemand';
import type { PdfDemandInput, PdfTileRequest } from './tileDemand';

/** The pool returns the requested cell plus its one-pixel apron. Ownership of
 * every returned bitmap transfers to this layer, including cancelled replies. */
export interface PdfTileProducer {
    render(request: PdfTileRequest, signal: AbortSignal): Promise<ImageBitmap>;
}

export interface PdfLayerMirror {
    readonly store: PdfSessionMirrors;
    view(view: ViewState): MirrorView | null;
}

interface MirrorJob {
    readonly key: string;
    readonly view: MirrorView;
    readonly entries: readonly Entry[];
    readonly ids: string[];
    readonly lowIds: Set<string>;
    index: number;
    pending: boolean;
}

interface Entry {
    readonly request: PdfTileRequest;
    readonly lease: ByteLease;
    readonly controller: AbortController;
    bitmap?: ImageBitmap;
    texture?: PooledTexture;
    used: number;
}

function contentFamily(input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>): string {
    const { vaultEpoch, documentId, session } = input.token;
    return JSON.stringify([vaultEpoch, documentId, session, input.source, input.variant, input.geometryDigest]);
}

function rect(request: PdfTileRequest): Rect {
    const c = request.tile.clip;
    return { x: c.left, y: c.top, width: c.right - c.left, height: c.bottom - c.top };
}

function project(box: Readonly<Rect>, page: Readonly<Rect>, view: ViewState): Rect {
    const scale = view.camera.z * view.viewport.dpr;
    const offset = pagePresentation(page, view).restOffsetDevice;
    return { x: (box.x - view.camera.x) * scale + offset.x, y: (box.y - view.camera.y) * scale + offset.y,
        width: box.width * scale, height: box.height * scale };
}

/**
 * A page layer has no frame loop and never opens a worker. The pane gives it a
 * session-bound producer; scheduler budgets, allocator leases and device lifetime
 * come from the shared host. Waiting for a worker alone is not frame work.
 */
export class PdfTileLayer implements Layer {
    private readonly entries = new PdfTileCache<Entry>();
    private readonly failed = new Set<string>();
    private readonly retiring = new Set<Entry>();
    private readonly texturePool: PdfTexturePool;
    private readonly bridgeTextures = new Map<string, PooledTexture>();
    private bridgeReady = new Set<string>();
    private desired = new Set<string>();
    private sequence = 0;
    private contentRevision = 0;
    private pendingFrame = false;
    private frameTexture: { device: GfxDevice; handle: TextureHandle } | null = null;
    private disposed = false;
    private contentIdentity = '';
    private lastMotionScale: PdfDemandInput['previousMotionScale'];
    private motionScaleAt = 0;
    private latestDemand: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'> | null = null;
    private latestView: ViewState | null = null;
    private mirrorJob: MirrorJob | null = null;
    private mirrorKey = '';

    constructor(private readonly host: LayerHost, private readonly producer: PdfTileProducer,
        private readonly demand: (view: ViewState) => Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>,
        private readonly isCurrent: () => boolean,
        private readonly onError: (error: unknown, request: PdfTileRequest) => void,
        private readonly mirror?: PdfLayerMirror, private readonly bridge?: PdfVersionBridge | null) {
        this.texturePool = new PdfTexturePool(host.allocator.gpu);
    }

    prepare(view: ViewState, budget: FrameBudget): void {
        this.pendingFrame = false;
        if (this.disposed || !this.isCurrent()) return;
        const device = this.host.device();
        if (device && this.frameTexture?.device !== device) {
            if (this.frameTexture) { this.frameTexture.device.destroy(this.frameTexture.handle); this.frameTexture = null; }
            if (budget.shouldYield() || !budget.claimUpload(8)) { this.pendingFrame = true; return; }
            const lease = this.host.allocator.gpu.reserve(8);
            if (lease) {
                let handle: TextureHandle;
                try { handle = device.createTexture(2, 1, 'rgba8', ['sample', 'copy-dst'], lease); }
                catch (error) { this.host.allocator.gpu.release(lease); throw error; }
                try {
                    device.writeTexture(handle, { x: 0, y: 0, width: 2, height: 1 },
                        { source: new Uint8Array([190, 190, 190, 255, 255, 255, 255, 255]), rowBytes: 8,
                            premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                    this.frameTexture = { device, handle };
                } catch (error) { device.destroy(handle); throw error; }
            }
        }
        const input = this.demand(view);
        this.latestDemand = input;
        this.latestView = view;
        const identity = contentFamily(input);
        if (identity !== this.contentIdentity) {
            for (const [key, entry] of this.entries) this.remove(key, entry);
            this.failed.clear();
            this.contentIdentity = identity;
            this.lastMotionScale = undefined;
            this.motionScaleAt = 0;
        }
        this.prepareBridge(view, budget, device);
        const now = performance.now();
        const holdMotionScale = input.moving && this.lastMotionScale && now - this.motionScaleAt < 50;
        const planned = planPdfTileDemand({ ...input, previousMotionScale: this.lastMotionScale,
            motionScaleOverride: holdMotionScale ? this.lastMotionScale : undefined,
            covered: (page, area) => this.covered(page, area, device) });
        if (input.moving && !holdMotionScale) this.motionScaleAt = now;
        this.lastMotionScale = planned.motionScale;
        this.desired = new Set(planned.requests.map(request => tileKeyString(request.key)));
        for (const [key, entry] of this.entries) {
            // A running off-window render is cancelled; settled older scales
            // remain available as stand-ins until the allocator needs space.
            if (!entry.bitmap && !this.desired.has(key)) this.remove(key, entry);
        }
        let running = [...this.entries.values()].filter(entry => !entry.bitmap).length;
        for (const request of planned.requests) {
            const key = tileKeyString(request.key);
            const existing = this.entries.get(key);
            if (existing) {
                existing.used = ++this.sequence;
                if (device && existing.bitmap && existing.texture?.device !== device) {
                    if (budget.shouldYield()) { this.pendingFrame = true; break; }
                    const bytes = existing.bitmap.width * existing.bitmap.height * 4;
                    if (!budget.claimUpload(bytes)) { this.pendingFrame = true; break; }
                    let texture: PooledTexture | null;
                    try { texture = this.texturePool.acquire(device, existing.bitmap.width, existing.bitmap.height); }
                    catch (error) { this.onError(error, request); continue; }
                    if (!texture) continue;
                    try {
                        device.writeTexture(texture.handle, { x: 0, y: 0, width: existing.bitmap.width, height: existing.bitmap.height },
                            { source: existing.bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                        if (existing.texture) this.texturePool.release(existing.texture);
                        existing.texture = texture;
                    } catch (error) { device.destroy(texture.handle); this.onError(error, request); }
                }
                continue;
            }
            if (this.failed.has(key) || running >= 3) continue;
            if (budget.shouldYield()) { this.pendingFrame = true; break; }
            const bytes = request.tile.textureWidth * request.tile.textureHeight * 4;
            let lease = this.host.allocator.cpu.reserve(bytes);
            if (!lease) {
                this.evictUnneeded(input.viewport, bytes);
                lease = this.host.allocator.cpu.reserve(bytes);
            }
            if (!lease) continue;
            const entry: Entry = { request, lease, controller: new AbortController(), used: ++this.sequence };
            this.entries.set(key, entry); running++;
            void Promise.resolve().then(() => this.producer.render(request, entry.controller.signal)).then(bitmap => {
                const current = !this.disposed && this.isCurrent() && this.entries.get(key) === entry && !entry.controller.signal.aborted;
                if (!current || bitmap.width !== request.tile.textureWidth || bitmap.height !== request.tile.textureHeight) {
                    bitmap.close();
                    if (this.entries.get(key) === entry) this.remove(key, entry);
                    this.finishRetiring(entry);
                    if (current) { this.failed.add(key); this.onError(new Error('PDF tile has unexpected dimensions'), request); this.host.invalidate('pdf-tile-invalid'); }
                    return;
                }
                entry.bitmap = bitmap;
                this.contentRevision++;
                this.host.invalidate('pdf-tile-arrived');
            }, error => {
                const current = this.entries.get(key) === entry;
                const cancelled = entry.controller.signal.aborted;
                if (current) this.remove(key, entry);
                this.finishRetiring(entry);
                if (!current) return;
                if (!cancelled && this.isCurrent()) { this.failed.add(key); this.onError(error, request); }
                this.host.invalidate('pdf-tile-finished');
            });
        }
        this.prepareMirror(view, input, planned.requests, budget);
    }

    coverage(view: ViewState, gpu: boolean): { complete: boolean; sharp: boolean } {
        if (this.disposed || !this.isCurrent()) return { complete: false, sharp: false };
        const input = this.demand(view);
        if (contentFamily(input) !== this.contentIdentity) {
            return { complete: false, sharp: false };
        }
        const device = gpu ? this.host.device() : null;
        if (gpu && !device) return { complete: false, sharp: false };
        const bridge = this.currentBridge(view).filter(item => device ?
            this.bridgeTextures.get(item.entry.id)?.device === device : this.bridgeReady.has(item.entry.id));
        let usedBridge = false;
        for (let page = Math.max(0, pageAt(input.stack, input.viewport.y)); page < input.stack.rects.length; page++) {
            const box = input.stack.rects[page];
            if (box.y >= input.viewport.y + input.viewport.height) break;
            const x = Math.max(box.x, input.viewport.x), y = Math.max(box.y, input.viewport.y);
            const right = Math.min(box.x + box.width, input.viewport.x + input.viewport.width);
            const bottom = Math.min(box.y + box.height, input.viewport.y + input.viewport.height);
            if (right <= x || bottom <= y) continue;
            const area = { x, y, width: right - x, height: bottom - y };
            if (!this.covered(page, area, device)) {
                const fallback = bridge.filter(item => item.entry.key.pageOrRegion === String(page)).map(item => item.pixels.world);
                if (!this.covered(page, area, device, fallback)) return { complete: false, sharp: false };
                usedBridge = true;
            }
        }
        if (input.moving || usedBridge) return { complete: true, sharp: false };
        const desired = planPdfTileDemand({ ...input, covered: () => false });
        for (const request of desired.requests) {
            if (request.level !== 'exact' || !intersects(rect(request), input.viewport)) continue;
            const entry = this.entries.get(tileKeyString(request.key));
            if (!entry?.bitmap || (device && entry.texture?.device !== device)) return { complete: true, sharp: false };
        }
        return { complete: true, sharp: true };
    }

    drawGpu(pass: GpuPass, view: ViewState): void {
        if (this.disposed || !this.isCurrent()) return;
        const texture = this.frameTexture;
        if (texture && texture.device === this.host.device()) for (const page of this.visiblePages(view)) {
            const destination = project(page, page, view);
            this.host.drawTexturedQuad(pass, texture.handle, { x: 0, y: 0, width: 1, height: 1 },
                { x: destination.x - 1, y: destination.y - 1, width: destination.width + 2, height: destination.height + 2 },
                { opacity: 1, sampling: 'nearest' });
            this.host.drawTexturedQuad(pass, texture.handle, { x: 1, y: 0, width: 1, height: 1 },
                destination, { opacity: 1, sampling: 'nearest' });
        }
        for (const item of this.currentBridge(view)) {
            const texture = this.bridgeTextures.get(item.entry.id);
            const snapshot = this.mirror?.view(view);
            if (!texture || texture.device !== this.host.device() || !snapshot) continue;
            const quad = this.mirror!.store.mirrorQuad(item, snapshot);
            this.host.drawTexturedQuad(pass, texture.handle, quad.sourceRect, quad.destRect, { opacity: 1, sampling: 'linear' });
        }
        const stack = this.demand(view).stack;
        for (const entry of this.drawable(view)) {
            if (!entry.texture || entry.texture.device !== this.host.device()) continue;
            const { source, destination } = this.quad(entry.request, stack.rects[entry.request.page], view);
            this.host.drawTexturedQuad(pass, entry.texture.handle, source, destination, { opacity: 1, sampling: 'linear' });
        }
    }

    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        if (this.disposed || !this.isCurrent()) return;
        for (const page of this.visiblePages(view)) {
            const box = project(page, page, view);
            ctx.fillStyle = '#bebebe'; ctx.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
            ctx.fillStyle = '#fff'; ctx.fillRect(box.x, box.y, box.width, box.height);
        }
        for (const item of this.currentBridge(view)) {
            const snapshot = this.mirror?.view(view);
            if (!snapshot || !this.bridgeReady.has(item.entry.id)) continue;
            const quad = this.mirror!.store.mirrorQuad(item, snapshot);
            this.host.drawTexturedQuad(ctx, item.pixels.bitmap, quad.sourceRect, quad.destRect, { opacity: 1, sampling: 'linear' });
        }
        const stack = this.demand(view).stack;
        for (const entry of this.drawable(view)) {
            if (!entry.bitmap) continue;
            const { source, destination } = this.quad(entry.request, stack.rects[entry.request.page], view);
            this.host.drawTexturedQuad(ctx, entry.bitmap, source, destination, { opacity: 1, sampling: 'linear' });
        }
    }

    releaseGpu(reason: GpuReleaseReason): void {
        if (this.frameTexture && reason !== 'context-lost') this.frameTexture.device.destroy(this.frameTexture.handle);
        this.frameTexture = null;
        for (const entry of this.entries.values()) {
            if (entry.texture && reason !== 'context-lost') entry.texture.device.destroy(entry.texture.handle);
            entry.texture = undefined;
        }
        for (const texture of this.bridgeTextures.values()) {
            if (reason !== 'context-lost') texture.device.destroy(texture.handle);
        }
        this.bridgeTextures.clear();
        this.bridgeReady.clear();
        this.texturePool.clear(reason === 'context-lost');
        this.pendingFrame = false;
        if (reason === 'hidden') this.hide();
    }

    /** Prospective tile and cropped-mirror storage, before requests allocate (design §6.3:640–646). */
    cpuWorkingSet(physical: Readonly<{ width: number; height: number }>): { mandatoryBytes: number; prefetchBytes: number } {
        if (!Number.isFinite(physical.width) || !Number.isFinite(physical.height) || physical.width <= 0 || physical.height <= 0) {
            return { mandatoryBytes: 0, prefetchBytes: 0 };
        }
        const q = Math.min(1, 8192 / physical.width, 8192 / physical.height,
            Math.sqrt(16777216 / (physical.width * physical.height)));
        const width = Math.ceil(physical.width * q), height = Math.ceil(physical.height * q);
        const input = this.latestDemand, view = this.latestView;
        if (!input || !view) {
            // Until the first frame there is no page geometry; admit the maximum intersecting tile grid (§5.1).
            const columns = Math.ceil(width / 512) + 1, rows = Math.ceil(height / 512) + 1;
            const mandatoryBytes = columns * rows * 514 * 514 * 4 + (this.mirror ? (width + 2 * columns) * (height + 2 * rows) * 4 : 0);
            const outer = (Math.ceil(2 * width / 512) + 1) * (Math.ceil(2 * height / 512) + 1);
            return { mandatoryBytes, prefetchBytes: Math.max(0, outer - columns * rows) * 514 * 514 * 4 };
        }
        const factor = view.camera.z * view.viewport.dpr;
        const viewport = { x: input.viewport.x, y: input.viewport.y, width: width / factor, height: height / factor };
        const requests = planPdfTileDemand({ ...input, viewport, moving: false, covered: () => false }).requests;
        const seen = new Set<string>();
        let mandatoryBytes = 0, prefetchBytes = 0;
        for (const request of requests) {
            const key = tileKeyString(request.key);
            if (seen.has(key)) continue;
            seen.add(key);
            const bounds = rect(request);
            const bytes = request.tile.textureWidth * request.tile.textureHeight * 4;
            if (!intersects(bounds, viewport)) { prefetchBytes += bytes; continue; }
            mandatoryBytes += bytes;
            if (this.mirror) {
                const left = Math.max(bounds.x, viewport.x), top = Math.max(bounds.y, viewport.y);
                const right = Math.min(bounds.x + bounds.width, viewport.x + viewport.width);
                const bottom = Math.min(bounds.y + bounds.height, viewport.y + viewport.height);
                const scale = request.scale.scale;
                const w = Math.min(request.tile.textureWidth, Math.ceil((right - left) * scale) + 3);
                const h = Math.min(request.tile.textureHeight, Math.ceil((bottom - top) * scale) + 3);
                mandatoryBytes += w * h * 4;
            }
        }
        return { mandatoryBytes, prefetchBytes };
    }

    /** Expiry drops old GPU pixels immediately, even if a hidden window suspends frames (C1.3). */
    expireBridge(): void {
        for (const texture of this.bridgeTextures.values()) texture.device.destroy(texture.handle);
        this.bridgeTextures.clear();
        this.bridgeReady.clear();
        this.host.invalidate('pdf-bridge-expired');
    }

    /** Explicit retry is the only way a failed tile is requested again. */
    retry(): void { this.failed.clear(); this.host.invalidate('pdf-tile-retry'); }

    /** Called by the pane on hide after the session has published its mirror. */
    hide(): void {
        this.mirrorJob = null;
        for (const [key, entry] of this.entries) this.remove(key, entry);
        this.desired.clear();
    }

    memory(): { gpuBytes: number; cpuBytes: number } {
        let gpuBytes = (this.frameTexture ? 8 : 0) + this.texturePool.memory(), cpuBytes = 0;
        for (const texture of this.bridgeTextures.values()) gpuBytes += texture.bytes;
        for (const entry of this.entries.values()) {
            cpuBytes += entry.lease.bytes;
            if (entry.texture) gpuBytes += entry.texture.bytes;
        }
        for (const entry of this.retiring) cpuBytes += entry.lease.bytes;
        return { gpuBytes, cpuBytes };
    }
    revision(): number { return this.contentRevision; }
    needsFrame(): boolean { return this.pendingFrame; }
    dispose(): void { if (!this.disposed) { this.disposed = true; this.mirrorJob = null; this.hide(); this.failed.clear(); } }

    private currentBridge(view: ViewState): readonly BorrowedMirror<PdfMirrorPixels>[] {
        const snapshot = this.mirror?.view(view);
        return snapshot ? this.bridge?.pixels.read(snapshot)?.entries ?? [] : [];
    }

    private prepareBridge(view: ViewState, budget: FrameBudget, device: GfxDevice | null): void {
        const entries = this.currentBridge(view);
        const valid = new Set(entries.map(item => item.entry.id));
        this.bridgeReady = new Set();
        for (const [id, texture] of this.bridgeTextures) {
            if (!valid.has(id) || texture.device !== device) {
                this.bridgeTextures.delete(id);
                texture.device.destroy(texture.handle);
            }
        }
        for (const item of entries) {
            if (budget.shouldYield()) { this.pendingFrame = true; break; }
            const bitmap = item.pixels.bitmap;
            const existing = this.bridgeTextures.get(item.entry.id);
            if (device && existing?.device === device) continue;
            if (!budget.claimUpload(bitmap.width * bitmap.height * 4)) { this.pendingFrame = true; break; }
            if (!device) { this.bridgeReady.add(item.entry.id); continue; }
            const texture = this.texturePool.acquire(device, bitmap.width, bitmap.height);
            if (!texture) break;
            try {
                device.writeTexture(texture.handle, { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
                    { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                this.bridgeTextures.set(item.entry.id, texture);
            } catch (error) { device.destroy(texture.handle); throw error; }
        }
    }

    private prepareMirror(view: ViewState, input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>,
        requests: readonly PdfTileRequest[], budget: FrameBudget): void {
        const mirror = this.mirror;
        const snapshot = mirror?.view(view);
        if (!mirror || !snapshot || input.moving || this.disposed) { this.mirrorJob = null; return; }
        const key = JSON.stringify([snapshot.token, snapshot.sourceRole, snapshot.contentRevision, snapshot.colourVersion,
            snapshot.geometryDigest, snapshot.nominalDpr, snapshot.view.camera, snapshot.view.viewport]);
        if (key === this.mirrorKey) return;
        if (this.mirrorJob?.key !== key) {
            const exact = requests.filter(request => request.level === 'exact' && intersects(rect(request), input.viewport));
            const entries = exact.map(request => this.entries.get(tileKeyString(request.key)));
            if (!entries.length || entries.some(entry => !entry?.bitmap)) { this.mirrorJob = null; return; }
            const low = requests.filter(request => request.level === 'low' && intersects(rect(request), input.viewport))
                .map(request => this.entries.get(tileKeyString(request.key)))
                .filter((entry): entry is Entry => !!entry?.bitmap);
            this.mirrorJob = { key, view: snapshot, entries: [...low, ...entries as Entry[]], ids: [],
                lowIds: new Set(), index: 0, pending: false };
        }
        const job = this.mirrorJob;
        if (!job || job.pending || budget.shouldYield()) return;
        if (job.index === job.entries.length) {
            const mirrors = mirror.store.mirrors;
            mirrors.commitFrame(job.view, job.ids, true, job.lowIds);
            const borrow = mirrors.borrow(job.view, performance.now());
            const sharp = borrow.sharpEligible(job.view);
            borrow.release();
            if (sharp) {
                mirrors.retainViewport(new Set(job.ids));
                mirror.store.remember(job.view);
                this.mirrorKey = job.key;
            }
            this.mirrorJob = null;
            return;
        }
        const entry = job.entries[job.index];
        const bitmap = entry.bitmap;
        if (!bitmap || this.entries.get(tileKeyString(entry.request.key)) !== entry) { this.mirrorJob = null; return; }
        const bounds = rect(entry.request), viewport = input.viewport;
        const left = Math.max(bounds.x, viewport.x), top = Math.max(bounds.y, viewport.y);
        const right = Math.min(bounds.x + bounds.width, viewport.x + viewport.width);
        const bottom = Math.min(bounds.y + bounds.height, viewport.y + viewport.height);
        const scale = entry.request.scale.scale, edges = entry.request.tile.edges;
        const sx = Math.max(0, Math.floor(1 + (left - edges.left) * scale) - 1);
        const sy = Math.max(0, Math.floor(1 + (top - edges.top) * scale) - 1);
        const ex = Math.min(bitmap.width, Math.ceil(1 + (right - edges.left) * scale) + 1);
        const ey = Math.min(bitmap.height, Math.ceil(1 + (bottom - edges.top) * scale) + 1);
        const width = ex - sx, height = ey - sy;
        if (width <= 0 || height <= 0) { this.mirrorJob = null; return; }
        const lease = this.host.allocator.cpu.reserve(width * height * 4);
        if (!lease) return;
        job.pending = true;
        // One cropped allocation per preparation slice; an obsolete view cannot publish (design §6.4:649).
        void createImageBitmap(bitmap, sx, sy, width, height).then(copy => {
            if (this.mirrorJob !== job || this.disposed || !this.isCurrent()) {
                copy.close(); this.host.allocator.cpu.release(lease); return;
            }
            const world = { x: left, y: top, width: right - left, height: bottom - top };
            const page = input.stack.rects[entry.request.page];
            const source = { x: 1 + (left - edges.left) * scale - sx, y: 1 + (top - edges.top) * scale - sy,
                width: world.width * scale, height: world.height * scale };
            let id: string | null;
            try {
                id = mirror.store.publish({ token: job.view.token, key: entry.request.key,
                    geometryDigest: job.view.geometryDigest, tier: entry.request.level === 'low' ? 'low' : 'exact', neededByCurrentFrame: true,
                    pixels: { bitmap: copy, world, source, page }, lease });
            } catch (error) {
                copy.close(); this.host.allocator.cpu.release(lease); this.mirrorJob = null;
                this.onError(error, entry.request); return;
            }
            if (!id) { copy.close(); this.host.allocator.cpu.release(lease); this.mirrorJob = null; return; }
            job.ids.push(id);
            if (entry.request.level === 'low') job.lowIds.add(id);
            job.index++;
            job.pending = false;
            this.host.invalidate('pdf-mirror-arrived');
        }, error => {
            this.host.allocator.cpu.release(lease);
            if (this.mirrorJob === job) { this.mirrorJob = null; this.onError(error, entry.request); }
        });
    }

    private covered(page: number, area: Readonly<Rect>, device: GfxDevice | null,
        additional: readonly Readonly<Rect>[] = []): boolean {
        const boxes: Readonly<Rect>[] = [...additional];
        for (const entry of this.entries.values()) {
            if (entry.request.page !== page || !entry.bitmap || (device && entry.texture?.device !== device)) continue;
            boxes.push(rect(entry.request));
        }
        return covers(area, boxes);
    }

    private visiblePages(view: ViewState): readonly Rect[] {
        const input = this.demand(view), result: Rect[] = [];
        for (let index = Math.max(0, pageAt(input.stack, input.viewport.y)); index < input.stack.rects.length; index++) {
            const page = input.stack.rects[index];
            if (page.y >= input.viewport.y + input.viewport.height) break;
            if (intersects(page, input.viewport)) result.push(page);
        }
        return result;
    }

    private drawable(view: ViewState): Entry[] {
        const input = this.demand(view);
        if (contentFamily(input) !== this.contentIdentity) return [];
        const viewport = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
        return [...this.entries.values()].filter(entry => entry.bitmap && intersects(rect(entry.request), viewport))
            .sort((a, b) => a.request.scale.scale - b.request.scale.scale || a.used - b.used);
    }

    private quad(request: PdfTileRequest, page: Readonly<Rect>, view: ViewState): { source: Rect; destination: Rect } {
        const bounds = rect(request), edges = request.tile.edges, scale = request.scale.scale;
        return { source: { x: 1 + (bounds.x - edges.left) * scale, y: 1 + (bounds.y - edges.top) * scale,
            width: bounds.width * scale, height: bounds.height * scale }, destination: project(bounds, page, view) };
    }

    private evictUnneeded(viewport: Readonly<Rect>, neededBytes: number): void {
        const candidates = this.entries.evictable(this.desired, viewport, entry => rect(entry.request), entry => !!entry.bitmap);
        candidates.sort((a, b) => Number(a[1].request.level === 'low') - Number(b[1].request.level === 'low') ||
            a[1].used - b[1].used);
        let freed = 0;
        for (const [key, entry] of candidates) {
            freed += entry.lease.bytes;
            this.remove(key, entry);
            if (freed >= neededBytes) break;
        }
    }

    private remove(key: string, entry: Entry): void {
        if (this.entries.get(key) !== entry) return;
        this.entries.delete(key);
        entry.controller.abort();
        if (entry.texture) this.texturePool.release(entry.texture);
        if (entry.bitmap) {
            this.contentRevision++;
            entry.bitmap.close();
            this.host.allocator.cpu.release(entry.lease);
        } else {
            // Cancellation is best effort: the transferred bitmap and its CPU
            // reservation remain owned until the producer actually settles.
            this.retiring.add(entry);
        }
    }

    private finishRetiring(entry: Entry): void {
        if (!this.retiring.delete(entry)) return;
        this.host.allocator.cpu.release(entry.lease);
    }
}
