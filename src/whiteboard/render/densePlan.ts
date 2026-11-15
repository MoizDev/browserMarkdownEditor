import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason } from '../../platform/render/types';
import type { Blend } from './colour';
import type { PaintBand } from './material';
import type { PaintSource, PaintImageItem, PaintItem } from './paintStream';
import type { PaintLayerResources } from './resources';
import { chooseTileScale, DENSE_TILE_PIXELS, tileRectWorld, tileScale, type TilePyramid, type TileAddress, type TileScale } from './tileHierarchy';
import type { DenseRasterBorrow, DenseRasterTicket, SessionDenseRasters } from './sessionDenseRasters';
import { createStreamingDenseTileJob, releaseDenseTilePart, type DenseTilePart, type StreamingDenseTileJob } from './streamingDenseTile';
import { ResolvedNodeCache } from './resolvedNodeCache';
import { MemoryRetryGate } from './memoryRetryGate';
import { FilteredInk } from './nodeSets';
import { createCanvasPaintAdapter, type CanvasPaintAdapter, type PreparedPaint2d, type PreparedRetain } from './reference/canvasPaintAdapter';
import { bandItemsOf, PaintWindowBuilder, refBytesOf, rootOf, windowsOfSource, type PaintRoot, type PaintWindow } from './paintWindows';
import { paintItem2d } from './reference/paint2d';

const EDGE = 512, BLOCK = 65_536;
/** One streamed tile's bitmap (its apron included): the unit a tile run reserves. */
const TILE_RUN_BYTES = 516 * 516 * 4;
/** Granularity of the direct phase's CPU reservation: the adapter grows one chunk at a time, never by a whole-set estimate. */
const DIRECT_CHUNK = 64 * 1024;
const NO_LIVE: ReadonlySet<string> = new Set();
const BANDS: readonly PaintBand[] = ['underlay', 'content'];

/** A summary: a coarse tile of the viewport's ancestry. It lives in its own cache interval, so it is only ever
 * borrowed as a standin, never served as a sharp tile. */
interface SummaryTarget { readonly band: PaintBand; readonly address: TileAddress; readonly rect: Readonly<Rect>; readonly scale: number }
const summaryInterval = (variant: string, band: PaintBand) => JSON.stringify([variant, band, 'summary']);
const bandInterval = (variant: string, band: PaintBand) => JSON.stringify([variant, band]);
const sameAddress = (a: TileAddress, b: TileAddress) => a.pyramid === b.pyramid && a.level === b.level && a.x === b.x && a.y === b.y;
/** The session bitmaps a view can draw: its variant's intervals (bands and summaries) at the view's own level, inside its
 * world rect. Anything else is residency the view cannot use, so it is the first thing a refused reservation reclaims. */
function usableBitmaps(variant: string, view: ViewState): (interval: string, address: TileAddress) => boolean {
    const demand = chooseTileScale(view.camera.z * view.viewport.dpr);
    const intervals = new Set(BANDS.flatMap(band => [bandInterval(variant, band), summaryInterval(variant, band)]));
    const left = view.camera.x, top = view.camera.y;
    const right = left + view.viewport.width / view.camera.z, bottom = top + view.viewport.height / view.camera.z;
    return (interval, address) => {
        if (!intervals.has(interval) || address.pyramid !== demand.pyramid || address.level !== demand.level) return false;
        const rect = tileRectWorld(address);
        return rect.x < right && rect.x + rect.width > left && rect.y < bottom && rect.y + rect.height > top;
    };
}

/** The finest level coarser than the viewport's at which the occupied root spans at most 2×2 tiles. The walk
 * starts one level above the viewport and only gets coarser, so the result always lies above the viewport. */
function rootFloorLevel(root: Readonly<Rect>, viewport: TileScale): number {
    for (let level = viewport.level - 1; ; level--) {
        const side = DENSE_TILE_PIXELS / tileScale(viewport.pyramid, level);
        const x0 = Math.floor(root.x / side), y0 = Math.floor(root.y / side);
        const x1 = Math.floor((root.x + root.width) / side), y1 = Math.floor((root.y + root.height) / side);
        if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Occupied root overflows the summary grid');
        if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 4) return level;
    }
}
/** A level whose whole occupied root spans at most this many tiles is session-maintained (every coarse level
 * up to it is kept for every viewport). Measured by the tile count of a full root: 16 tiles is one 4×4 grid. */
const FULL_SUMMARY_TILES = 16;
function rootTileCount(root: Readonly<Rect>, pyramid: TilePyramid, level: number): number {
    const side = DENSE_TILE_PIXELS / tileScale(pyramid, level);
    const x0 = Math.floor(root.x / side), y0 = Math.floor(root.y / side);
    const x1 = Math.floor((root.x + root.width) / side), y1 = Math.floor((root.y + root.height) / side);
    if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Occupied root overflows the summary grid');
    return (x1 - x0 + 1) * (y1 - y0 + 1);
}
/** The first level from `floor` whose whole root is no longer session-maintained; `limit` when all are. Counts grow
 * with the level, so the maintained levels are a prefix from the floor. */
function fullRootTop(root: Readonly<Rect>, pyramid: TilePyramid, floor: number, limit: number): number {
    let level = floor;
    while (level < limit && rootTileCount(root, pyramid, level) <= FULL_SUMMARY_TILES) level++;
    return level;
}
/** Every tile of the occupied root at levels `[from, to)`, coarse first. */
function rootAddresses(root: Readonly<Rect>, pyramid: TilePyramid, from: number, to: number): TileAddress[] {
    const out: TileAddress[] = [];
    for (let level = from; level < to; level++) {
        const side = DENSE_TILE_PIXELS / tileScale(pyramid, level);
        const x0 = Math.floor(root.x / side), y0 = Math.floor(root.y / side);
        const x1 = Math.floor((root.x + root.width) / side), y1 = Math.floor((root.y + root.height) / side);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ pyramid, level, x, y });
    }
    return out;
}
/** The viewport's tile grid at its own level and pyramid. Tiles are `[x0, x1) × [y0, y1)`. */
interface ViewGrid { readonly pyramid: TilePyramid; readonly level: number; readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
/** Every ancestor of the grid's tiles from `floor` up to one level below the grid, coarse first. The ancestors
 * of tiles `k` levels above are `floor(x / 2^k)`, so each level is one rectangle of tiles, and the total is
 * about a third of the grid: each level halves both axes. */
function summaryAddresses(grid: ViewGrid, floor: number): TileAddress[] {
    const out: TileAddress[] = [];
    for (let level = floor; level < grid.level; level++) {
        const span = 2 ** (grid.level - level);
        const xa = Math.floor(grid.x0 / span), xb = Math.floor((grid.x1 - 1) / span);
        const ya = Math.floor(grid.y0 / span), yb = Math.floor((grid.y1 - 1) / span);
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) out.push({ pyramid: grid.pyramid, level, x, y });
    }
    return out;
}

/** A rasterized tile part we own until the plan retires. `release` is idempotent. */
interface TileBitmap {
    readonly bitmap: ImageBitmap;
    readonly rect: Readonly<Rect>;
    /** A standin draws this crop of a coarser tile's bitmap into `rect`; absent for a tile's own pixels. */
    readonly crop?: Readonly<Rect>;
    readonly memoryBytes: number;
    release(): void;
}
/** One sub-run of a band's tile: drawn by the frame before the live node `end` (or after all of them). A
 * standin entry carries the `slot` of the refinement that will replace it. */
interface Entry { readonly blend: Blend; readonly end: string | null; readonly bitmap: TileBitmap; readonly slot: number | null }
type Plan = {
    source: PaintSource; // the source's windows, read once when the plan starts
    windows: readonly PaintWindow[]; view: string; scale: number; sharp: boolean; live: ReadonlySet<string> | undefined;
    phase: 'summary' | 'tiles' | 'direct' | 'refine' | 'complete';
    /** Summaries are decided once, when the summary phase starts; null until then. */
    summaries: SummaryTarget[] | null; summaryIndex: number; summaryCache: { cache: SessionDenseRasters; ticket: DenseRasterTicket } | null;
    band: PaintBand; tileX: number; tileY: number; x0: number; x1: number; y0: number; y1: number;
    /** The tile the raster step works on: the cursor in the tile phase, or a queued refinement (`slot`). */
    target: { band: PaintBand; x: number; y: number; slot: number | null };
    /** Tiles drawn as standins, each waiting for its exact parts in the refine phase. */
    refine: { band: PaintBand; x: number; y: number }[]; refineIndex: number;
    job: StreamingDenseTileJob | null;
    cache: { cache: SessionDenseRasters; ticket: DenseRasterTicket } | null;
    entries: Record<PaintBand, Entry[]>;
    /** Tiles drawn from a coarser cached tile and not yet refined. A plan with standins is not sharp. */
    standins: number;
    owned: TileBitmap[];
    bitmaps: Map<string, TileBitmap>;
    bitmapBytes: number;
    /** Covers the published window list's references (a copy of the source's items). They were once only counted, not
     * reserved: ~32 KB over the layer's reservation for 1,792 live items made the governor refuse its readout. */
    windowLease: ByteLease | null;
    directAdapter: CanvasPaintAdapter | null;
    /** CPU leases that cover the direct adapter as it grows, one chunk at a time; `directLeased` is their sum. */
    directLeases: ByteLease[]; directLeased: number;
    pending: number;
    lease: ByteLease | null;
    retired: boolean; blocked: boolean; prepared: PreparedPaint2d | null; resources: PaintLayerResources;
    /** Open retainPrepared borrows. A retired plan frees its bitmaps, leases and direct adapter only
     * when the last borrow ends; `freed` makes that one-shot. */
    borrows: number; closing: boolean; freed: boolean;
    /** Resolved nodes its tiles and bands share; disposed when the plan completes or retires. */
    resolved: ResolvedNodeCache;
};
const projection = (view: ViewState) => [view.camera.x, view.camera.y, view.camera.z,
    view.viewport.width, view.viewport.height, view.viewport.dpr].join(':');
const supportsLive = (plan: Plan, live?: ReadonlySet<string>): boolean => {
    if (plan.live === live || !live) return true;
    for (const id of live) if (!plan.live?.has(id)) return false;
    return true;
};

/** A dense frame: each band's unlive content is rasterized per tile from its own bounded stream,
 * and the live items are drawn as prepared items at their canonical positions between those parts.
 * Coverage is always complete before the frame is published: a tile with no exact content is drawn from
 * its nearest cached ancestor, and the exact tile replaces that standin later, in place. */
export function createDensePaintAdapter(resources: PaintLayerResources, host: LayerHost, report: (error: unknown) => void,
    gate: MemoryRetryGate = new MemoryRetryGate()) {
    let staged: Plan | null = null, ready: Plan | null = null, disposed = false, denied = false, serial = 0;
    // The view last prepared: what a reclaim must keep is what this view can draw.
    let lastView: ViewState | null = null;
    const sessionOf = () => {
        const frame = resources.frames.readFrame();
        return frame?.sessionRasters && frame.rasterVariant ? { cache: frame.sessionRasters, variant: frame.rasterVariant } : null;
    };
    let lastFrame = -1;
    // A plan whose stream failed is not restarted each frame: its frame is refused until a newer one arrives.
    let failedFrame: PaintSource | null = null;
    const plans = new Set<Plan>();
    const working = (p: Plan) => p.bitmapBytes + (p.job?.memoryBytes ?? 0) + (p.lease?.bytes ?? 0) + p.directLeased + (p.windowLease?.bytes ?? 0);
    const finishRetirement = (p: Plan) => { if (p.retired && !p.pending) plans.delete(p); };
    // Retiring a plan stops its work at once; the resources a retainPrepared borrow reads outlive it.
    const drop = (p: Plan | null) => {
        if (!p || p.retired) return;
        p.retired = true;
        p.resolved.dispose();
        p.job?.cancel(); p.job = null;
        if (p.cache) { p.cache.cache.cancel(p.cache.ticket); p.cache = null; }
        if (p.summaryCache) { p.summaryCache.cache.cancel(p.summaryCache.ticket); p.summaryCache = null; }
        p.entries.underlay = []; p.entries.content = [];
        if (p.borrows) { p.closing = true; return; }
        free(p);
    };
    // Same contract as the 2D adapter: a further borrow comes only from an open one, and the last release frees a closing plan.
    const borrowPlan = (p: Plan, prepared: PreparedPaint2d): PreparedRetain => {
        p.borrows++;
        let open = true;
        return { prepared, retain: () => open ? borrowPlan(p, prepared) : null, release() {
            if (!open) return;
            open = false;
            if (--p.borrows === 0 && p.closing) free(p);
        } };
    };
    /** Stops a staged plan. A plan that is already published keeps its complete pixels: only its in-flight
     * work stops, so the frame on screen is never replaced by a partial one. */
    const retire = (p: Plan | null) => {
        if (!p || p.retired) return;
        if (p !== ready) { drop(p); return; }
        p.job?.cancel(); p.job = null;
        if (p.cache) { p.cache.cache.cancel(p.cache.ticket); p.cache = null; }
        if (p.summaryCache) { p.summaryCache.cache.cancel(p.summaryCache.ticket); p.summaryCache = null; }
        p.phase = 'complete';
    };
    const free = (p: Plan) => {
        if (p.freed) return;
        p.freed = true;
        p.resolved.dispose();
        p.directAdapter?.dispose(); p.directAdapter = null; p.prepared = null;
        for (const bitmap of p.owned.splice(0)) bitmap.release();
        p.bitmaps.clear(); p.bitmapBytes = 0;
        for (const lease of p.directLeases.splice(0)) host.allocator.cpu.release(lease);
        p.directLeased = 0;
        if (p.lease) { host.allocator.cpu.release(p.lease); p.lease = null; }
        if (p.windowLease) { host.allocator.cpu.release(p.windowLease); p.windowLease = null; }
        finishRetirement(p);
    };
    const start = (frame: PaintSource, view: ViewState, live: ReadonlySet<string> | undefined, fine: boolean): Plan | null => {
        // Without a reopenable stream there is no tile content to build; the caller keeps its direct path.
        if (!frame.openTile) return null;
        const demand = view.camera.z * view.viewport.dpr, target = chooseTileScale(demand).scale;
        const levels = fine ? 0 : Math.max(0, Math.ceil(Math.log2(Math.max(view.viewport.width, view.viewport.height) * target / (view.camera.z * EDGE))));
        const scale = target / 2 ** levels;
        const side = EDGE / scale;
        const x0 = Math.floor(view.camera.x / side), y0 = Math.floor(view.camera.y / side);
        const x1 = Math.ceil((view.camera.x + view.viewport.width / view.camera.z) / side);
        const y1 = Math.ceil((view.camera.y + view.viewport.height / view.camera.z) / side);
        if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Dense viewport grid overflows');
        const lease = host.allocator.cpu.reserve(BLOCK);
        // A denied plan start waits for a real capacity change: the wake re-runs the frame, nothing polls.
        if (!lease) { denied = true; gate.refused(); host.allocator.cpu.whenAvailable?.(() => resources.invalidate()); return null; }
        gate.admitted();
        try {
            const summarized = !!frame.occupiedRoot && !!frame.sessionRasters && !!frame.rasterVariant;
            const p: Plan = { source: frame, windows: windowsOfSource(frame), view: projection(view), scale, sharp: scale >= demand, live,
                phase: summarized ? 'summary' : 'tiles', band: 'underlay', tileX: x0, tileY: y0, x0, x1, y0, y1,
                summaries: null, summaryIndex: 0, summaryCache: null,
                target: { band: 'underlay', x: x0, y: y0, slot: null }, refine: [], refineIndex: 0,
                job: null, cache: null, entries: { underlay: [], content: [] }, standins: 0, owned: [], bitmaps: new Map(), bitmapBytes: 0, windowLease: null,
                directAdapter: null, directLeases: [], directLeased: 0,
                pending: 0, lease, retired: false, blocked: false, prepared: null, resources, borrows: 0, closing: false, freed: false,
                resolved: new ResolvedNodeCache(host.allocator.cpu) };
            p.resources = { ...resources, images: { acquire(key, token, signal) {
                p.pending++;
                let promise;
                try { promise = resources.images.acquire(key, token, signal); }
                catch (error) { p.pending--; finishRetirement(p); throw error; }
                return promise.finally(() => { p.pending--; finishRetirement(p); resources.invalidate(); });
            } } };
            plans.add(p); return p;
        } catch (error) { host.allocator.cpu.release(lease); throw error; }
    };
    const toTileBitmap = (part: DenseTilePart): TileBitmap => {
        let held = true;
        return { bitmap: part.bitmap, rect: part.rect, memoryBytes: part.bytesLease.bytes, release() {
            if (!held) return; held = false; releaseDenseTilePart(part);
        } };
    };
    /** A cached coarser tile drawn cropped to `child`. It owns the borrow on success, and releases it otherwise. */
    const standinOf = (borrow: DenseRasterBorrow, child: Readonly<Rect>): TileBitmap | null => {
        const parent = borrow.rect, k = EDGE / parent.width, eps = 1e-6 * parent.width;
        const inside = child.x >= parent.x - eps && child.y >= parent.y - eps
            && child.x + child.width <= parent.x + parent.width + eps && child.y + child.height <= parent.y + parent.height + eps;
        if (!borrow.bitmap || !inside || !(k > 0)) { borrow.release(); return null; }
        // The bitmap's EDGE interior sits inside a 2 px apron, as the sourceRect of a tile's own draw says.
        const crop: Readonly<Rect> = Object.freeze({ x: 2 + (child.x - parent.x) * k, y: 2 + (child.y - parent.y) * k,
            width: child.width * k, height: child.height * k });
        let held = true;
        return { bitmap: borrow.bitmap, rect: Object.freeze({ ...child }), crop, memoryBytes: 0,
            release() { if (held) { held = false; borrow.release(); } } };
    };
    const borrowBitmap = (borrow: DenseRasterBorrow): TileBitmap | null => {
        if (!borrow.bitmap) { borrow.release(); return null; }
        let held = true;
        return { bitmap: borrow.bitmap, rect: borrow.rect, memoryBytes: 0, release() { if (held) { held = false; borrow.release(); } } };
    };
    const put = (p: Plan, band: PaintBand, end: string | null, blend: Blend, bitmap: TileBitmap, slot: number | null = null) => {
        p.owned.push(bitmap); p.bitmapBytes += bitmap.memoryBytes;
        p.entries[band].push({ blend, end, bitmap, slot });
    };
    const advanceTile = (p: Plan) => {
        if (++p.tileX !== p.x1) return;
        p.tileX = p.x0;
        if (++p.tileY !== p.y1) return;
        p.tileY = p.y0;
        if (p.band === 'underlay') { p.band = 'content'; return; }
        p.phase = 'direct';
    };
    /** Tile phase only: a cached coarser tile is drawn cropped into the cursor's tile now, and the tile is queued
     * for its exact parts. Returns false when no standin could be made, and the caller streams the tile instead. */
    const standIn = (p: Plan, coarse: DenseRasterBorrow, rect: Rect): boolean => {
        const bitmap = standinOf(coarse, rect);
        if (!bitmap) return false;
        const slot = p.refine.length;
        p.standins++; p.refine.push({ band: p.target.band, x: p.target.x, y: p.target.y });
        put(p, p.target.band, null, 'normal', bitmap, slot);
        advanceTile(p);
        return true;
    };
    /** Places a finished tile's parts. In the tile phase they are appended and the cursor advances. A refinement
     * retires its standin, appends the exact parts, and publishes again, so coverage never has a hole. */
    const settle = (p: Plan, parts: readonly { readonly end: string | null; readonly blend: Blend; readonly bitmap: TileBitmap }[]) => {
        const { band, slot } = p.target;
        if (slot === null) {
            for (const part of parts) put(p, band, part.end, part.blend, part.bitmap);
            advanceTile(p); return;
        }
        const kept: Entry[] = [];
        for (const entry of p.entries[band]) {
            if (entry.slot === slot) { entry.bitmap.release(); p.standins--; } else kept.push(entry);
        }
        p.entries[band] = kept;
        for (const part of parts) put(p, band, part.end, part.blend, part.bitmap);
        p.refineIndex++;
        publish(p);
    };
    const summaryGrid = (p: Plan): ViewGrid => {
        const viewport = chooseTileScale(p.scale);
        return { pyramid: viewport.pyramid, level: viewport.level, x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 };
    };
    /** Whether any grid tile lacks an exact cache entry in some band: summaries are only needed then. */
    const uncached = (cache: SessionDenseRasters, variant: string, grid: ViewGrid): boolean => {
        for (const band of BANDS) {
            const interval = bandInterval(variant, band);
            for (let y = grid.y0; y < grid.y1; y++) for (let x = grid.x0; x < grid.x1; x++) {
                const address: TileAddress = { pyramid: grid.pyramid, level: grid.level, x, y };
                const held = cache.borrowAncestor(interval, address);
                const exact = !!held && sameAddress(held.address, address);
                held?.release();
                if (!exact) return true;
            }
        }
        return false;
    };
    /** Streams each missing summary once per revision, one at a time, and publishes it to its own interval. A
     * summary is never drawn here: it exists so that a tile with no exact content has a coarser standin. */
    const summarize = (p: Plan, view: ViewState, budget: FrameBudget): void => {
        const cache = p.source.sessionRasters, variant = p.source.rasterVariant, root = p.source.occupiedRoot;
        if (!p.summaries) {
            p.summaries = [];
            if (!cache || !variant || !root || !cache.advanceRevision(p.source.sceneRevision, p.source.regionChangesSince)) {
                p.phase = 'tiles'; return;
            }
            cache.bindMemory(host.allocator.cpu);
            const grid = summaryGrid(p);
            const floor = rootFloorLevel(root, chooseTileScale(p.scale));
            // The coarse levels whose whole root is a few tiles are session-maintained: every one is kept current
            // for every viewport, whichever viewport built it. Only finer summary levels follow the viewport.
            const top = fullRootTop(root, grid.pyramid, floor, grid.level);
            const targets: SummaryTarget[] = p.summaries;
            const add = (address: TileAddress) => {
                const rect = tileRectWorld(address);
                if (p.source.mayPaint?.(rect) === false) return;
                for (const band of BANDS) targets.push({ band, address, rect, scale: tileScale(address.pyramid, address.level) });
            };
            for (const address of rootAddresses(root, grid.pyramid, floor, top)) add(address);
            if (uncached(cache, variant, grid)) for (const address of summaryAddresses(grid, top)) add(address);
        }
        while (p.summaryIndex < p.summaries.length) {
            if (!p.job) {
                const target = p.summaries[p.summaryIndex];
                if (!cache || !variant) { p.summaryIndex = p.summaries.length; break; }
                cache.bindMemory(host.allocator.cpu);
                const interval = summaryInterval(variant, target.band);
                const held = cache.borrowAncestor(interval, target.address);
                const current = !!held && sameAddress(held.address, target.address);
                held?.release();
                if (current) { p.summaryIndex++; continue; }
                const ticket = cache.begin(interval, target.address, p.source.sceneRevision);
                // Memory denied the summary: skip it, since tiles then stand in with whatever is cached.
                if (!ticket) { p.summaryIndex++; continue; }
                p.summaryCache = { cache, ticket };
                p.job = createStreamingDenseTileJob({ open: (apron, signal) => p.source.openTile!(apron, signal, p.resolved),
                    rect: target.rect, scale: target.scale, band: target.band, barriers: NO_LIVE, token: p.source.token,
                    revision: p.source.sceneRevision, isCurrent: () => !p.retired && resources.frames.isCurrent(p.source),
                    images: p.resources.images, host, onError: report });
            }
            p.job.prepare(view, budget);
            if (p.job.blocked) gate.refused();
            if (p.job.failed) { failedFrame = p.source; retire(p); staged = null; return; }
            if (p.job.stopped) { retire(p); staged = null; return; }
            if (!p.job.isComplete && !p.job.isEmpty) return;
            const job = p.job, pending = p.summaryCache!, target = p.summaries[p.summaryIndex];
            p.job = null; p.summaryCache = null; p.summaryIndex++;
            const parts = job.takeParts();
            const only = !job.touchedLive && parts.length === 1 && parts[0].end === null && parts[0].blend === 'normal' && !parts[0].hasImage ? parts[0] : null;
            let accepted = false;
            try {
                if (only) accepted = pending.cache.publish(pending.ticket, { bitmap: only.bitmap, bytesLease: only.bytesLease, owner: only.owner, rect: only.rect, scale: target.scale });
            } catch (error) {
                pending.cache.cancel(pending.ticket);
                for (const part of parts) releaseDenseTilePart(part);
                throw error;
            }
            if (!accepted) pending.cache.cancel(pending.ticket);
            for (const part of parts) if (!(accepted && part === only)) releaseDenseTilePart(part);
        }
        if (p.summaryIndex >= p.summaries.length && !p.job) p.phase = 'tiles';
    };
    /** One tile at the cursor (tile phase) or one queued refinement (refine phase). A cached tile is used only
     * while no sensitive or live node may paint in its apron; otherwise the tile is streamed and split. */
    const raster = (p: Plan, view: ViewState, budget: FrameBudget): void => {
        const { band, x, y, slot } = p.target;
        const side = EDGE / p.scale, bleed = 2 / p.scale;
        const rect: Rect = { x: x * side, y: y * side, width: side, height: side };
        const apron: Rect = { x: rect.x - bleed, y: rect.y - bleed, width: side + 2 * bleed, height: side + 2 * bleed };
        // Sparse: no node of the pinned sheet can paint in the apron, so the tile is empty and needs nothing.
        if (!p.job && !p.cache && p.source.mayPaint?.(apron) === false) { settle(p, []); return; }
        const tileScale = chooseTileScale(p.scale);
        const address: TileAddress = { pyramid: tileScale.pyramid, level: tileScale.level, x, y };
        const cache = p.source.sessionRasters, variant = p.source.rasterVariant;
        const reaches = (nodes: ReadonlySet<string>) => p.source.sensitiveMayMeet?.(apron, nodes) !== false;
        const cacheable = !!cache && !!variant && tileScale.scale === p.scale
            && p.source.sensitiveNodes !== undefined && !reaches(p.source.sensitiveNodes) && !(p.live && reaches(p.live));
        const interval = cacheable ? bandInterval(variant!, band) : '';
        if (cacheable && !p.job && !p.cache) {
            cache.bindMemory(host.allocator.cpu);
            if (cache.advanceRevision(p.source.sceneRevision, p.source.regionChangesSince)) {
                const own = cache.borrowAncestor(interval, address);
                if (own && sameAddress(own.address, address)) {
                    const bitmap = borrowBitmap(own);
                    settle(p, bitmap ? [{ end: null, blend: 'normal', bitmap }] : []);
                    return;
                }
                if (slot === null) {
                    // Tile phase: a cached coarser tile stands in now, and the tile is refined afterwards. The
                    // standin consumes whichever borrow it is given, so nothing is left held on either path.
                    const coarse = own ?? cache.borrowAncestor(summaryInterval(variant!, band), address);
                    if (coarse && standIn(p, coarse, rect)) return;
                } else own?.release();
                const ticket = cache.begin(interval, address, p.source.sceneRevision);
                // Memory denied this tile and nothing coarser exists: the plan waits for memory.
                if (!ticket) { p.blocked = true; gate.refused(); host.allocator.cpu.whenAvailable?.(() => resources.invalidate()); return; }
                gate.admitted();
                p.cache = { cache, ticket };
            }
        }
        p.job ??= createStreamingDenseTileJob({ open: (apron, signal) => p.source.openTile!(apron, signal, p.resolved),
            rect, scale: p.scale, band, barriers: p.live ?? NO_LIVE, sensitive: p.source.sensitiveNodes, token: p.source.token, revision: p.source.sceneRevision,
            isCurrent: () => !p.retired && resources.frames.isCurrent(p.source), images: p.resources.images,
            host, onError: report });
        p.job.prepare(view, budget);
        if (p.job.blocked) gate.refused();
        if (p.job.failed) { failedFrame = p.source; retire(p); staged = null; return; }
        if (p.job.stopped) { retire(p); staged = null; return; }
        if (!p.job.isComplete && !p.job.isEmpty) return;
        const job = p.job, pending = p.cache;
        p.job = null; p.cache = null;
        const parts = job.takeParts();
        const only = !job.touchedLive && parts.length === 1 && parts[0].end === null && parts[0].blend === 'normal' && !parts[0].hasImage ? parts[0] : null;
        if (pending && only) {
            let accepted = false;
            try {
                accepted = pending.cache.publish(pending.ticket, { bitmap: only.bitmap, bytesLease: only.bytesLease, owner: only.owner,
                    rect: only.rect, scale: p.scale });
            } catch (error) { pending.cache.cancel(pending.ticket); releaseDenseTilePart(only); throw error; }
            if (accepted) {
                const found = pending.cache.borrowAncestor(interval, address);
                if (!found || !found.bitmap) { found?.release(); throw new Error('Published dense tile cannot be borrowed'); }
                settle(p, [{ end: null, blend: 'normal', bitmap: borrowBitmap(found)! }]);
                return;
            }
            settle(p, [{ end: null, blend: 'normal', bitmap: toTileBitmap(only) }]);
            return;
        }
        if (pending) pending.cache.cancel(pending.ticket);
        settle(p, parts.map(part => ({ end: part.end, blend: part.blend, bitmap: toTileBitmap(part) })));
    };
    /** The band's frame in canonical order, with each barrier's tile parts placed before its live items, pushed
     * into the window builder as it goes. One walk over the frame's own items: buckets follow the parts, never a
     * per-live-node structure, and no whole-band array is built. */
    const bandInto = (p: Plan, band: PaintBand, out: PaintWindowBuilder): void => {
        const buckets = new Map<string | null, Entry[]>();
        for (const entry of p.entries[band]) {
            const list = buckets.get(entry.end);
            if (list) list.push(entry); else buckets.set(entry.end, [entry]);
        }
        const image = (entry: Entry): PaintItem => {
            const key = `dense/${++serial}`;
            p.bitmaps.set(key, entry.bitmap);
            const item: PaintImageItem = { kind: 'image', key, geometryKey: key, imageKey: key, nodeId: key,
                localToWorld: [1, 0, 0, 1, 0, 0], clips: [], rect: entry.bitmap.rect, allocationBounds: entry.bitmap.rect,
                sourceRect: { x: 2, y: 2, width: EDGE, height: EDGE }, opacity: 1, blend: entry.blend, inverted: false, retainedTile: true };
            return item;
        };
        let group: string | null = null;
        for (const item of bandItemsOf(p.windows, band)) {
            if (!p.live?.has(item.nodeId)) continue;
            if (item.nodeId !== group) {
                group = item.nodeId;
                const before = buckets.get(group);
                if (before) { for (const entry of before) out.push(band, image(entry)); buckets.delete(group); }
            }
            out.push(band, item);
        }
        for (const end of buckets.keys()) if (end !== null) throw new Error('Dense tile barrier is missing from the live frame');
        for (const entry of buckets.get(null) ?? []) out.push(band, image(entry));
    };
    /** Publishes the plan's current coverage. Complete coverage with standins is published as a provisional
     * frame: the plan stays staged, and each refinement republishes. Only a plan without standins is sharp. */
    const publish = (p: Plan) => {
        const direct = p.directAdapter!.borrowPrepared();
        if (!direct) return;
        const windows = new PaintWindowBuilder();
        bandInto(p, 'underlay', windows); bandInto(p, 'content', windows);
        const root: PaintRoot = { ...rootOf(p.source), inkNodeIds: p.sharp ? p.source.inkNodeIds : new FilteredInk(p.source.inkNodeIds, p.live, true) };
        const final = p.standins === 0;
        const finished = windows.finish();
        const windowBytes = refBytesOf(finished);
        if (windowBytes > (p.windowLease?.bytes ?? 0)) {
            // A denied reservation keeps the current picture and waits for a real capacity change.
            const lease = host.allocator.cpu.reserve(windowBytes);
            if (!lease) { p.blocked = true; gate.refused(); host.allocator.cpu.whenAvailable?.(() => resources.invalidate()); return; }
            gate.admitted();
            if (p.windowLease) host.allocator.cpu.release(p.windowLease);
            p.windowLease = lease;
        }
        p.prepared = { sourceFrame: p.source, root, windows: finished, sharp: p.sharp && final, resources: {
            path: item => direct.resources.path(item), clip: key => direct.resources.clip(key),
            image: key => p.bitmaps.get(key)?.bitmap ?? direct.resources.image(key),
            imageCrop: key => p.bitmaps.get(key)?.crop ?? null,
        } };
        if (ready !== p) drop(ready);
        ready = p;
        if (final) { p.phase = 'complete'; p.resolved.dispose(); if (staged === p) staged = null; }
        else { p.phase = 'refine'; staged = p; }
        resources.invalidate();
    };
    const adapter: CanvasPaintAdapter & {
        prepare(view: ViewState, budget: FrameBudget, liveNodes?: ReadonlySet<string>): void;
        coverage(view: ViewState, liveNodes?: ReadonlySet<string>): { complete: boolean; sharp: boolean; staleVersion?: boolean };
        retainedFrames(): ReadonlySet<PaintSource>;
        /** A staged plan waits for memory; a real capacity change wakes it. */
        memoryBlocked(): boolean;
        /** Work for the requested revision is outstanding: staged, or a provisional frame still refining. */
        pending(): boolean;
        cpuWorkingSet(nativePathUpperBound?: number): number;
        /** Frees up to `bytes` of session bitmaps the last view cannot draw; a borrowed bitmap is never freed. */
        reclaim(bytes: number): void;
        /** On return from a hidden pane: drops the bitmaps the view cannot draw before any plan is made. False when
         * the frame has no session to drop from yet, so the caller asks again on a later prepare. */
        dropUnused(view: ViewState): boolean;
    } = {
        prepare(view, budget, liveNodes?: ReadonlySet<string>) {
            if (disposed || lastFrame === budget.frameId) return;
            lastFrame = budget.frameId; denied = false; lastView = view;
            // A refused run waits out its back-off before any reservation, whichever frame re-ran this one.
            if (gate.closed()) { denied = true; return; }
            const frame = resources.frames.readFrame();
            if (!frame || !resources.frames.isCurrent(frame)) { retire(staged); staged = null; return; }
            if (frame !== failedFrame) failedFrame = null;
            else { retire(staged); staged = null; return; }
            const key = projection(view);
            if (staged && (staged.source !== frame || staged.view !== key || !supportsLive(staged, liveNodes))) { retire(staged); staged = null; }
            const matches = ready?.source === frame && ready.view === key && supportsLive(ready, liveNodes);
            if (matches && ready?.sharp) return;
            try {
                staged ??= start(frame, view, liveNodes, matches);
                const p = staged; if (!p) return;
                p.blocked = false;
                while (!budget.shouldYield() && !p.retired) {
                    if (!resources.frames.isCurrent(frame)) { retire(p); staged = null; return; }
                    if (p.phase === 'summary') {
                        summarize(p, view, budget);
                        if (p.retired || p.job) return;
                        continue;
                    }
                    if (p.phase === 'tiles') {
                        p.target = { band: p.band, x: p.tileX, y: p.tileY, slot: null };
                        raster(p, view, budget);
                        if (p.retired) return;
                        if (p.job && (p.job.awaiting || !p.job.needsFrame())) return;
                    } else if (p.phase === 'refine') {
                        if (p.refineIndex >= p.refine.length) return;
                        const next = p.refine[p.refineIndex];
                        p.target = { band: next.band, x: next.x, y: next.y, slot: p.refineIndex };
                        raster(p, view, budget);
                        if (p.retired) return;
                        if (p.job && (p.job.awaiting || !p.job.needsFrame())) return;
                    } else if (p.phase === 'direct') {
                        if (!p.directAdapter) {
                            // Only live items are prepared: the adapter skips the rest in place, with no filtered copy.
                            const source = p.source;
                            p.directAdapter = createCanvasPaintAdapter({ ...p.resources, frames: {
                                readFrame: () => source,
                                isCurrent: candidate => candidate === source && resources.frames.isCurrent(source),
                            } }, (_ctx, _view, paint) => paint(), report, item => !!p.live?.has(item.nodeId));
                        }
                        const adapter = p.directAdapter;
                        // The adapter's native bytes are covered one chunk at a time: a denied chunk blocks the plan
                        // until memory frees, and a huge live set streams through the adapter instead of reserving
                        // an up-front estimate of every item.
                        while (adapter.memory().cpuBytes + DIRECT_CHUNK > p.directLeased) {
                            const lease = host.allocator.cpu.reserve(DIRECT_CHUNK);
                            if (!lease) { p.blocked = true; gate.refused(); host.allocator.cpu.whenAvailable?.(() => resources.invalidate()); return; }
                            gate.admitted();
                            p.directLeases.push(lease); p.directLeased += lease.bytes;
                        }
                        // Stops at the covered boundary; the next frame reserves the following chunk before it resumes.
                        const directBudget: FrameBudget = { ...budget, shouldYield: (): boolean =>
                            budget.shouldYield() || adapter.memory().cpuBytes + DIRECT_CHUNK > p.directLeased };
                        adapter.prepare(view, directBudget);
                        if (adapter.borrowPrepared()) publish(p);
                        return;
                    } else return;
                    if (p.blocked) return;
                }
            } catch (error) { retire(staged); staged = null; report(error); }
        },
        readyFrame: () => disposed ? null : ready?.source ?? null,
        borrowPrepared: () => disposed ? null : ready?.prepared ?? null,
        retainPrepared() {
            const p = ready, prepared = p?.prepared;
            if (disposed || !p || !prepared || p.retired) return null;
            return borrowPlan(p, prepared);
        },
        draw2d(ctx, view, band, omitNodes) {
            const p = ready, prepared = p?.prepared;
            if (!p || !prepared) return;
            for (const window of prepared.windows) {
                if (window.band !== band) continue;
                for (const item of window.items) {
                    if (omitNodes?.has(item.nodeId)) continue;
                    if (item.kind !== 'image' || !item.retainedTile) {
                        host.paintWorld(ctx, view, () => paintItem2d(ctx, item, prepared.resources));
                        continue;
                    }
                    const bitmap = p.bitmaps.get(item.imageKey);
                    if (!bitmap) throw new Error('Retained dense bitmap unavailable');
                    const scale = view.camera.z * view.viewport.dpr, sourceScale = EDGE / item.rect.width;
                    const left = (item.rect.x - view.camera.x) * scale, top = (item.rect.y - view.camera.y) * scale;
                    const right = left + item.rect.width * scale, bottom = top + item.rect.height * scale;
                    const x = Math.max(0, Math.ceil(left - .5)), y = Math.max(0, Math.ceil(top - .5));
                    const x1 = Math.min(Math.round(view.viewport.width * view.viewport.dpr), Math.ceil(right - .5));
                    const y1 = Math.min(Math.round(view.viewport.height * view.viewport.dpr), Math.ceil(bottom - .5));
                    if (x1 <= x || y1 <= y) continue;
                    const gutter = 2 * scale / sourceScale, crop = bitmap.crop;
                    ctx.save();
                    try {
                        ctx.resetTransform(); ctx.beginPath(); ctx.rect(x, y, x1 - x, y1 - y); ctx.clip();
                        ctx.globalAlpha = 1; ctx.globalCompositeOperation = item.blend === 'multiply' ? 'multiply' : 'source-over'; ctx.filter = 'none';
                        if (crop) ctx.drawImage(bitmap.bitmap, crop.x, crop.y, crop.width, crop.height, left, top, right - left, bottom - top);
                        else ctx.drawImage(bitmap.bitmap, left - gutter, top - gutter, right - left + 2 * gutter, bottom - top + 2 * gutter);
                    } finally { ctx.restore(); }
                }
            }
        },
        coverage(view, liveNodes) {
            const complete = !!ready && ready.view === projection(view) && supportsLive(ready, liveNodes);
            return { complete, sharp: complete && !!ready?.sharp, ...(ready?.source !== resources.frames.readFrame() ? { staleVersion: true } : {}) };
        },
        retainedFrames: () => new Set([...plans].map(p => p.source)),
        memoryBlocked: () => !disposed && (denied || !!staged?.blocked || !!staged?.job?.blocked),
        pending: () => !disposed && (!!staged || (!!ready && !ready.sharp)),
        cpuWorkingSet(nativePathUpperBound = 0) {
            let held = 0; for (const p of plans) held += working(p);
            // The session bitmaps the view keeps are its working set, and two tile runs are the next ones it reserves.
            // Declared, the pane grant rises above its floor; a grant still below this is the governor's cap, which
            // refuses the runs past it and reclaims what the view cannot draw.
            const session = resources.frames.readFrame()?.sessionRasters;
            const pending = !!staged || !ready || !ready.sharp || ready.source !== resources.frames.readFrame() || !resources.frames.isCurrent(ready.source);
            // The next runs are the staged job's own bound, or two runs when no job is staged; a settled view still keeps them.
            const next = pending && staged?.job ? staged.job.cpuWorkingSet : 2 * TILE_RUN_BYTES;
            if (!pending) return held + (session?.memoryBytes ?? 0) + next;
            return held + (session?.memoryBytes ?? 0) + next + BLOCK + nativePathUpperBound + (session ? 4096 : 0);
        },
        memory() { let cpuBytes = 0; for (const p of plans) cpuBytes += working(p); return { gpuBytes: 0, cpuBytes }; },
        needsFrame() {
            if (disposed || denied || staged?.blocked) return false;
            // A plan drawn with standins because memory was denied waits for the next invalidation instead of spinning.
            if (!staged) return !!ready && !ready.sharp && ready.standins === 0;
            if (staged.job) return staged.job.needsFrame();
            if (staged.phase === 'refine') return true;
            if (staged.directAdapter) return staged.directAdapter.needsFrame();
            return true;
        },
        release(reason: GpuReleaseReason) {
            if (reason === 'context-lost') return;
            drop(staged); drop(ready); staged = ready = null; lastFrame = -1; denied = false;
        },
        reclaim(bytes) {
            const view = lastView, session = !disposed && view ? sessionOf() : null;
            if (session && view) session.cache.evictUnused(usableBitmaps(session.variant, view), bytes);
        },
        dropUnused(view) {
            if (disposed) return false;
            lastView = view;
            const session = sessionOf();
            if (!session) return false;
            session.cache.evictUnused(usableBitmaps(session.variant, view), Number.MAX_SAFE_INTEGER);
            return true;
        },
        dispose() { if (!disposed) { disposed = true; drop(staged); drop(ready); staged = ready = null; } },
    };
    return adapter;
}
