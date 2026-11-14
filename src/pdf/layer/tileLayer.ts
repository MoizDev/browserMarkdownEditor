import { pageAt, renderTokenKey, tileKeyString } from '../../platform/render';
import type { ByteLease, FrameBudget, GfxDevice, GpuPass, GpuReleaseReason, Layer, LayerHost, MirrorView, Rect, TextureHandle, ViewState } from '../../platform/render';
import type { PdfSessionMirrors } from './tileMirror';
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
    texture?: TextureHandle;
    device?: GfxDevice;
    used: number;
}

function rect(request: PdfTileRequest): Rect {
    const c = request.tile.clip;
    return { x: c.left, y: c.top, width: c.right - c.left, height: c.bottom - c.top };
}

function intersects(a: Readonly<Rect>, b: Readonly<Rect>): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Exact rectangle union, not a bounding-box guess across missing tile holes. */
function covers(target: Readonly<Rect>, boxes: readonly Rect[]): boolean {
    const cuts = [target.x, target.x + target.width];
    for (const box of boxes) {
        if (!intersects(box, target)) continue;
        cuts.push(Math.max(target.x, box.x), Math.min(target.x + target.width, box.x + box.width));
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
        if (cuts[i] <= cuts[i - 1]) continue;
        const x = (cuts[i] + cuts[i - 1]) / 2;
        const intervals = boxes.filter(box => box.x <= x && box.x + box.width >= x)
            .map(box => [Math.max(target.y, box.y), Math.min(target.y + target.height, box.y + box.height)] as const)
            .filter(([top, bottom]) => bottom > top).sort((a, b) => a[0] - b[0]);
        let end = target.y;
        for (const [top, bottom] of intervals) { if (top > end + 1e-7) break; end = Math.max(end, bottom); }
        if (end < target.y + target.height - 1e-7) return false;
    }
    return true;
}

function project(box: Readonly<Rect>, view: ViewState): Rect {
    const scale = view.camera.z * view.viewport.dpr;
    return { x: (box.x - view.camera.x) * scale, y: (box.y - view.camera.y) * scale,
        width: box.width * scale, height: box.height * scale };
}

/**
 * A page layer has no frame loop and never opens a worker. The pane gives it a
 * session-bound producer; scheduler budgets, allocator leases and device lifetime
 * come from the shared host. Waiting for a worker alone is not frame work.
 */
export class PdfTileLayer implements Layer {
    private readonly entries = new Map<string, Entry>();
    private readonly failed = new Set<string>();
    private readonly retiring = new Set<Entry>();
    private desired = new Set<string>();
    private sequence = 0;
    private contentRevision = 0;
    private pendingFrame = false;
    private frameTexture: { device: GfxDevice; handle: TextureHandle } | null = null;
    private disposed = false;
    private contentIdentity = '';
    private lastMotionScale: PdfDemandInput['previousMotionScale'];
    private mirrorJob: MirrorJob | null = null;
    private mirrorKey = '';

    constructor(private readonly host: LayerHost, private readonly producer: PdfTileProducer,
        private readonly demand: (view: ViewState) => Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>,
        private readonly isCurrent: () => boolean,
        private readonly onError: (error: unknown, request: PdfTileRequest) => void,
        private readonly mirror?: PdfLayerMirror) {}

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
        const identity = JSON.stringify([renderTokenKey(input.token), input.source, input.variant]);
        if (identity !== this.contentIdentity) {
            for (const [key, entry] of this.entries) this.remove(key, entry);
            this.failed.clear();
            this.contentIdentity = identity;
            this.lastMotionScale = undefined;
        }
        const planned = planPdfTileDemand({ ...input, previousMotionScale: this.lastMotionScale,
            covered: (page, area) => this.covered(page, area, device) });
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
                if (device && existing.bitmap && existing.device !== device) {
                    if (budget.shouldYield()) { this.pendingFrame = true; break; }
                    const bytes = existing.bitmap.width * existing.bitmap.height * 4;
                    if (!budget.claimUpload(bytes)) { this.pendingFrame = true; break; }
                    const lease = this.host.allocator.gpu.reserve(bytes);
                    if (!lease) continue;
                    let texture: TextureHandle;
                    try { texture = device.createTexture(existing.bitmap.width, existing.bitmap.height, 'rgba8', ['sample', 'copy-dst'], lease); }
                    catch (error) { this.host.allocator.gpu.release(lease); this.onError(error, request); continue; }
                    try {
                        device.writeTexture(texture, { x: 0, y: 0, width: existing.bitmap.width, height: existing.bitmap.height },
                            { source: existing.bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                        if (existing.texture && existing.device) existing.device.destroy(existing.texture);
                        existing.texture = texture; existing.device = device;
                    } catch (error) { device.destroy(texture); this.onError(error, request); }
                }
                continue;
            }
            if (this.failed.has(key) || running >= 3) continue;
            if (budget.shouldYield()) { this.pendingFrame = true; break; }
            const bytes = request.tile.textureWidth * request.tile.textureHeight * 4;
            let lease = this.host.allocator.cpu.reserve(bytes);
            if (!lease) {
                this.evictUnneeded(input.viewport);
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
        if (JSON.stringify([renderTokenKey(input.token), input.source, input.variant]) !== this.contentIdentity) {
            return { complete: false, sharp: false };
        }
        const device = gpu ? this.host.device() : null;
        if (gpu && !device) return { complete: false, sharp: false };
        for (let page = Math.max(0, pageAt(input.stack, input.viewport.y)); page < input.stack.rects.length; page++) {
            const box = input.stack.rects[page];
            if (box.y >= input.viewport.y + input.viewport.height) break;
            const x = Math.max(box.x, input.viewport.x), y = Math.max(box.y, input.viewport.y);
            const right = Math.min(box.x + box.width, input.viewport.x + input.viewport.width);
            const bottom = Math.min(box.y + box.height, input.viewport.y + input.viewport.height);
            if (right > x && bottom > y && !this.covered(page, { x, y, width: right - x, height: bottom - y }, device)) {
                return { complete: false, sharp: false };
            }
        }
        if (input.moving) return { complete: true, sharp: false };
        const desired = planPdfTileDemand({ ...input, covered: () => false });
        for (const request of desired.requests) {
            if (request.level !== 'exact' || !intersects(rect(request), input.viewport)) continue;
            const entry = this.entries.get(tileKeyString(request.key));
            if (!entry?.bitmap || (device && entry.device !== device)) return { complete: true, sharp: false };
        }
        return { complete: true, sharp: true };
    }

    drawGpu(pass: GpuPass, view: ViewState): void {
        if (this.disposed || !this.isCurrent()) return;
        const texture = this.frameTexture;
        if (texture && texture.device === this.host.device()) for (const page of this.visiblePages(view)) {
            const destination = project(page, view);
            this.host.drawTexturedQuad(pass, texture.handle, { x: 0, y: 0, width: 1, height: 1 },
                { x: destination.x - 1, y: destination.y - 1, width: destination.width + 2, height: destination.height + 2 },
                { opacity: 1, sampling: 'nearest' });
            this.host.drawTexturedQuad(pass, texture.handle, { x: 1, y: 0, width: 1, height: 1 },
                destination, { opacity: 1, sampling: 'nearest' });
        }
        for (const entry of this.drawable(view)) {
            if (!entry.texture || entry.device !== this.host.device()) continue;
            const { source, destination } = this.quad(entry.request, view);
            this.host.drawTexturedQuad(pass, entry.texture, source, destination, { opacity: 1, sampling: 'linear' });
        }
    }

    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        if (this.disposed || !this.isCurrent()) return;
        for (const page of this.visiblePages(view)) {
            const box = project(page, view);
            ctx.fillStyle = '#bebebe'; ctx.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
            ctx.fillStyle = '#fff'; ctx.fillRect(box.x, box.y, box.width, box.height);
        }
        for (const entry of this.drawable(view)) {
            if (!entry.bitmap) continue;
            const { source, destination } = this.quad(entry.request, view);
            this.host.drawTexturedQuad(ctx, entry.bitmap, source, destination, { opacity: 1, sampling: 'linear' });
        }
    }

    releaseGpu(reason: GpuReleaseReason): void {
        if (this.frameTexture && reason !== 'context-lost') this.frameTexture.device.destroy(this.frameTexture.handle);
        this.frameTexture = null;
        for (const entry of this.entries.values()) {
            if (entry.texture && entry.device && reason !== 'context-lost') entry.device.destroy(entry.texture);
            entry.texture = undefined; entry.device = undefined;
        }
        this.pendingFrame = false;
        if (reason === 'hidden') this.hide();
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
        let gpuBytes = this.frameTexture ? 8 : 0, cpuBytes = 0;
        for (const entry of this.entries.values()) {
            cpuBytes += entry.lease.bytes;
            if (entry.texture) gpuBytes += entry.lease.bytes;
        }
        for (const entry of this.retiring) cpuBytes += entry.lease.bytes;
        return { gpuBytes, cpuBytes };
    }
    revision(): number { return this.contentRevision; }
    needsFrame(): boolean { return this.pendingFrame; }
    dispose(): void { if (!this.disposed) { this.disposed = true; this.mirrorJob = null; this.hide(); this.failed.clear(); } }

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
        const sx = Math.max(0, Math.floor(1 + (left - edges.left) * scale));
        const sy = Math.max(0, Math.floor(1 + (top - edges.top) * scale));
        const ex = Math.min(bitmap.width, Math.ceil(1 + (right - edges.left) * scale));
        const ey = Math.min(bitmap.height, Math.ceil(1 + (bottom - edges.top) * scale));
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
            const source = { x: 1 + (left - edges.left) * scale - sx, y: 1 + (top - edges.top) * scale - sy,
                width: world.width * scale, height: world.height * scale };
            let id: string | null;
            try {
                id = mirror.store.publish({ token: job.view.token, key: entry.request.key,
                    geometryDigest: job.view.geometryDigest, tier: entry.request.level === 'low' ? 'low' : 'exact', neededByCurrentFrame: true,
                    pixels: { bitmap: copy, world, source }, lease });
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

    private covered(page: number, area: Readonly<Rect>, device: GfxDevice | null): boolean {
        const boxes: Rect[] = [];
        for (const entry of this.entries.values()) {
            if (entry.request.page !== page || !entry.bitmap || (device && entry.device !== device)) continue;
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
        if (JSON.stringify([renderTokenKey(input.token), input.source, input.variant]) !== this.contentIdentity) return [];
        const viewport = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
        return [...this.entries.values()].filter(entry => entry.bitmap && intersects(rect(entry.request), viewport))
            .sort((a, b) => a.request.scale.scale - b.request.scale.scale || a.used - b.used);
    }

    private quad(request: PdfTileRequest, view: ViewState): { source: Rect; destination: Rect } {
        const bounds = rect(request), edges = request.tile.edges, scale = request.scale.scale;
        return { source: { x: 1 + (bounds.x - edges.left) * scale, y: 1 + (bounds.y - edges.top) * scale,
            width: bounds.width * scale, height: bounds.height * scale }, destination: project(bounds, view) };
    }

    private evictUnneeded(viewport: Readonly<Rect>): void {
        const candidates = [...this.entries].filter(([key, entry]) => entry.bitmap && !this.desired.has(key) &&
            !intersects(rect(entry.request), viewport))
            .sort((a, b) => a[1].used - b[1].used);
        for (const [key, entry] of candidates) this.remove(key, entry);
    }

    private remove(key: string, entry: Entry): void {
        if (this.entries.get(key) !== entry) return;
        this.entries.delete(key);
        entry.controller.abort();
        if (entry.texture && entry.device) entry.device.destroy(entry.texture);
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
