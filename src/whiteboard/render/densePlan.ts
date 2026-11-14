import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason } from '../../platform/render/types';
import type { Blend } from './colour';
import type { PaintBand } from './material';
import { inkCoverageChunks, type PaintFrame, type PaintImageItem, type PaintItem } from './paintStream';
import type { PaintLayerResources } from './resources';
import { chooseTileScale, type TileAddress } from './tileHierarchy';
import type { DenseRasterBorrow, DenseRasterTicket, SessionDenseRasters } from './sessionDenseRasters';
import { createStreamingDenseTileJob, releaseDenseTilePart, type DenseTilePart, type StreamingDenseTileJob } from './streamingDenseTile';
import { FilteredInk } from './nodeSets';
import { createCanvasPaintAdapter, type CanvasPaintAdapter, type PreparedPaint2d } from './reference/canvasPaintAdapter';
import { paintItem2d } from './reference/paint2d';

const EDGE = 512, BLOCK = 65_536;
const NO_LIVE: ReadonlySet<string> = new Set();

/** A rasterized tile part we own until the plan retires. `release` is idempotent. */
interface TileBitmap {
    readonly bitmap: ImageBitmap;
    readonly rect: Readonly<Rect>;
    readonly memoryBytes: number;
    release(): void;
}
/** One sub-run of a band's tile: drawn by the frame before the live node `end` (or after all of them). */
interface Entry { readonly blend: Blend; readonly end: string | null; readonly bitmap: TileBitmap }
type Plan = {
    source: PaintFrame; view: string; scale: number; sharp: boolean; live: ReadonlySet<string> | undefined;
    phase: 'tiles' | 'direct' | 'complete'; band: PaintBand; tileX: number; tileY: number; x0: number; x1: number; y0: number; y1: number;
    job: StreamingDenseTileJob | null;
    cache: { cache: SessionDenseRasters; ticket: DenseRasterTicket } | null;
    entries: Record<PaintBand, Entry[]>;
    owned: TileBitmap[];
    bitmaps: Map<string, TileBitmap>;
    bitmapBytes: number;
    directAdapter: CanvasPaintAdapter | null; directLease: ByteLease | null; directEstimate: number;
    estimateBand: PaintBand; estimateItem: number; estimateClip: number; estimateChunk: number;
    pending: number;
    lease: ByteLease | null;
    retired: boolean; blocked: boolean; prepared: PreparedPaint2d | null; resources: PaintLayerResources;
};
const projection = (view: ViewState) => [view.camera.x, view.camera.y, view.camera.z,
    view.viewport.width, view.viewport.height, view.viewport.dpr].join(':');
const supportsLive = (plan: Plan, live?: ReadonlySet<string>): boolean => {
    if (plan.live === live || !live) return true;
    for (const id of live) if (!plan.live?.has(id)) return false;
    return true;
};
const isEmpty = (live: ReadonlySet<string> | undefined) => !live || live.values().next().done === true;

/** A dense frame: each band's unlive content is rasterized per tile from its own bounded stream,
 * and the live items are drawn as prepared items at their canonical positions between those parts.
 * Live items come from the frame's arrays; no whole-sheet item list is ever created here. */
export function createDensePaintAdapter(resources: PaintLayerResources, host: LayerHost, report: (error: unknown) => void) {
    let staged: Plan | null = null, ready: Plan | null = null, disposed = false, denied = false, serial = 0;
    let lastFrame = -1;
    const plans = new Set<Plan>();
    const working = (p: Plan) => p.bitmapBytes + (p.job?.memoryBytes ?? 0) + (p.lease?.bytes ?? 0) + (p.directLease?.bytes ?? 0);
    const finishRetirement = (p: Plan) => { if (p.retired && !p.pending) plans.delete(p); };
    const drop = (p: Plan | null) => {
        if (!p || p.retired) return;
        p.retired = true;
        p.job?.cancel(); p.job = null;
        if (p.cache) { p.cache.cache.cancel(p.cache.ticket); p.cache = null; }
        p.directAdapter?.dispose(); p.directAdapter = null; p.prepared = null;
        for (const bitmap of p.owned.splice(0)) bitmap.release();
        p.bitmaps.clear(); p.bitmapBytes = 0;
        p.entries.underlay = []; p.entries.content = [];
        if (p.directLease) { host.allocator.cpu.release(p.directLease); p.directLease = null; }
        if (p.lease) { host.allocator.cpu.release(p.lease); p.lease = null; }
        finishRetirement(p);
    };
    const start = (frame: PaintFrame, view: ViewState, live: ReadonlySet<string> | undefined, fine: boolean): Plan | null => {
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
        if (!lease) { denied = true; return null; }
        try {
            const p: Plan = { source: frame, view: projection(view), scale, sharp: scale >= demand, live,
                phase: 'tiles', band: 'underlay', tileX: x0, tileY: y0, x0, x1, y0, y1,
                job: null, cache: null, entries: { underlay: [], content: [] }, owned: [], bitmaps: new Map(), bitmapBytes: 0,
                directAdapter: null, directLease: null, directEstimate: 0, estimateBand: 'underlay', estimateItem: 0, estimateClip: 0, estimateChunk: 0,
                pending: 0, lease, retired: false, blocked: false, prepared: null, resources };
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
    const borrowBitmap = (borrow: DenseRasterBorrow): TileBitmap | null => {
        if (!borrow.bitmap) { borrow.release(); return null; }
        let held = true;
        return { bitmap: borrow.bitmap, rect: borrow.rect, memoryBytes: 0, release() { if (held) { held = false; borrow.release(); } } };
    };
    const put = (p: Plan, band: PaintBand, end: string | null, blend: Blend, bitmap: TileBitmap) => {
        p.owned.push(bitmap); p.bitmapBytes += bitmap.memoryBytes;
        p.entries[band].push({ blend, end, bitmap });
    };
    const advanceTile = (p: Plan) => {
        if (++p.tileX !== p.x1) return;
        p.tileX = p.x0;
        if (++p.tileY !== p.y1) return;
        p.tileY = p.y0;
        if (p.band === 'underlay') { p.band = 'content'; return; }
        p.phase = 'direct';
    };
    /** One tile of the current band. A cached tile is used only without live items: then its band
     * content is one part and no barrier can split it. Otherwise the tile is streamed and split. */
    const raster = (p: Plan, view: ViewState, budget: FrameBudget): void => {
        const band = p.band, side = EDGE / p.scale;
        const rect: Rect = { x: p.tileX * side, y: p.tileY * side, width: side, height: side };
        const tileScale = chooseTileScale(p.scale);
        const address: TileAddress = { pyramid: tileScale.pyramid, level: tileScale.level, x: p.tileX, y: p.tileY };
        const cache = p.source.sessionRasters, variant = p.source.rasterVariant;
        const cacheable = !!cache && !!variant && isEmpty(p.live) && tileScale.scale === p.scale;
        const interval = cacheable ? JSON.stringify([variant, band]) : '';
        if (cacheable && !p.job && !p.cache) {
            cache.bindMemory(host.allocator.cpu);
            if (cache.advanceRevision(p.source.sceneRevision)) {
                const found = cache.borrowAncestor(interval, address);
                if (found) {
                    const exact = found.address.pyramid === address.pyramid && found.address.level === address.level
                        && found.address.x === address.x && found.address.y === address.y;
                    if (exact) {
                        const bitmap = borrowBitmap(found);
                        if (bitmap) put(p, band, null, 'normal', bitmap);
                        advanceTile(p); return;
                    }
                    found.release();
                }
                const ticket = cache.begin(interval, address, p.source.sceneRevision);
                if (!ticket) { p.blocked = true; return; }
                p.cache = { cache, ticket };
            }
        }
        p.job ??= createStreamingDenseTileJob({ open: (apron, signal) => p.source.openTile!(apron, signal),
            rect, scale: p.scale, band, barriers: p.live ?? NO_LIVE, token: p.source.token, revision: p.source.sceneRevision,
            isCurrent: () => !p.retired && resources.frames.isCurrent(p.source), images: p.resources.images,
            host, onError: report });
        p.job.prepare(view, budget);
        if (!p.job.isComplete && !p.job.isEmpty) return;
        const job = p.job, pending = p.cache;
        p.job = null; p.cache = null;
        const parts = job.takeParts();
        const only = parts.length === 1 && parts[0].end === null && parts[0].blend === 'normal' && !parts[0].hasImage ? parts[0] : null;
        if (pending && only) {
            let accepted = false;
            try {
                accepted = pending.cache.publish(pending.ticket, { bitmap: only.bitmap, bytesLease: only.bytesLease, owner: only.owner,
                    rect: only.rect, scale: p.scale });
            } catch (error) { pending.cache.cancel(pending.ticket); releaseDenseTilePart(only); throw error; }
            if (accepted) {
                const found = pending.cache.borrowAncestor(interval, address);
                if (!found || !found.bitmap) { found?.release(); throw new Error('Published dense tile cannot be borrowed'); }
                put(p, band, null, 'normal', borrowBitmap(found)!);
                advanceTile(p); return;
            }
            put(p, band, null, 'normal', toTileBitmap(only));
            advanceTile(p); return;
        }
        if (pending) pending.cache.cancel(pending.ticket);
        for (const part of parts) put(p, band, part.end, part.blend, toTileBitmap(part));
        advanceTile(p);
    };
    const estimateDirect = (p: Plan): boolean => {
        const items = p.source[p.estimateBand];
        if (p.estimateItem === items.length) {
            if (p.estimateBand === 'underlay') { p.estimateBand = 'content'; p.estimateItem = 0; return false; }
            return true;
        }
        const item = items[p.estimateItem];
        if (!p.live?.has(item.nodeId)) { p.estimateItem++; p.estimateClip = p.estimateChunk = 0; return false; }
        if (p.estimateClip < item.clips.length) { p.directEstimate += item.clips[p.estimateClip++].d.length * 80; return false; }
        if (item.kind === 'ink') {
            const chunks = inkCoverageChunks(item.coverage);
            if (p.estimateChunk < chunks.length) {
                const c = chunks[p.estimateChunk++];
                p.directEstimate += (c.segments.length / 6 + c.discs.length / 3) * 40 * 80; return false;
            }
        } else if (item.kind === 'path') p.directEstimate += item.d.length * 80;
        if (!Number.isSafeInteger(p.directEstimate)) throw new RangeError('Dense live path estimate overflows');
        p.estimateItem++; p.estimateClip = p.estimateChunk = 0; return false;
    };
    /** The frame's live items of one band, in canonical order, with each barrier's own tile parts
     * placed before it. Every barrier named by a part must be a live item of this frame. */
    const bandItems = (p: Plan, band: PaintBand): PaintItem[] => {
        const sequence: string[] = [], direct = new Map<string, PaintItem[]>();
        for (const item of p.source[band]) {
            if (!p.live?.has(item.nodeId)) continue;
            let group = direct.get(item.nodeId);
            if (!group) { group = []; direct.set(item.nodeId, group); sequence.push(item.nodeId); }
            group.push(item);
        }
        const buckets = new Map<string | null, Entry[]>();
        for (const entry of p.entries[band]) {
            if (entry.end !== null && !direct.has(entry.end)) throw new Error('Dense tile barrier is missing from the live frame');
            const list = buckets.get(entry.end);
            if (list) list.push(entry); else buckets.set(entry.end, [entry]);
        }
        const image = (entry: Entry): PaintItem => {
            const key = `dense/${++serial}`;
            p.bitmaps.set(key, entry.bitmap);
            const item: PaintImageItem = { kind: 'image', key, geometryKey: key, imageKey: key, nodeId: key,
                localToWorld: [1, 0, 0, 1, 0, 0], clips: [], rect: entry.bitmap.rect,
                sourceRect: { x: 2, y: 2, width: EDGE, height: EDGE }, opacity: 1, blend: entry.blend, inverted: false, retainedTile: true };
            return item;
        };
        const out: PaintItem[] = [];
        for (const id of sequence) {
            for (const entry of buckets.get(id) ?? []) out.push(image(entry));
            out.push(...direct.get(id)!);
        }
        for (const entry of buckets.get(null) ?? []) out.push(image(entry));
        return out;
    };
    const publish = (p: Plan) => {
        const direct = p.directAdapter!.borrowPrepared();
        if (!direct) return;
        const underlay = bandItems(p, 'underlay'), content = bandItems(p, 'content');
        const frame: PaintFrame = { ...p.source, underlay: Object.freeze(underlay), content: Object.freeze(content),
            inkNodeIds: p.sharp ? p.source.inkNodeIds : new FilteredInk(p.source.inkNodeIds, p.live, true) };
        p.prepared = { frame, sourceFrame: p.source, sharp: p.sharp, resources: {
            path: item => direct.resources.path(item), clip: key => direct.resources.clip(key),
            image: key => p.bitmaps.get(key)?.bitmap ?? direct.resources.image(key),
        } };
        p.phase = 'complete'; drop(ready); ready = p; staged = null; resources.invalidate();
    };
    const adapter: CanvasPaintAdapter & {
        prepare(view: ViewState, budget: FrameBudget, liveNodes?: ReadonlySet<string>): void;
        coverage(view: ViewState, liveNodes?: ReadonlySet<string>): { complete: boolean; sharp: boolean; staleVersion?: boolean };
        retainedFrames(): ReadonlySet<PaintFrame>;
        cpuWorkingSet(nativePathUpperBound?: number): number;
    } = {
        prepare(view, budget, liveNodes?: ReadonlySet<string>) {
            if (disposed || lastFrame === budget.frameId) return;
            lastFrame = budget.frameId; denied = false;
            const frame = resources.frames.readFrame();
            if (!frame || !resources.frames.isCurrent(frame)) { drop(staged); staged = null; return; }
            const key = projection(view);
            if (staged && (staged.source !== frame || staged.view !== key || !supportsLive(staged, liveNodes))) { drop(staged); staged = null; }
            const matches = ready?.source === frame && ready.view === key && supportsLive(ready, liveNodes);
            if (matches && ready?.sharp) return;
            try {
                staged ??= start(frame, view, liveNodes, matches);
                const p = staged; if (!p) return;
                p.blocked = false;
                while (!budget.shouldYield() && !p.retired) {
                    if (!resources.frames.isCurrent(frame)) { drop(p); staged = null; return; }
                    if (p.phase === 'tiles') {
                        raster(p, view, budget);
                        if (p.job && !p.job.needsFrame()) return;
                    } else if (p.phase === 'direct') {
                        if (!p.directAdapter) {
                            if (!estimateDirect(p)) continue;
                            const lease = host.allocator.cpu.reserve(Math.max(1, p.directEstimate));
                            if (!lease) { p.blocked = true; return; }
                            p.directLease = lease;
                            const liveFrame: PaintFrame = { ...p.source,
                                underlay: p.source.underlay.filter(item => !!p.live?.has(item.nodeId)),
                                content: p.source.content.filter(item => !!p.live?.has(item.nodeId)) };
                            p.directAdapter = createCanvasPaintAdapter({ ...p.resources, frames: {
                                readFrame: () => liveFrame,
                                isCurrent: candidate => candidate === liveFrame && resources.frames.isCurrent(p.source),
                            } }, (_ctx, _view, paint) => paint(), report);
                        }
                        p.directAdapter.prepare(view, budget);
                        if (!p.directAdapter.borrowPrepared()) return;
                        publish(p); return;
                    } else return;
                    if (p.blocked) return;
                }
            } catch (error) { drop(staged); staged = null; report(error); }
        },
        readyFrame: () => disposed ? null : ready?.source ?? null,
        borrowPrepared: () => disposed ? null : ready?.prepared ?? null,
        draw2d(ctx, view, band, omitNodes) {
            const p = ready, prepared = p?.prepared;
            if (!p || !prepared) return;
            for (const item of prepared.frame[band]) {
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
                const gutter = 2 * scale / sourceScale;
                ctx.save();
                try {
                    ctx.resetTransform(); ctx.beginPath(); ctx.rect(x, y, x1 - x, y1 - y); ctx.clip();
                    ctx.globalAlpha = 1; ctx.globalCompositeOperation = item.blend === 'multiply' ? 'multiply' : 'source-over'; ctx.filter = 'none';
                    ctx.drawImage(bitmap.bitmap, left - gutter, top - gutter, right - left + 2 * gutter, bottom - top + 2 * gutter);
                } finally { ctx.restore(); }
            }
        },
        coverage(view, liveNodes) {
            const complete = !!ready && ready.view === projection(view) && supportsLive(ready, liveNodes);
            return { complete, sharp: complete && !!ready?.sharp, ...(ready?.source !== resources.frames.readFrame() ? { staleVersion: true } : {}) };
        },
        retainedFrames: () => new Set([...plans].map(p => p.source)),
        cpuWorkingSet(nativePathUpperBound = 0) {
            let held = 0; for (const p of plans) held += working(p);
            const pending = !!staged || !ready || !ready.sharp || ready.source !== resources.frames.readFrame() || !resources.frames.isCurrent(ready.source);
            if (!pending) return held;
            return held + (staged?.job ? staged.job.cpuWorkingSet : 2 * 516 * 516 * 4) + BLOCK + nativePathUpperBound
                + (resources.frames.readFrame()?.sessionRasters ? 4096 : 0);
        },
        memory() { let cpuBytes = 0; for (const p of plans) cpuBytes += working(p); return { gpuBytes: 0, cpuBytes }; },
        needsFrame() {
            if (disposed || denied || staged?.blocked) return false;
            if (!staged) return !!ready && !ready.sharp;
            if (staged.job) return staged.job.needsFrame();
            if (staged.directAdapter) return staged.directAdapter.needsFrame();
            return true;
        },
        release(reason: GpuReleaseReason) {
            if (reason === 'context-lost') return;
            drop(staged); drop(ready); staged = ready = null; lastFrame = -1; denied = false;
        },
        dispose() { if (!disposed) { disposed = true; drop(staged); drop(ready); staged = ready = null; } },
    };
    return adapter;
}
