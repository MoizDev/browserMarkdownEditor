import { pageAt, pagePresentation, renderTokenKey } from '../../platform/render';
import type { ByteLease, FrameBudget, GfxDevice, GpuPass, GpuReleaseReason, Layer, LayerHost, MirrorView, PageStack, Rect, TextureHandle, ViewState } from '../../platform/render';
import type { PdfMirrorPixels, PdfSessionMirrors } from './tileMirror';
import type { PdfVersionBridge } from './versionBridge';
import type { BorrowedMirror } from '../../platform/render';
import { covers, intersects } from './coverage';
import { PdfTileCache } from './tileCache';
import { PdfTexturePool, type PooledTexture } from './texturePool';
import { planPdfTileDemand } from './tileDemand';
import type { PdfDemandInput, PdfTileRequest } from './tileDemand';
import { getPdfFontEpoch, pdfMirrorProfilePrefix, pdfVariantRevision } from '../fonts/profiles';
import { pdfDocKey } from '../worker/protocol';
import { consumePdfTileArrival, forgetPdfTileArrival } from '../pool/arrivalWindow';
import { auditCount, auditDrawn } from '../../platform/render/renderAudit';
import { QuadList } from './quadList';

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
    /** The CPU bitmap's charge; null once a GPU-resident tile let its bitmap go. */
    lease: ByteLease | null;
    readonly controller: AbortController;
    /** The producer settled with pixels: they live in `bitmap`, `texture` or both. */
    settled?: boolean;
    bitmap?: ImageBitmap;
    texture?: PooledTexture;
    used: number;
}

const NO_BOXES: readonly Readonly<Rect>[] = [];

/** Mirror crops kept by version; past this many, the versions the session no longer holds are dropped. */
const MIRROR_VERSION_LIMIT = 256;

function mirrorVersionKey(view: MirrorView, request: PdfTileRequest): string {
    return JSON.stringify([view.geometryDigest, view.contentRevision, request.text]);
}

/** The part of `box` inside `viewport`, or null when none of it is visible. */
function clipped(box: Readonly<Rect>, viewport: Readonly<Rect>): Rect | null {
    const x = Math.max(box.x, viewport.x), y = Math.max(box.y, viewport.y);
    const right = Math.min(box.x + box.width, viewport.x + viewport.width);
    const bottom = Math.min(box.y + box.height, viewport.y + viewport.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Pixels this backend can draw: the device's texture, or the CPU bitmap (which a GPU backend can still upload). */
/** A zoom gesture's scale changes every few frames; this long without a change, it has settled enough to raster. */
const ZOOM_SETTLE_MS = 150;

function drawableOn(entry: Entry, device: GfxDevice | null): boolean {
    return device ? entry.texture?.device === device || !!entry.bitmap : !!entry.bitmap;
}

function contentFamily(input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>): string {
    const { vaultEpoch, documentId, session } = input.token;
    return JSON.stringify([vaultEpoch, documentId, session, input.source, pdfVariantRevision(input.variant, input.fontEpoch ?? 0), input.geometryDigest]);
}

function mirrorViewKey(snapshot: MirrorView): string {
    return JSON.stringify([snapshot.token, snapshot.sourceRole, snapshot.contentRevision, snapshot.colourVersion,
        snapshot.geometryDigest, snapshot.nominalDpr, snapshot.view.camera, snapshot.view.viewport]);
}

function rect(request: PdfTileRequest): Rect {
    const c = request.tile.clip;
    return { x: c.left, y: c.top, width: c.right - c.left, height: c.bottom - c.top };
}

function project(box: Readonly<Rect>, page: Readonly<Rect>, view: ViewState): Rect {
    return projectInto(box, page, view, { x: 0, y: 0, width: 0, height: 0 });
}

/** Writes the box's device placement into `out`: a frame projects every visible tile, so the draw path reuses one rect. */
function projectInto(box: Readonly<Rect>, page: Readonly<Rect>, view: ViewState, out: Rect): Rect {
    const scale = view.camera.z * view.viewport.dpr;
    const offset = pagePresentation(page, view).restOffsetDevice;
    out.x = (box.x - view.camera.x) * scale + offset.x;
    out.y = (box.y - view.camera.y) * scale + offset.y;
    out.width = box.width * scale;
    out.height = box.height * scale;
    return out;
}

/**
 * A page layer has no frame loop and never opens a worker. The pane gives it a
 * session-bound producer; scheduler budgets, allocator leases and device lifetime
 * come from the shared host. Waiting for a worker alone is not frame work.
 */
export class PdfTileLayer implements Layer {
    declare readonly benchmarkRaster?: boolean;
    private readonly entries = new PdfTileCache<Entry>();
    private readonly failed = new Set<string>();
    private readonly retiring = new Set<Entry>();
    private readonly texturePool: PdfTexturePool;
    private readonly bridgeTextures = new Map<string, PooledTexture>();
    private bridgeReady = new Set<string>();
    private desired = new Set<string>();
    /** The exact tiles this frame's plan asked for, by key, with the view prepare planned them for. Coverage reads it:
     * a second plan per coverage call re-did the whole demand walk every frame (by reading: the compositor calls
     * coverage on every encoded frame). Null while moving or before the first plan. */
    private framePlan: { readonly view: ViewState; readonly exactKeys: readonly string[] } | null = null;
    /** The frame id this layer last prepared: `evictGpu` may act only for it. */
    private preparedFrame = -1;
    private sequence = 0;
    private contentRevision = 0;
    private pendingFrame = false;
    private frameTexture: { device: GfxDevice; handle: TextureHandle } | null = null;
    private disposed = false;
    private contentIdentity = '';
    private lastMotionScale: PdfDemandInput['previousMotionScale'];
    private motionScaleAt = 0;
    private lastZoomValue = 0;
    private scaleChangedAt = 0;
    private latestDemand: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'> | null = null;
    private latestView: ViewState | null = null;
    private mirrorJob: MirrorJob | null = null;
    private mirrorKey = '';
    private criticalMemo: { view: ViewState; revision: number; value: boolean } | null = null;
    /** A settled view whose mirror cannot be cropped because a visible tile is GPU-only; it keeps its older mirror. */
    private mirrorSkipped = '';
    /** Pages whose paper went down at the current source and layout, by page index, with the world rect painted. The
     * paper covers the whole page, so these areas are opaque. Cleared on a source change, on releaseGpu and on dispose. */
    private readonly drawnPages = new Map<number, Readonly<Rect>>();
    private drawnStack: Readonly<PageStack> | null = null;
    /** Published mirror crops by tile version (geometry, mirror revision, tile key). A version still held is reused with no
     * copy: the copy is the whole tile, so it is the same for every view that shows the tile. Cleared on a source change. */
    private readonly mirrorIds = new Map<string, string>();
    /** One outstanding capacity waiter per pool: a refused tile asks the governor to wake the layer when its bytes fit. */
    private awaitingGpu = false;
    private awaitingCpu = false;
    /** The paper quads of one frame, drawn as one batch: every visible page shares the frame texture. */
    private readonly paper = new QuadList();
    private readonly paperRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
    /** The one tile quad of the draw in progress, reused for every tile of every frame. */
    private readonly tileQuad: { source: Rect; destination: Rect } = {
        source: { x: 0, y: 0, width: 0, height: 0 }, destination: { x: 0, y: 0, width: 0, height: 0 } };
    /** Drawable tile rects by page, for one device. Planning asks `covered` for every visible tile; the uncached version
     * scanned every entry and built a fresh array per tile, so one frame cost tiles × entries (by reading: a zoom step
     * plans hundreds of tiles). Dropped wherever an entry's drawability changes; a new unsettled entry is never drawable. */
    private coverCache: { readonly device: GfxDevice | null; readonly boxes: ReadonlyMap<number, readonly Readonly<Rect>[]> } | null = null;

    constructor(private readonly host: LayerHost, private readonly producer: PdfTileProducer,
        private readonly demand: (view: ViewState) => Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>,
        private readonly isCurrent: () => boolean,
        private readonly onError: (error: unknown, request: PdfTileRequest) => void,
        private readonly mirror?: PdfLayerMirror, private readonly bridge?: PdfVersionBridge | null) {
        if (__BME_BENCH__) this.benchmarkRaster = true;
        this.texturePool = new PdfTexturePool(host.allocator.gpu);
    }

    prepare(view: ViewState, budget: FrameBudget): void {
        this.pendingFrame = false;
        this.framePlan = null;
        this.preparedFrame = budget.frameId;
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
            this.mirrorJob = null;
            for (const [key, entry] of this.entries) this.remove(key, entry);
            this.failed.clear();
            this.contentIdentity = identity;
            this.drawnPages.clear();
            this.drawnStack = null;
            this.mirrorIds.clear();
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
        // The camera's zoom, not the tile scale's kind: a pan or drag flips between motion and exact tiles at about the
        // same scale, and counting that as a zoom deferred tiles during plain drags (measured: 40 per drag).
        const zoomValue = input.rasterScale;
        if (!this.lastZoomValue || Math.abs(zoomValue / this.lastZoomValue - 1) > 0.01) { this.lastZoomValue = zoomValue; this.scaleChangedAt = now; }
        // While a zoom is still changing the scale, a tile whose area a stand-in already shows is not started: it
        // usually finishes after the zoom has moved past its scale and is thrown away (measured on a 1000-page PDF:
        // 18-32 of 66 rasters per zoom gesture dropped unused). Uncovered area is still rastered at once.
        const zooming = !!device && now - this.scaleChangedAt < ZOOM_SETTLE_MS;
        this.lastMotionScale = planned.motionScale;
        this.desired = new Set(planned.requests.map(request => request.text));
        if (!input.moving) {
            const exactKeys = planned.requests.filter(request => request.level === 'exact' && intersects(rect(request), input.viewport))
                .map(request => request.text);
            this.framePlan = { view, exactKeys };
        }
        const exactScale = planned.requests.find(request => request.level === 'exact')?.scale.scale;
        // Built at most once per prepare, and only when an other-scale stand-in asks: removals below touch only entries
        // outside the plan, so the plan's drawable tiles do not change during the loop.
        let planBoxes: Map<number, Readonly<Rect>[]> | null = null;
        const replaceable = (entry: Entry): boolean => {
            const area = clipped(rect(entry.request), input.viewport);
            if (!area) return true;
            planBoxes ??= this.drawablePlanBoxes(device);
            return covers(area, planBoxes.get(entry.request.page) ?? []);
        };
        for (const [key, entry] of this.entries) {
            // A running off-window render is cancelled; settled older scales
            // remain available as stand-ins until the allocator needs space.
            if (!entry.settled && !this.desired.has(key)) this.remove(key, entry);
            // On a GPU backend a stand-in is a texture. A bitmap that arrived after the plan moved on was never
            // uploaded and never will be (measured: a 40-step zoom rastered 51 tiles, uploaded 18, and left 31 MB
            // of such bitmaps charged until the pane stopped at cpu-floor-denied).
            else if (device && entry.settled && entry.texture?.device !== device && !this.desired.has(key)) {
                auditCount('pdf-page', 'fallback:raster-unused');
                this.remove(key, entry);
            }
            // Another scale's off-plan texture stays as a stand-in until the plan's own tiles cover its visible part.
            // Dropping it at once showed a blank page while the replacement rastered (by reading: a non-moving zoom
            // evicted every old-scale tile in the frame the new scale was planned). Off-view ones go at once, as
            // before. Same-scale tiles stay as the scroll cache. Measured: one zoom left 34 MB of old-scale
            // textures, and the next window resize pushed the pool over its target and degraded the pane to 0.64.
            // Motion tiles stay: the next scroll draws them again. Scales compare with a tolerance, since the same zoom
            // recomputes its scale with float noise (1.4379084967320261 vs ...255).
            else if (!input.moving && entry.settled && !this.desired.has(key) && exactScale !== undefined &&
                entry.request.level === 'exact' && Math.abs(entry.request.scale.scale / exactScale - 1) > 1e-6) {
                if (replaceable(entry)) {
                    auditCount('pdf-page', 'evict-other-scale');
                    this.remove(key, entry);
                } else auditCount('pdf-page', 'stand-in-held');
            }
        }
        let running = [...this.entries.values()].filter(entry => !entry.settled).length;
        for (const request of planned.requests) {
            const key = request.text;
            let existing = this.entries.get(key);
            // A GPU-resident tile whose bitmap was released is lost with its device and rastered again on the new one.
            // A 2D-bridge frame keeps it: that frame draws the mirror, and the next GPU frame still has the texture
            // (measured: a window resize re-rastered 2 visible tiles through one bridge frame).
            if (existing?.settled && device && !drawableOn(existing, device)) {
                auditCount('pdf-page', 'fallback:re-raster-after-release');
                this.remove(key, existing); existing = undefined;
            }
            if (existing) {
                if (device && existing.texture?.device === device) auditCount('pdf-page', 'cache-hit');
                existing.used = ++this.sequence;
                if (device && existing.bitmap && existing.texture?.device !== device) {
                    if (budget.shouldYield()) { this.pendingFrame = true; break; }
                    // Storage before budget: a claim whose texture was then refused still spent the frame's upload
                    // allowance, so the next tile never fit it, frame after frame, and the page stayed blurred.
                    let texture: PooledTexture | null;
                    try { texture = this.acquireTexture(device, existing.bitmap.width, existing.bitmap.height); }
                    catch (error) { this.onError(error, request); continue; }
                    if (!texture) { this.awaitGpuCapacity(existing.bitmap.width * existing.bitmap.height * 4); continue; }
                    // The reclaim may have taken this very tile when it was off view (a prefetch).
                    if (this.entries.get(key) !== existing || !existing.bitmap) { this.texturePool.release(texture); continue; }
                    if (!budget.claimUpload(existing.bitmap.width * existing.bitmap.height * 4)) {
                        this.texturePool.release(texture); this.pendingFrame = true; break;
                    }
                    try {
                        device.writeTexture(texture.handle, { x: 0, y: 0, width: existing.bitmap.width, height: existing.bitmap.height },
                            { source: existing.bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                        if (existing.texture) { this.texturePool.release(existing.texture); auditCount('pdf-page', 're-upload'); }
                        existing.texture = texture;
                        this.coverCache = null;
                        consumePdfTileArrival(existing.bitmap);
                    } catch (error) { device.destroy(texture.handle); this.onError(error, request); }
                }
                continue;
            }
            if (this.failed.has(key) || running >= 3) continue;
            if (zooming && this.covered(request.page, rect(request), device)) { auditCount('pdf-page', 'zoom-deferred'); this.pendingFrame = true; continue; }
            if (budget.shouldYield()) { this.pendingFrame = true; break; }
            const bytes = request.tile.textureWidth * request.tile.textureHeight * 4;
            let lease = this.host.allocator.cpu.reserve(bytes);
            if (!lease) {
                this.evictUnneeded(input.viewport, bytes);
                lease = this.host.allocator.cpu.reserve(bytes);
            }
            if (!lease) { this.awaitCpuCapacity(bytes); continue; }
            const entry: Entry = { request, lease, controller: new AbortController(), used: ++this.sequence };
            this.entries.set(key, entry); running++;
            void Promise.resolve().then(() => this.producer.render(request, entry.controller.signal)).then(bitmap => {
                const current = !this.disposed && this.isCurrent() && this.entries.get(key) === entry && !entry.controller.signal.aborted;
                if (!current || bitmap.width !== request.tile.textureWidth || bitmap.height !== request.tile.textureHeight) {
                    forgetPdfTileArrival(bitmap);
                    bitmap.close();
                    if (this.entries.get(key) === entry) this.remove(key, entry);
                    this.finishRetiring(entry);
                    if (current) { this.failed.add(key); this.onError(new Error('PDF tile has unexpected dimensions'), request); this.host.invalidate('pdf-tile-invalid'); }
                    return;
                }
                entry.bitmap = bitmap;
                entry.settled = true;
                this.coverCache = null;
                auditCount('pdf-page', 'cpu-raster', 1, { px: bitmap.width * bitmap.height });
                this.contentRevision++;
                this.host.invalidate('pdf-tile-arrived');
            }, error => {
                const current = this.entries.get(key) === entry;
                const cancelled = entry.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
                if (current) this.remove(key, entry);
                this.finishRetiring(entry);
                if (!current) return;
                if (!cancelled && this.isCurrent()) { this.failed.add(key); this.onError(error, request); }
                this.host.invalidate('pdf-tile-finished');
            });
        }
        this.prepareMirror(view, input, planned.requests, budget);
        if (device) this.releaseUploadedBitmaps(view, input.viewport, device);
    }

    /**
     * On a GPU backend a tile's texture is its pixels; keeping the PDFium bitmap as well doubled every tile into the
     * 32 MB CPU pool, which then sat over its target, degraded the pane to quality 0.5 for good and so no frame was
     * ever sharp (measured: CPU 30-33 MB after one zoom, read view blurry and Annotate's tools disabled). A bitmap stays
     * only while the settled view's 2D mirror may still crop it: a visible tile until that view's mirror is made.
     */
    private releaseUploadedBitmaps(view: ViewState, viewport: Readonly<Rect>, device: GfxDevice): void {
        const snapshot = this.mirror?.view(view);
        // One key per call: it is a JSON string, and the expression below hashed the same snapshot up to twice.
        const snapshotKey = snapshot ? mirrorViewKey(snapshot) : '';
        const mirrored = !snapshot || snapshotKey === this.mirrorKey || snapshotKey === this.mirrorSkipped;
        for (const [key, entry] of this.entries) {
            if (!entry.bitmap || entry.texture?.device !== device) continue;
            // Only the current plan's visible tiles feed the mirror; an older scale kept as a stand-in never does
            // (measured: a zoom left 31 MB of visible stand-in bitmaps charged and the pane at cpu-floor-denied).
            if (!mirrored && this.desired.has(key) && intersects(rect(entry.request), viewport)) continue;
            forgetPdfTileArrival(entry.bitmap);
            entry.bitmap.close();
            entry.bitmap = undefined;
            this.coverCache = null;
            if (entry.lease) { this.host.allocator.cpu.release(entry.lease); entry.lease = null; }
        }
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
        // Sharp only for the view prepare planned this frame: any other view is not proven sharp, and not refused either.
        const plan = this.framePlan;
        if (!plan || plan.view !== view) return { complete: true, sharp: false };
        for (const key of plan.exactKeys) {
            const entry = this.entries.get(key);
            if (!entry || !drawableOn(entry, device) || (device && entry.texture?.device !== device)) return { complete: true, sharp: false };
        }
        return { complete: true, sharp: true };
    }

    drawGpu(pass: GpuPass, view: ViewState): void {
        if (this.disposed || !this.isCurrent()) return;
        const input = this.demand(view);
        const { stack, rasterScale } = input;
        const texture = this.frameTexture;
        const current = contentFamily(input) === this.contentIdentity;
        if (texture && texture.device === this.host.device()) {
            // One batch in the paint order of the per-quad calls it replaces: each page's border, then its paper.
            const paper = this.paper;
            paper.reset();
            for (const index of this.visiblePageIndices(input)) {
                const page = stack.rects[index];
                const destination = projectInto(page, page, view, this.paperRect);
                paper.add({ x: 0, y: 0, width: 1, height: 1 },
                    { x: destination.x - 1, y: destination.y - 1, width: destination.width + 2, height: destination.height + 2 });
                paper.add({ x: 1, y: 0, width: 1, height: 1 }, destination);
                if (current) this.notePaper(stack, index);
            }
            paper.drawAll(quads => this.host.drawTexturedQuads(pass, texture.handle, quads, { opacity: 1, sampling: 'nearest' }));
        }
        for (const item of this.currentBridge(view)) {
            const texture = this.bridgeTextures.get(item.entry.id);
            const snapshot = this.mirror?.view(view);
            if (!texture || texture.device !== this.host.device() || !snapshot) continue;
            const quad = this.mirror!.store.mirrorQuad(item, snapshot);
            // The bridge's mirror is a stand-in for the page, never this view's own pixels.
            auditDrawn('stand-in');
            this.host.drawTexturedQuad(pass, texture.handle, quad.sourceRect, quad.destRect, { opacity: 1, sampling: 'linear',
                ...(__BME_BENCH__ ? { coverage: 'standin' as const, standInRatio: item.pixels.source.width / item.pixels.world.width / rasterScale } : {}) });
        }
        for (const entry of this.drawable(view, current)) {
            if (!entry.texture || entry.texture.device !== this.host.device()) continue;
            const { source, destination } = this.quad(entry.request, stack.rects[entry.request.page], view);
            if (entry.request.scale.scale !== rasterScale) auditDrawn('stand-in');
            this.host.drawTexturedQuad(pass, entry.texture.handle, source, destination,
                { opacity: 1, sampling: 'linear', ...(__BME_BENCH__ ? {
                    coverage: entry.request.scale.scale === rasterScale ? 'current' as const : 'standin' as const,
                    standInRatio: entry.request.scale.scale / rasterScale,
                } : {}) });
        }
    }

    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        if (this.disposed || !this.isCurrent()) return;
        const input = this.demand(view);
        const { stack, rasterScale } = input;
        const current = contentFamily(input) === this.contentIdentity;
        for (const index of this.visiblePageIndices(input)) {
            const page = stack.rects[index];
            const box = project(page, page, view);
            ctx.fillStyle = '#bebebe'; ctx.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
            ctx.fillStyle = '#fff'; ctx.fillRect(box.x, box.y, box.width, box.height);
            if (current) this.notePaper(stack, index);
        }
        for (const item of this.currentBridge(view)) {
            const snapshot = this.mirror?.view(view);
            if (!snapshot || !this.bridgeReady.has(item.entry.id)) continue;
            const quad = this.mirror!.store.mirrorQuad(item, snapshot);
            // The bridge's mirror is a stand-in for the page, never this view's own pixels.
            auditDrawn('stand-in');
            this.host.drawTexturedQuad(ctx, item.pixels.bitmap, quad.sourceRect, quad.destRect, { opacity: 1, sampling: 'linear',
                ...(__BME_BENCH__ ? { coverage: 'standin' as const, standInRatio: item.pixels.source.width / item.pixels.world.width / rasterScale } : {}) });
        }
        for (const entry of this.drawable(view, current)) {
            if (!entry.bitmap) continue;
            const { source, destination } = this.quad(entry.request, stack.rects[entry.request.page], view);
            if (entry.request.scale.scale !== rasterScale) auditDrawn('stand-in');
            this.host.drawTexturedQuad(ctx, entry.bitmap, source, destination,
                { opacity: 1, sampling: 'linear', ...(__BME_BENCH__ ? {
                    coverage: entry.request.scale.scale === rasterScale ? 'current' as const : 'standin' as const,
                    standInRatio: entry.request.scale.scale / rasterScale,
                } : {}) });
            consumePdfTileArrival(entry.bitmap);
        }
    }

    /** The world rects of the pages painted at least once at the current source and layout, in page order. Empty until a
     * draw paints a page, and empty again after a source change, a layout change, a releaseGpu or dispose. */
    drawnPageRects(): readonly Rect[] {
        if (!this.drawnStack || this.drawnStack !== this.latestDemand?.stack) return [];
        return [...this.drawnPages].sort((a, b) => a[0] - b[0]).map(([, rect]) => rect);
    }

    /** Every page texture goes, now. The platform's partial relief (`evictGpu`) runs first under pressure; what it did not
     * free is released whole here, so a releaseGpu never leaves a tile's texture behind (owner's rule). */
    releaseGpu(reason: GpuReleaseReason): void {
        this.drawnPages.clear();
        this.drawnStack = null;
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
        this.coverCache = null;
        this.texturePool.clear(reason === 'context-lost');
        this.pendingFrame = false;
        if (reason === 'hidden') this.hide();
    }

    /**
     * A refused texture first gives back this layer's own off-plan and off-view textures, then retries once. The
     * pane's grant reclaim never asks the requesting cache, so when this layer's stand-ins filled the grant nothing
     * else could make room (measured: an image-page PDF's visible tile refused for good after find).
     */
    private acquireTexture(device: GfxDevice, width: number, height: number): PooledTexture | null {
        const texture = this.texturePool.acquire(device, width, height);
        if (texture || !this.releaseUnneededGpu(true)) return texture;
        auditCount('pdf-page', 'self-reclaim');
        return this.texturePool.acquire(device, width, height);
    }

    /**
     * Pool pressure takes what the view does not show first: off-plan and off-screen tiles. Releasing every texture
     * for it meant re-rastering the visible page, since a GPU-resident tile has no bitmap left (measured: a window
     * resize re-rastered 28 tiles). Returns false when nothing was spare, so the caller releases everything.
     * `keepPool` is the refused-acquire path: it frees this layer's own entries, but leaves the pool's textures for the
     * retry to reuse. By reading: clearing the pool there destroyed the exact-size textures a zoom step needs next, so
     * every refused upload during a zoom forced a fresh createTexture for the tiles that had just been released.
     */
    /** Partial relief the platform asks for before it releases the whole layer: the pool's free textures first, then this
     * layer's textures the plan does not show, least recently used first. Only a tile whose pixels are still on the CPU
     * qualifies, since a texture without its bitmap would turn into a raster when it returns. It acts only for the frame
     * this layer prepared: for any other frame the plan does not say what is on screen, so nothing is freed. */
    evictGpu(bytes: number, frameId: number): number {
        const input = this.latestDemand;
        if (this.disposed || !input || frameId !== this.preparedFrame) return 0;
        let freed = 0;
        const pooled = this.texturePool.memory();
        if (pooled > 0) {
            this.texturePool.clear(false);
            freed += pooled;
        }
        const candidates = [...this.entries].filter(([key, entry]) => entry.texture && entry.bitmap &&
            !(this.desired.has(key) && intersects(rect(entry.request), input.viewport)))
            .sort((a, b) => a[1].used - b[1].used);
        for (const [, entry] of candidates) {
            if (freed >= bytes) break;
            const texture = entry.texture;
            if (!texture) continue;
            texture.device.destroy(texture.handle);
            freed += texture.bytes;
            entry.texture = undefined;
            this.coverCache = null;
            auditCount('pdf-page', 'evict-gpu');
        }
        return freed;
    }

    private releaseUnneededGpu(keepPool = false): boolean {
        const input = this.latestDemand;
        if (!input) return false;
        let freed = false;
        for (const [key, entry] of this.entries) {
            if (!entry.texture || this.desired.has(key) && intersects(rect(entry.request), input.viewport)) continue;
            auditCount('pdf-page', 'pressure-evict');
            this.remove(key, entry);
            freed = true;
        }
        if (keepPool) return freed;
        freed = this.texturePool.memory() > 0 || freed;
        this.texturePool.clear(false);
        return freed;
    }

    /**
     * The governor's CPU reclaim. Without it a full pool refused every new tile for good, since nothing freed the old
     * ones (measured: a 40% zoom-out of a long annotated PDF held 28.1 MB of bitmaps for an 11.9 MB view, refused 780
     * tiles and froze on the pre-zoom picture). Off-view tiles go first, then other scales, then the least recently
     * used; the current plan's visible tiles are kept, since they are what the next frame draws.
     */
    cpuEvict(bytes: number): void {
        const viewport = this.latestDemand?.viewport;
        const exact = this.latestDemand && planPdfTileDemand({ ...this.latestDemand, moving: false, covered: () => false })
            .requests.find(request => request.level === 'exact')?.scale.scale;
        const rank = (entry: Entry): number => !viewport || !intersects(rect(entry.request), viewport) ? 0
            : entry.request.scale.scale !== exact ? 1 : 2;
        const candidates = [...this.entries].filter(([key, entry]) => entry.bitmap &&
            !(this.desired.has(key) && viewport && intersects(rect(entry.request), viewport)))
            .sort((a, b) => rank(a[1]) - rank(b[1]) || a[1].used - b[1].used);
        let freed = 0;
        for (const [key, entry] of candidates) {
            if (freed >= bytes) break;
            freed += entry.lease?.bytes ?? 0;
            this.remove(key, entry);
        }
        if (freed) this.host.invalidate('pdf-tile-evicted');
    }

    /**
     * Critical only while the view has page area no tile covers. A page layer that called itself critical for good
     * kept every pane's criticalPending true, so an optional layer never got the one-tile progress grant: on a webgl2
     * PDF with the frame allowance near zero the ink board's 1 MB tile was refused on every frame after a drag, the
     * board never presented again and the moved strokes stayed hidden (measured: 366 refusals in 6 s, cp=true).
     */
    critical(view: ViewState): boolean {
        if (this.criticalMemo?.view === view && this.criticalMemo.revision === this.contentRevision) return this.criticalMemo.value;
        const value = !this.coverage(view, !!this.host.device()).complete;
        this.criticalMemo = { view, revision: this.contentRevision, value };
        return value;
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
            const key = request.text;
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
            cpuBytes += entry.lease?.bytes ?? 0;
            if (entry.texture) gpuBytes += entry.texture.bytes;
        }
        for (const entry of this.retiring) cpuBytes += entry.lease?.bytes ?? 0;
        return { gpuBytes, cpuBytes };
    }
    revision(): number { return this.contentRevision; }
    needsFrame(): boolean { return this.pendingFrame; }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.mirrorJob = null;
        this.hide();
        this.failed.clear();
        this.drawnPages.clear();
        this.drawnStack = null;
    }

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
            if (!device) {
                if (!budget.claimUpload(bitmap.width * bitmap.height * 4)) { this.pendingFrame = true; break; }
                this.bridgeReady.add(item.entry.id); continue;
            }
            const texture = this.acquireTexture(device, bitmap.width, bitmap.height);
            if (!texture) { this.awaitGpuCapacity(bitmap.width * bitmap.height * 4); break; }
            if (!budget.claimUpload(bitmap.width * bitmap.height * 4)) { this.texturePool.release(texture); this.pendingFrame = true; break; }
            try {
                device.writeTexture(texture.handle, { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
                    { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                this.bridgeTextures.set(item.entry.id, texture);
            } catch (error) { device.destroy(texture.handle); throw error; }
        }
    }

    private mirrorJobCurrent(job: MirrorJob): boolean {
        if (this.disposed || !this.isCurrent() || !this.latestView || !this.mirror) return false;
        const current = this.mirror.view(this.latestView);
        if (!current || mirrorViewKey(current) !== job.key) return false;
        const input = this.demand(this.latestView), token = renderTokenKey(input.token);
        const docKey = pdfDocKey({ ...input.token, source: input.source });
        if (renderTokenKey(current.token) !== token || current.sourceRole !== input.source ||
            current.geometryDigest !== input.geometryDigest || current.colourVersion !== 0 ||
            getPdfFontEpoch(docKey) !== (input.fontEpoch ?? 0) ||
            !current.contentRevision.startsWith(pdfMirrorProfilePrefix(input.variant, docKey))) return false;
        return job.entries.every(({ request }) => request.key.documentToken === token && request.key.sourceRole === input.source &&
            request.key.colourVersion === current.colourVersion && request.key.contentRevision === pdfVariantRevision(
                input.variant === 'plain' ? 'plain' : input.pageVariant?.(request.page) ?? input.variant, input.fontEpoch ?? 0));
    }

    /** A refused texture wakes the layer when the governor would admit its bytes. Without this a visible tile waited for
     * some unrelated frame: nothing requested another prepare after the refusal (by reading). */
    private awaitGpuCapacity(bytes: number): void {
        const allocator = this.host.allocator.gpu;
        if (this.awaitingGpu || !allocator.whenAvailable) return;
        this.awaitingGpu = true;
        allocator.whenAvailable(() => { this.awaitingGpu = false; this.host.invalidate('pdf-gpu-capacity'); }, bytes);
    }

    private awaitCpuCapacity(bytes: number): void {
        const allocator = this.host.allocator.cpu;
        if (this.awaitingCpu || !allocator.whenAvailable) return;
        this.awaitingCpu = true;
        allocator.whenAvailable(() => { this.awaitingCpu = false; this.host.invalidate('pdf-cpu-capacity'); }, bytes);
    }

    /** The held crop of this tile version, or null when none is held (or the pixels were released). */
    private heldMirrorId(entry: Entry | undefined, view: MirrorView): string | null {
        if (!entry || !this.mirror) return null;
        const id = this.mirrorIds.get(mirrorVersionKey(view, entry.request));
        return id && this.mirror.store.holds(id) ? id : null;
    }

    private mirrorHeld(entry: Entry | undefined, view: MirrorView): boolean {
        return this.heldMirrorId(entry, view) !== null;
    }

    /** Entries whose crop is still held are taken in order, with no copy, before the next crop starts. */
    private reuseHeldMirrors(job: MirrorJob): void {
        while (job.index < job.entries.length) {
            const entry = job.entries[job.index];
            const id = this.heldMirrorId(entry, job.view);
            if (!id) return;
            job.ids.push(id);
            if (entry.request.level === 'low') job.lowIds.add(id);
            job.index++;
        }
    }

    /** Drops versions whose crops the session no longer holds. */
    private pruneMirrorIds(): void {
        for (const [version, id] of this.mirrorIds) {
            if (!this.mirror?.store.holds(id)) this.mirrorIds.delete(version);
        }
    }

    private prepareMirror(view: ViewState, input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>,
        requests: readonly PdfTileRequest[], budget: FrameBudget): void {
        const mirror = this.mirror;
        const snapshot = mirror?.view(view);
        if (!mirror || !snapshot || input.moving || this.disposed) { this.mirrorJob = null; return; }
        const key = mirrorViewKey(snapshot);
        if (key === this.mirrorKey) return;
        if (this.mirrorJob?.key !== key) {
            const exact = requests.filter(request => request.level === 'exact' && intersects(rect(request), input.viewport));
            const entries = exact.map(request => this.entries.get(request.text));
            if (!entries.length || entries.some(entry => !entry?.settled)) { this.mirrorJob = null; return; }
            if (entries.some(entry => !entry?.bitmap && !this.mirrorHeld(entry, snapshot))) {
                // The 2D mirror is the hidden/rebind stand-in, never this view's pixels; re-rastering to refresh it would
                // cost more than a slightly older stand-in, which the cover already treats as non-current.
                if (this.mirrorSkipped !== key) auditCount('pdf-page', 'fallback:mirror-kept-older');
                this.mirrorSkipped = key; this.mirrorJob = null; return;
            }
            const low = requests.filter(request => request.level === 'low' && intersects(rect(request), input.viewport))
                .map(request => this.entries.get(request.text))
                .filter((entry): entry is Entry => !!entry?.bitmap);
            this.mirrorJob = { key, view: snapshot, entries: [...low, ...entries as Entry[]], ids: [],
                lowIds: new Set(), index: 0, pending: false };
        }
        const job = this.mirrorJob;
        if (!job || job.pending || budget.shouldYield()) return;
        if (!this.mirrorJobCurrent(job)) { this.mirrorJob = null; return; }
        this.reuseHeldMirrors(job);
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
        if (!bitmap || this.entries.get(entry.request.text) !== entry) { this.mirrorJob = null; return; }
        // The whole tile, not the part the view shows: the copy then belongs to the tile version and serves every view
        // that shows it (by reading: the per-view crop was copied again for each view). The destination rectangle places it.
        const bounds = rect(entry.request);
        const left = bounds.x, top = bounds.y, right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
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
            if (this.mirrorJob !== job || !this.mirrorJobCurrent(job)) {
                copy.close(); this.host.allocator.cpu.release(lease); return;
            }
            const world = { x: left, y: top, width: right - left, height: bottom - top };
            const page = input.stack.rects[entry.request.page];
            const source = { x: 1 + (left - edges.left) * scale - sx, y: 1 + (top - edges.top) * scale - sy,
                width: world.width * scale, height: world.height * scale };
            let id: string | null;
            try {
                id = mirror.store.publish({ token: job.view.token, key: { ...entry.request.key, contentRevision: job.view.contentRevision },
                    geometryDigest: job.view.geometryDigest, tier: entry.request.level === 'low' ? 'low' : 'exact', neededByCurrentFrame: true,
                    pixels: { bitmap: copy, world, source, page }, lease });
            } catch (error) {
                copy.close(); this.host.allocator.cpu.release(lease); this.mirrorJob = null;
                this.onError(error, entry.request); return;
            }
            if (!id) { copy.close(); this.host.allocator.cpu.release(lease); this.mirrorJob = null; return; }
            job.ids.push(id);
            if (entry.request.level === 'low') job.lowIds.add(id);
            this.mirrorIds.set(mirrorVersionKey(job.view, entry.request), id);
            if (this.mirrorIds.size > MIRROR_VERSION_LIMIT) this.pruneMirrorIds();
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
        const own = this.coverBoxes(device).get(page) ?? NO_BOXES;
        return covers(area, additional.length ? [...additional, ...own] : own);
    }

    /** The drawable tiles of the current plan, by page: what a stand-in must wait for before it may go. */
    private drawablePlanBoxes(device: GfxDevice | null): Map<number, Readonly<Rect>[]> {
        const boxes = new Map<number, Readonly<Rect>[]>();
        for (const [key, entry] of this.entries) {
            if (!this.desired.has(key) || !drawableOn(entry, device) || (device && entry.texture?.device !== device)) continue;
            const list = boxes.get(entry.request.page) ?? [];
            list.push(rect(entry.request));
            boxes.set(entry.request.page, list);
        }
        return boxes;
    }

    private coverBoxes(device: GfxDevice | null): ReadonlyMap<number, readonly Readonly<Rect>[]> {
        const cached = this.coverCache;
        if (cached && cached.device === device) return cached.boxes;
        const boxes = new Map<number, Readonly<Rect>[]>();
        for (const entry of this.entries.values()) {
            if (!drawableOn(entry, device) || (device && entry.texture?.device !== device)) continue;
            const list = boxes.get(entry.request.page) ?? [];
            list.push(rect(entry.request));
            boxes.set(entry.request.page, list);
        }
        this.coverCache = { device, boxes };
        return boxes;
    }

    private visiblePageIndices(input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>): readonly number[] {
        const result: number[] = [];
        for (let index = Math.max(0, pageAt(input.stack, input.viewport.y)); index < input.stack.rects.length; index++) {
            const page = input.stack.rects[index];
            if (page.y >= input.viewport.y + input.viewport.height) break;
            if (intersects(page, input.viewport)) result.push(index);
        }
        return result;
    }

    /** A visible page's paper went down at the current source. A new stack object is a new layout: its old record is dropped. */
    private notePaper(stack: Readonly<PageStack>, index: number): void {
        if (this.drawnStack !== stack) {
            this.drawnPages.clear();
            this.drawnStack = stack;
        }
        if (this.drawnPages.has(index)) return;
        const page = stack.rects[index];
        this.drawnPages.set(index, Object.freeze({ x: page.x, y: page.y, width: page.width, height: page.height }));
    }

    /** `current` is the caller's own check that the frame's content identity is the one entries were planned for. */
    private drawable(view: ViewState, current: boolean): Entry[] {
        if (!current) return [];
        const viewport = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
        return [...this.entries.values()].filter(entry => entry.settled && intersects(rect(entry.request), viewport))
            .sort((a, b) => a.request.scale.scale - b.request.scale.scale || a.used - b.used);
    }

    /** The tile's source and destination, written into one reused pair: drawTexturedQuad consumes them before it returns. */
    private quad(request: PdfTileRequest, page: Readonly<Rect>, view: ViewState): { source: Rect; destination: Rect } {
        const bounds = rect(request), edges = request.tile.edges, scale = request.scale.scale, out = this.tileQuad;
        out.source.x = 1 + (bounds.x - edges.left) * scale;
        out.source.y = 1 + (bounds.y - edges.top) * scale;
        out.source.width = bounds.width * scale;
        out.source.height = bounds.height * scale;
        projectInto(bounds, page, view, out.destination);
        return out;
    }

    private evictUnneeded(viewport: Readonly<Rect>, neededBytes: number): void {
        const candidates = this.entries.evictable(this.desired, viewport, entry => rect(entry.request), entry => !!entry.bitmap);
        candidates.sort((a, b) => Number(a[1].request.level === 'low') - Number(b[1].request.level === 'low') ||
            a[1].used - b[1].used);
        let freed = 0;
        for (const [key, entry] of candidates) {
            freed += entry.lease?.bytes ?? 0;
            this.remove(key, entry);
            if (freed >= neededBytes) break;
        }
    }

    private remove(key: string, entry: Entry): void {
        this.coverCache = null;
        if (this.entries.get(key) !== entry) return;
        this.entries.delete(key);
        entry.controller.abort();
        if (entry.texture) this.texturePool.release(entry.texture);
        if (entry.settled) {
            this.contentRevision++;
            if (entry.bitmap) { forgetPdfTileArrival(entry.bitmap); entry.bitmap.close(); }
            if (entry.lease) this.host.allocator.cpu.release(entry.lease);
        } else {
            // Cancellation is best effort: the transferred bitmap and its CPU
            // reservation remain owned until the producer actually settles.
            this.retiring.add(entry);
        }
    }

    private finishRetiring(entry: Entry): void {
        if (!this.retiring.delete(entry)) return;
        if (entry.lease) this.host.allocator.cpu.release(entry.lease);
    }
}
