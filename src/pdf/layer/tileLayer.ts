import { pageAt, pagePresentation, renderTokenKey } from '../../platform/render';
import type { ByteLease, FrameBudget, GfxDevice, GpuPass, GpuReleaseReason, Layer, LayerHost, MirrorView, PageStack, Rect, TextureHandle, ViewState } from '../../platform/render';
import type { PdfMirrorPixels, PdfSessionMirrors } from './tileMirror';
import type { PdfVersionBridge } from './versionBridge';
import type { BorrowedMirror } from '../../platform/render';
import { covers, intersects } from './coverage';
import { PdfTileCache } from './tileCache';
import { createTileTexture, PdfTexturePool, type PooledTexture } from './texturePool';
import { planPdfTileDemand } from './tileDemand';
import type { PdfDemandInput, PdfTileRequest } from './tileDemand';
import { getPdfFontEpoch, pdfMirrorProfilePrefix, pdfVariantRevision } from '../fonts/profiles';
import { pdfDocKey } from '../worker/protocol';
import { consumePdfTileArrival, forgetPdfTileArrival } from '../pool/arrivalWindow';
import { auditCount, auditDrawn, auditTape, renderAuditEnabled } from '../../platform/render/renderAudit';
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
    /** Where the pixels live on the GPU: the tile's own texture, sized to its bitmap. */
    texture?: PooledTexture;
    /** The last prepared frame that drew this tile: its pixels are never a trim's to take while that frame is the last one. */
    drawnFrame?: number;
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

/** A tile or mirror drawn at a scale other than the frame's is a stand-in. The two scales are computed separately, so one zoom can
 * differ in its last float bits (1.4379084967320261 vs ...255): a relative tolerance, as the supersession check uses, not equality. */
/** A small stable number per object, for the picture key (see PdfTileLayer.pictureKey); a string id hashes as its characters. */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identityOf(value: object | string): number {
    if (typeof value === 'string') { let hash = 7; for (let i = 0; i < value.length; i++) hash = Math.imul(hash, 31) + value.charCodeAt(i) | 0; return hash >>> 0; }
    let id = identities.get(value);
    if (id === undefined) { id = nextIdentity++; identities.set(value, id); }
    return id;
}
function scaleDiffers(scale: number, frame: number): boolean { return Math.abs(scale / frame - 1) > 1e-6; }

/** One quad of the frame in device pixels: whether it is a stand-in. Collected only while the render audit is on. */
interface QuadMark { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly stand: boolean }
/** Device-pixel overlaps under this are rounding slivers of two abutting tiles, not gaps. */
const SLIVER = 1e-6;
/** Past this many pieces the uncovered test answers "uncovered": the conservative answer for a page of many odd tiles. */
const PIECE_LIMIT = 64;

/** True when some part of `area` is outside every rect of `cover`. Each cover rect cuts the pieces it overlaps. */
function leavesUncovered(area: Readonly<Rect>, cover: readonly Readonly<Rect>[]): boolean {
    let pieces: Rect[] = [{ x: area.x, y: area.y, width: area.width, height: area.height }];
    for (const c of cover) {
        const next: Rect[] = [];
        for (const p of pieces) {
            const right = p.x + p.width, bottom = p.y + p.height;
            const x0 = Math.max(p.x, c.x), y0 = Math.max(p.y, c.y);
            const x1 = Math.min(right, c.x + c.width), y1 = Math.min(bottom, c.y + c.height);
            if (x1 - x0 <= SLIVER || y1 - y0 <= SLIVER) { next.push(p); continue; }
            if (y0 - p.y > SLIVER) next.push({ x: p.x, y: p.y, width: p.width, height: y0 - p.y });
            if (bottom - y1 > SLIVER) next.push({ x: p.x, y: y1, width: p.width, height: bottom - y1 });
            if (x0 - p.x > SLIVER) next.push({ x: p.x, y: y0, width: x0 - p.x, height: y1 - y0 });
            if (right - x1 > SLIVER) next.push({ x: x1, y: y0, width: right - x1, height: y1 - y0 });
        }
        pieces = next;
        if (!pieces.length) return false;
        if (pieces.length > PIECE_LIMIT) return true;
    }
    return pieces.length > 0;
}

/** The largest tile texture: the 512 interior plus the one-texel gutter on each side. */
const TILE_EDGE = 514;

/** One display frame: a zoom-held tile's start is due the frame after the scale stops changing (a wake, not a frame request per frame). */
const ZOOM_REST_MS = 17;

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
    /** Bridge items whose upload the device refused: not retried per frame; cleared with `failed` (identity change, retry). */
    private readonly bridgeFailed = new Set<string>();
    /** Settled entries in draw order (scale ascending), rebuilt only when the settled set changes. */
    private settledOrder: Entry[] | null = null;
    private readonly drawScratch: Entry[] = [];
    private readonly pageScratch: number[] = [];
    private readonly retiring = new Set<Entry>();
    private readonly texturePool: PdfTexturePool;
    /** Bytes of the tiles' own textures, kept as they are created and destroyed. */
    private tileBytes = 0;
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
    /** The raster scale the previous prepare planned for: a zoom is a prepare whose scale differs from it. */
    private lastRasterScale = 0;
    /** Bumped by every change to what the layer draws (tiles, bridge items, the frame texture, the content). prepare answers
     * unchanged only while this has not moved since the frame it last answered changed for (see answer). */
    private drawVersion = 0;
    private presented = { version: -1, view: '', picture: 0 };
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
    /** The frame's quads, in device pixels, while the render audit is on: the stand-ins the audit counts are the ones no exact tile covers. */
    private standInMarks: QuadMark[] | null = null;
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
        private readonly onError: (error: unknown, request: PdfTileRequest | null) => void,
        private readonly mirror?: PdfLayerMirror, private readonly bridge?: PdfVersionBridge | null) {
        if (__BME_BENCH__) this.benchmarkRaster = true;
        this.texturePool = new PdfTexturePool(host.allocator.gpu);
    }

    prepare(view: ViewState, budget: FrameBudget): boolean {
        this.pendingFrame = false;
        this.framePlan = null;
        this.preparedFrame = budget.frameId;
        if (this.disposed || !this.isCurrent()) return true;
        const device = this.host.device();
        if (device && this.frameTexture?.device !== device) {
            this.drawVersion++;
            if (this.frameTexture) { this.frameTexture.device.destroy(this.frameTexture.handle); this.frameTexture = null; }
            if (budget.shouldYield()) { this.pendingFrame = true; return true; }
            // Storage before budget: a claim spent on a refused reservation starves the next upload (see uploadTile).
            const lease = this.host.allocator.gpu.reserve(8);
            if (!lease) this.awaitGpuCapacity(8);
            else if (!budget.claimUpload(8)) { this.host.allocator.gpu.release(lease); this.pendingFrame = true; return true; }
            else {
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
        // Pages of another device hold tiles no backend can draw: they go, and their owners are re-uploaded.
        if (device) this.dropForeignTiles(device);
        const input = this.demand(view);
        this.latestDemand = input;
        this.latestView = view;
        const identity = contentFamily(input);
        if (identity !== this.contentIdentity) {
            this.drawVersion++;
            this.mirrorJob = null;
            for (const [key, entry] of this.entries) this.remove(key, entry);
            this.failed.clear();
            this.bridgeFailed.clear();
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
        // A zoom is a frame whose raster scale differs from the previous frame's. On the GPU a tile a stand-in covers is
        // not started in such a frame: the stand-in is scaled from the nearest cached size meanwhile, and a raster started
        // there finishes after the scale has moved on and is thrown away. The first frame the scale rests starts it, so a
        // rest costs one frame, not a settle time (a 150 ms hold here doubled the time to exact against canvas2d).
        const zooming = !!device && this.lastRasterScale !== 0 && Math.abs(input.rasterScale / this.lastRasterScale - 1) > 1e-6;
        this.lastRasterScale = input.rasterScale;
        // A spare page is kept only for a zoom that is still changing: at rest it is 4 MB of empty texture.
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
        // A landed visible exact tile goes up before anything else in the frame. Until it does, a stand-in shows in its place,
        // and the plan's low previews and speculative tiles come first in the loop below, so they took the frame's one
        // progress grant ahead of it. Prefetch and low previews still upload in the loop, with whatever allowance is left.
        if (device) {
            for (const request of planned.requests) {
                if (request.level !== 'exact' || request.priority === 'prefetch') continue;
                const landed = this.entries.get(request.text);
                if (!landed?.bitmap || landed.texture?.device === device || this.failed.has(request.text)) continue;
                if (budget.shouldYield()) { this.pendingFrame = true; break; }
                if (this.uploadTile(device, request.text, landed, budget) === 'budget') { this.pendingFrame = true; break; }
            }
        }
        let running = [...this.entries.values()].filter(entry => !entry.settled).length;
        let zoomHeld = false;
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
                if (device && existing.bitmap && existing.texture?.device !== device && !this.failed.has(key)) {
                    if (budget.shouldYield()) { this.pendingFrame = true; break; }
                    // Storage before budget: a claim whose texture was then refused still spent the frame's upload
                    // allowance, so the next tile never fit it, frame after frame, and the page stayed blurred.
                    if (this.uploadTile(device, key, existing, budget) === 'budget') break;
                }
                continue;
            }
            if (this.failed.has(key) || running >= 3) continue;
            // Held for the frame the scale rests; pendingFrame keeps the next frame coming so the rest is not missed.
            // Held without asking for a frame: the frame that starts it is the wake armed below, one frame after the scale stops changing.
            if (zooming && this.covered(request.page, rect(request), device)) { auditCount('pdf-page', 'zoom-deferred'); zoomHeld = true; continue; }
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
                this.drawVersion++;
                this.settledOrder = null;
                this.coverCache = null;
                auditCount('pdf-page', 'cpu-raster', 1, { px: bitmap.width * bitmap.height });
                this.contentRevision++;
                // A tile that landed off screen changes nothing on screen: the camera's next move presents it.
                if (this.onScreen(entry.request)) this.host.invalidate('pdf-tile-arrived');
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
        if (zoomHeld) this.host.wakeAt(performance.now() + ZOOM_REST_MS);
        this.prepareMirror(view, input, planned.requests, budget);
        if (device) this.releaseUploadedBitmaps(view, input.viewport, device);
        return this.answer(view, budget);
    }

    /** The answer prepare gives the scheduler (see Layer.prepare): false only when this prepare ran to completion and nothing
     * the layer draws differs from what it last presented, so a continuation frame may skip encode and present. A prepare
     * that a budget or deadline cut short is changed; so is any change to the view the picture is drawn at. */
    private answer(view: ViewState, budget: FrameBudget): boolean {
        const shown = `${budget.cameraEpoch}|${view.camera.x}|${view.camera.y}|${view.camera.z}|${view.viewport.width}|${view.viewport.height}|${view.viewport.dpr}`;
        // What the next draw lays, by identity: the tiles it draws with their pixels (texture on a device, bitmap on 2D), the bridge
        // pictures and the paper. The draw version also moves for work nothing draws (a tile started, evicted off the view, or uploaded
        // where an exact tile already covers it), and answering changed on it presented the same picture: measured on doc12, the wake
        // frame of every paced zoom step (37 of 117 zoom presents redundant). The version still decides when the picture is unknown.
        const picture = this.pictureKey(view);
        if (this.presented.view === shown && (picture !== 0 ? picture === this.presented.picture
            : !this.pendingFrame && this.presented.version === this.drawVersion)) {
            auditCount('pdf-page', 'prepare-unchanged');
            return false;
        }
        this.presented = { version: this.drawVersion, view: shown, picture };
        return true;
    }

    /** A hash of what drawGpu or draw2d lays for this view, allocation-free; 0 when it cannot be told (no current content). */
    private pictureKey(view: ViewState): number {
        const input = this.latestDemand;
        if (!input || this.latestView !== view) return 0;
        const current = contentFamily(input) === this.contentIdentity;
        if (!current) return 0;
        const device = this.host.device();
        let hash = 0x811c9dc5;
        const mix = (value: number): void => { hash = Math.imul(hash ^ value, 0x01000193) >>> 0; };
        mix(device && this.frameTexture?.device === device ? identityOf(this.frameTexture.handle) : 1);
        if (device) { for (const texture of this.bridgeTextures.values()) if (texture.device === device) mix(identityOf(texture.handle)); }
        else for (const id of this.bridgeReady) mix(identityOf(id));
        for (const entry of this.drawable(view, current, !!device)) {
            const pixels = device ? entry.texture?.device === device ? entry.texture.handle : null : entry.bitmap ?? null;
            mix(pixels ? identityOf(pixels) : 2);
            const key = entry.request.text;
            for (let i = 0; i < key.length; i++) mix(key.charCodeAt(i));
        }
        return hash || 1;
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
        this.standInMarks = renderAuditEnabled() ? [] : null;
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
            this.markQuad(quad.destRect, scaleDiffers(item.pixels.source.width / item.pixels.world.width, rasterScale));
            this.host.drawTexturedQuad(pass, texture.handle, quad.sourceRect, quad.destRect, { opacity: 1, sampling: 'linear',
                ...(__BME_BENCH__ ? { coverage: 'standin' as const, standInRatio: item.pixels.source.width / item.pixels.world.width / rasterScale } : {}) });
        }
        const device = this.host.device();
        const tiles = this.drawable(view, current, true);
        for (const entry of tiles) entry.drawnFrame = this.preparedFrame;
        // Scale order is kept between groups, since different scales overlap; same-scale tiles are batched by page.
        let start = 0;
        while (start < tiles.length) {
            const scale = tiles[start].request.scale.scale;
            let end = start + 1;
            while (end < tiles.length && tiles[end].request.scale.scale === scale) end++;
            this.drawTileGroup(pass, tiles, start, end, stack, rasterScale, view, device);
            start = end;
        }
        this.countStandIns(view);
    }

    /** Whether a tile lies in the viewport prepare last planned for: only such a tile changes what is on screen. */
    private onScreen(request: PdfTileRequest): boolean {
        const demand = this.latestDemand;
        return !!demand && intersects(rect(request), demand.viewport);
    }

    /** Records one drawn quad for the stand-in count. A no-op unless the audit is on. */
    private markQuad(destination: Readonly<Rect>, stand: boolean): void {
        this.standInMarks?.push({ x: destination.x, y: destination.y, width: destination.width, height: destination.height, stand });
    }

    /** Counts the frame's stand-ins that no exact tile covers: one drawn beneath a whole exact tile is invisible, so it is not in the
     * picture. Every stand-in here is drawn from another scale's raster, so it is counted under that origin. */
    private countStandIns(view: ViewState): void {
        const marks = this.standInMarks;
        this.standInMarks = null;
        if (!marks) return;
        const surface = { x: 0, y: 0, width: view.viewport.width * view.viewport.dpr, height: view.viewport.height * view.viewport.dpr };
        const cover = marks.filter(mark => !mark.stand);
        for (const mark of marks) {
            if (!mark.stand) continue;
            const area = clipped(mark, surface);
            if (area && leavesUncovered(area, cover)) auditDrawn('stand-in', 1, 'raster', 'pdf-tile');
        }
    }

    /** Tiles of one scale, one draw each: a tile is its own texture. The scale fixes the benchmark classification of its tiles. */
    private drawTileGroup(pass: GpuPass, tiles: readonly Entry[], start: number, end: number, stack: Readonly<PageStack>,
        rasterScale: number, view: ViewState, device: GfxDevice | null): void {
        for (let index = start; index < end; index++) {
            const entry = tiles[index];
            const texture = entry.texture;
            if (!texture || texture.device !== device) continue;
            const { source, destination } = this.quad(entry.request, stack.rects[entry.request.page], view);
            const stand = scaleDiffers(entry.request.scale.scale, rasterScale);
            if (stand && renderAuditEnabled()) auditTape(`pdf-standin-ratio:${(entry.request.scale.scale / rasterScale).toPrecision(9)}`);
            this.markQuad(destination, stand);
            this.host.drawTexturedQuad(pass, texture.handle, source, destination, { opacity: 1, sampling: 'linear',
                ...(__BME_BENCH__ ? {
                    coverage: stand ? 'standin' as const : 'current' as const,
                    standInRatio: entry.request.scale.scale / rasterScale,
                } : {}) });
        }
    }

    draw2d(ctx: CanvasRenderingContext2D, view: ViewState): void {
        if (this.disposed || !this.isCurrent()) return;
        this.standInMarks = renderAuditEnabled() ? [] : null;
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
            this.markQuad(quad.destRect, scaleDiffers(item.pixels.source.width / item.pixels.world.width, rasterScale));
            this.host.drawTexturedQuad(ctx, item.pixels.bitmap, quad.sourceRect, quad.destRect, { opacity: 1, sampling: 'linear',
                ...(__BME_BENCH__ ? { coverage: 'standin' as const, standInRatio: item.pixels.source.width / item.pixels.world.width / rasterScale } : {}) });
        }
        for (const entry of this.drawable(view, current)) {
            if (!entry.bitmap) continue;
            const { source, destination } = this.quad(entry.request, stack.rects[entry.request.page], view);
            this.markQuad(destination, scaleDiffers(entry.request.scale.scale, rasterScale));
            this.host.drawTexturedQuad(ctx, entry.bitmap, source, destination,
                { opacity: 1, sampling: 'linear', ...(__BME_BENCH__ ? {
                    coverage: scaleDiffers(entry.request.scale.scale, rasterScale) ? 'standin' as const : 'current' as const,
                    standInRatio: entry.request.scale.scale / rasterScale,
                } : {}) });
            consumePdfTileArrival(entry.bitmap);
        }
        this.countStandIns(view);
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
        this.drawVersion++;
        this.drawnPages.clear();
        this.drawnStack = null;
        if (this.frameTexture && reason !== 'context-lost') this.frameTexture.device.destroy(this.frameTexture.handle);
        this.frameTexture = null;
        this.dropAllTiles(reason === 'context-lost');
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
        if (texture || (!this.releaseUnneededGpu(true) && !this.releaseStandinLastResort())) return texture;
        auditCount('pdf-page', 'self-reclaim');
        return this.texturePool.acquire(device, width, height);
    }

    /** The last resort for a refused exact tile: one on-view stand-in at another scale, the farthest from the view first. Taken only
     * here, on a refused acquire the layer cannot satisfy otherwise, never by the trouble's trim, and counted. Without it a pool full
     * of on-view stand-ins refused the exact tile for good on a still view (review3, gpu-h14). Not the last prepared frame's tiles. */
    private releaseStandinLastResort(): boolean {
        const input = this.latestDemand;
        if (!input) return false;
        let victim: { key: string; entry: Entry } | null = null, rank = -Infinity;
        for (const [key, entry] of this.entries) {
            if (!entry.texture || !intersects(rect(entry.request), input.viewport) || !scaleDiffers(entry.request.scale.scale, input.rasterScale) ||
                entry.drawnFrame === this.preparedFrame) continue;
            const value = this.evictionRank(entry, input);
            if (value > rank) { rank = value; victim = { key, entry }; }
        }
        if (!victim) return false;
        auditCount('pdf-page', 'standin-last-resort');
        this.remove(victim.key, victim.entry);
        return true;
    }

    /** Partial relief the platform asks for before it releases the whole layer: the pool's free textures first, then this
     * layer's tile textures the plan does not show, farthest first (evictionRank). Pool pressure takes what the view does not
     * show: releasing every texture for it meant re-rastering the visible page (measured: a window resize re-rastered 28 tiles).
     * The frame id is not read: what may go is decided tile by tile (evictableTile), so the trim works between frames too. */
    evictGpu(bytes: number, _frameId: number): number {
        const input = this.latestDemand;
        if (this.disposed || !input) return 0;
        let freed = 0;
        const pooled = this.texturePool.memory();
        if (pooled > 0) {
            this.texturePool.clear(false);
            freed += pooled;
        }
        // Off-view and other-scale tiles go first, farthest first; a tile on screen or drawn by the last prepared frame stays.
        if (freed < bytes) freed += this.evictTiles(bytes - freed, input);
        if (freed) auditCount('pdf-page', 'evict-gpu', 1, { bytes: freed });
        return freed;
    }

    /** Larger is evicted first: off the view, then another scale than the one drawn, then farther from the view's centre. */
    private evictionRank(entry: Entry, input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>): number {
        const box = rect(entry.request), view = input.viewport;
        const offView = intersects(box, view) ? 0 : 1;
        const otherScale = scaleDiffers(entry.request.scale.scale, input.rasterScale) ? 1 : 0;
        const dx = box.x + box.width / 2 - (view.x + view.width / 2), dy = box.y + box.height / 2 - (view.y + view.height / 2);
        return offView * 1e12 + otherScale * 1e9 + Math.hypot(dx, dy);
    }

    /** A tile a trim may take: its pixels are on the CPU (so it comes back by a bitmap upload, never a raster), not on the view
     * (a tile on screen is part of every frame that draws it), and not drawn by the last prepared frame. A GPU-only tile is
     * kept: freeing it would turn its return into a CPU raster, which is what evictGpu's contract rules out. */
    private evictableTile(entry: Entry, input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>): boolean {
        return !!entry.bitmap && !intersects(rect(entry.request), input.viewport) && entry.drawnFrame !== this.preparedFrame;
    }

    /** The GPU's answer to a refused tile texture: free one tile the plan does not show, then the layer's own off-plan
     * textures. Returns whether the caller may try again. */
    private reclaimTile(): boolean {
        const input = this.latestDemand;
        if (!input) return false;
        if (this.evictTiles(1, input) > 0) {
            auditCount('pdf-page', 'tile-reclaim');
            return true;
        }
        return this.releaseUnneededGpu(true) || this.releaseStandinLastResort();
    }

    /** Frees this layer's tile textures the plan does not show, for a refused texture. `keepPool` is the refused-acquire path: it
     * frees this layer's own entries but leaves the pool's textures for the retry to reuse. By reading: clearing the pool there
     * destroyed the exact-size textures a zoom step needs next, so every refused upload during a zoom forced a fresh createTexture. */
    private releaseUnneededGpu(keepPool = false): boolean {
        const input = this.latestDemand;
        if (!input) return false;
        let freed = false;
        for (const [key, entry] of this.entries) {
            // Visible need first: a texture on the view is what the next frame draws, at any scale. An other-scale one on the
            // view is the stand-in that covers a quality raise until the plan's tiles land; dropping it at the trouble's trim
            // left the raise a blank picture (measured: 102 pressure-evicts in the forced slow-gpu window, holes at the raise).
            // This runs for a refused acquire too (keepPool), so the on-view stand-ins stay here; a refused exact tile that
            // still cannot fit takes one through releaseStandinLastResort, counted.
            if (!entry.texture || intersects(rect(entry.request), input.viewport)) continue;
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
    retry(): void { this.failed.clear(); this.bridgeFailed.clear(); this.host.invalidate('pdf-tile-retry'); }

    /** Called by the pane on hide after the session has published its mirror. */
    hide(): void {
        this.mirrorJob = null;
        for (const [key, entry] of this.entries) this.remove(key, entry);
        this.desired.clear();
    }

    memory(): { gpuBytes: number; cpuBytes: number } {
        let gpuBytes = (this.frameTexture ? 8 : 0) + this.texturePool.memory() + this.tileBytes, cpuBytes = 0;
        for (const texture of this.bridgeTextures.values()) gpuBytes += texture.bytes;
        for (const entry of this.entries.values()) {
            cpuBytes += entry.lease?.bytes ?? 0;
        }
        for (const entry of this.retiring) cpuBytes += entry.lease?.bytes ?? 0;
        return { gpuBytes, cpuBytes };
    }
    revision(): number { return this.contentRevision; }
    needsFrame(): boolean { return this.pendingFrame; }
    /** Frees everything the layer holds on the GPU, not only its tiles: the frame texture, the bridge textures and the pool's
     * textures. The platform disposes a layer that leaves the topology without a releaseGpu first (paneLayerSet,
     * paneLifecycle's disposeSelection), so dispose must do this itself. A lost device owns nothing to destroy. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.mirrorJob = null;
        this.hide();
        this.failed.clear();
        this.releaseGpu(this.host.device() ? 'pressure' : 'context-lost');
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
        if (this.bridgeReady.size) this.drawVersion++;
        for (const id of this.bridgeFailed) if (!valid.has(id)) this.bridgeFailed.delete(id);
        this.bridgeReady = new Set();
        for (const [id, texture] of this.bridgeTextures) {
            if (!valid.has(id) || texture.device !== device) {
                this.drawVersion++;
                this.bridgeTextures.delete(id);
                texture.device.destroy(texture.handle);
            }
        }
        for (const item of entries) {
            if (budget.shouldYield()) { this.pendingFrame = true; break; }
            if (this.bridgeFailed.has(item.entry.id)) continue;
            const bitmap = item.pixels.bitmap;
            const existing = this.bridgeTextures.get(item.entry.id);
            if (device && existing?.device === device) continue;
            if (!device) {
                if (!budget.claimUpload(bitmap.width * bitmap.height * 4)) { this.pendingFrame = true; break; }
                this.drawVersion++; this.bridgeReady.add(item.entry.id); continue;
            }
            const texture = this.acquireTexture(device, bitmap.width, bitmap.height);
            if (!texture) { this.awaitGpuCapacity(bitmap.width * bitmap.height * 4); break; }
            if (!budget.claimUpload(bitmap.width * bitmap.height * 4)) { this.texturePool.release(texture); this.pendingFrame = true; break; }
            try {
                device.writeTexture(texture.handle, { x: 0, y: 0, width: bitmap.width, height: bitmap.height },
                    { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                this.drawVersion++;
                this.bridgeTextures.set(item.entry.id, texture);
            } catch (error) {
                // Not retried per frame: the item is marked failed and reported once, until retry() or a new identity.
                device.destroy(texture.handle);
                this.bridgeFailed.add(item.entry.id);
                auditCount('pdf-page', 'bridge-upload-failed');
                this.onError(error, null);
            }
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

    /** Uploads a settled tile's bitmap into the tile's own texture, sized to the bitmap. 'capacity' when the governor refused
     * the texture (the layer waits for it), 'budget' when this frame's upload allowance is spent (the frame stops here). */
    private uploadTile(device: GfxDevice, key: string, entry: Entry, budget: FrameBudget): 'done' | 'capacity' | 'budget' {
        const bitmap = entry.bitmap!;
        const width = bitmap.width, height = bitmap.height, bytes = width * height * 4;
        if (width > TILE_EDGE || height > TILE_EDGE) {
            this.failed.add(key);
            this.onError(new RangeError('PDF tile is larger than a tile texture'), entry.request);
            return 'done';
        }
        // A frame that cannot grant the bytes creates nothing: the texture was created and destroyed on every refused frame
        // (measured: 510 createTexture calls in one zoom phase, none uploaded). The claim below still decides.
        if (budget.upload.remainingBytes < bytes) { this.pendingFrame = true; return 'budget'; }
        const again = !!entry.texture;
        this.dropTexture(entry);
        let texture: PooledTexture | null;
        try {
            texture = createTileTexture(this.host.allocator.gpu, device, width, height);
            if (!texture && this.reclaimTile()) texture = createTileTexture(this.host.allocator.gpu, device, width, height);
        } catch (error) { this.failed.add(key); this.onError(error, entry.request); return 'done'; }
        if (!texture) { this.awaitGpuCapacity(bytes); return 'capacity'; }
        // The reclaim may have taken this very tile when it was off view (a prefetch).
        if (this.entries.get(key) !== entry || !entry.bitmap) { texture.device.destroy(texture.handle); return 'done'; }
        if (!budget.claimUpload(bytes)) { texture.device.destroy(texture.handle); this.pendingFrame = true; return 'budget'; }
        try {
            device.writeTexture(texture.handle, { x: 0, y: 0, width, height },
                { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
        } catch (error) { texture.device.destroy(texture.handle); this.failed.add(key); this.onError(error, entry.request); return 'done'; }
        entry.texture = texture;
        this.drawVersion++;
        this.tileBytes += bytes;
        this.coverCache = null;
        if (again) auditCount('pdf-page', 're-upload');
        auditCount('pdf-page', 'tile-upload', 1, { px: width * height });
        consumePdfTileArrival(bitmap);
        return 'done';
    }

    /** Destroys a tile's texture and returns its charge. The entry stays; see releaseTile for the rule on its pixels. */
    private dropTexture(entry: Entry, lost = false): void {
        const texture = entry.texture;
        if (!texture) return;
        entry.texture = undefined;
        this.drawVersion++;
        this.tileBytes -= texture.bytes;
        this.coverCache = null;
        if (!lost) texture.device.destroy(texture.handle);
    }

    /** A tile loses its texture. A settled tile with no bitmap is GPU-only: its pixels went with its texture, so it leaves the
     * layer, and the next prepare rasters it again if the plan still wants it. Kept in the map it was 'in flight' for good:
     * prepare counts it as running (three of them stopped every new raster) and never re-requests it (measured: evicted
     * off-view tiles stayed blank on pan). A tile with a bitmap stays settled and is re-uploaded. An unsettled tile has its
     * producer running, and its own callback retires it. */
    private releaseTile(entry: Entry, lost = false): void {
        this.dropTexture(entry, lost);
        if (entry.bitmap || !entry.settled) return;
        this.remove(entry.request.text, entry);
    }

    private dropAllTiles(lost: boolean): void {
        for (const entry of this.entries.values()) this.releaseTile(entry, lost);
    }

    private dropForeignTiles(device: GfxDevice): void {
        for (const entry of this.entries.values()) if (entry.texture && entry.texture.device !== device) this.releaseTile(entry);
    }

    /** Frees at least `bytes` by destroying whole tiles the rule allows, highest rank first (see evictionRank). */
    private evictTiles(bytes: number, input: Omit<PdfDemandInput, 'covered' | 'previousMotionScale'>): number {
        const candidates = [...this.entries.values()].filter(entry => entry.texture && this.evictableTile(entry, input))
            .map(entry => ({ entry, rank: this.evictionRank(entry, input) }))
            .sort((a, b) => b.rank - a.rank);
        let freed = 0;
        for (const { entry } of candidates) {
            if (freed >= bytes) break;
            const size = entry.texture!.bytes;
            this.releaseTile(entry);
            freed += size;
        }
        return freed;
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
        if (!lease) { this.awaitCpuCapacity(width * height * 4); return; }
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
            if (this.onScreen(entry.request)) this.host.invalidate('pdf-mirror-arrived');
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
        // Reused: the callers only iterate it, and it is read before the next call.
        const result = this.pageScratch;
        result.length = 0;
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
    private drawable(view: ViewState, current: boolean, exactLast = false): Entry[] {
        const out = this.drawScratch;
        out.length = 0;
        if (!current) return out;
        const viewport = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
        // Sorted by scale only, and only when the settled set changes: same-scale tiles are disjoint cells, so their order is free.
        this.settledOrder ??= [...this.entries.values()].filter(entry => entry.settled)
            .sort((a, b) => a.request.scale.scale - b.request.scale.scale);
        // Other scales first, the current raster scale last, on top: in scale order alone a higher-scale stand-in was drawn over the
        // exact tile that replaced it, so the exact upload changed nothing on screen until the stand-in was evicted (measured on doc12:
        // the wake frame of each paced zoom step pixel-identical, 31 of 111 zoom presents, and its stand-in still shown).
        // On the GPU path only: canvas2d keeps the feature branch's picture, scale order alone.
        const exact = exactLast ? this.latestDemand?.rasterScale : undefined;
        for (const entry of this.settledOrder) {
            if (intersects(rect(entry.request), viewport) && (exact === undefined || scaleDiffers(entry.request.scale.scale, exact))) out.push(entry);
        }
        if (exact !== undefined) {
            for (const entry of this.settledOrder) {
                if (intersects(rect(entry.request), viewport) && !scaleDiffers(entry.request.scale.scale, exact)) out.push(entry);
            }
        }
        return out;
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
        if (entry.settled || entry.texture) this.drawVersion++;
        this.entries.delete(key);
        entry.controller.abort();
        this.dropTexture(entry);
        if (entry.settled) {
            this.contentRevision++;
            this.settledOrder = null;
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
