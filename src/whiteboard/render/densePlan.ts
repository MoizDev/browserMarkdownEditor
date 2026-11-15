import type { Rect, ViewState } from '../../platform/types';
import { nextDown, nextUp } from '../geom/numeric';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason } from '../../platform/render/types';
import { DenseTileJob, type DenseTileBitmap } from './densePaintAdapter';
import type { PaintBand } from './material';
import type { Blend } from './colour';
import { inkCoverageChunks, type PaintFrame, type PaintImageItem, type PaintItem } from './paintStream';
import type { PaintLayerResources } from './resources';
import { chooseTileScale, type TileAddress } from './tileHierarchy';
import type { DenseRasterBorrow, DenseRasterTicket, SessionDenseRasters } from './sessionDenseRasters';
import { PaintBoundsCache } from './paintBoundsCache';
import { FilteredInk } from './nodeSets';
import { createCanvasPaintAdapter, type CanvasPaintAdapter, type PreparedPaint2d } from './reference/canvasPaintAdapter';
import { paintItem2d } from './reference/paint2d';

const EDGE = 512, BITMAP_BYTES = 516 * 516 * 4, BLOCK = 65_536;
type Command = { band: PaintBand; first: number; end: number; direct: boolean; blend: Blend; hasImage: boolean };
type Plan = {
    source: PaintFrame; view: string; scale: number; sharp: boolean; live: ReadonlySet<string> | undefined;
    bounds: PaintBoundsCache;
    phase: 'partition' | 'raster' | 'direct' | 'complete'; band: PaintBand; index: number; run: number; runHasImage: boolean;
    commands: Command[]; command: number; outputs: Record<PaintBand, PaintItem[]>; direct: Record<PaintBand, PaintItem[]>;
    directAdapter: CanvasPaintAdapter | null; directLease: ByteLease | null; directEstimate: number; directDemandPublished: boolean;
    estimateBand: PaintBand; estimateItem: number; estimateClip: number; estimateChunk: number;
    tile: DenseTileJob | null; tileX: number; tileY: number; x0: number; x1: number; y0: number; y1: number;
    bitmaps: Map<string, DenseTileBitmap>; bitmapBytes: number; blocks: ByteLease[]; used: number; pending: number;
    cacheTicket: { cache: SessionDenseRasters; ticket: DenseRasterTicket } | null;
    retired: boolean; blocked: boolean; prepared: PreparedPaint2d | null; resources: PaintLayerResources;
};
const projection = (view: ViewState) => [view.camera.x, view.camera.y, view.camera.z,
    view.viewport.width, view.viewport.height, view.viewport.dpr].join(':');
const supportsLive = (plan: Plan, live?: ReadonlySet<string>): boolean => {
    if (plan.live === live || !live) return true;
    for (const id of live) if (!plan.live?.has(id)) return false;
    return true;
};
const blendOf = (item: PaintItem): Blend => item.kind === 'image' ? item.blend : item.material.blend;
const directItem = (item: PaintItem, live?: ReadonlySet<string>) => !!live?.has(item.nodeId);

/** A private ordered-interval replay. Neither its first tile nor one finished band is a frame.
 * Source pins remain the caller's; retainedFrames includes aborted native image acquisitions. */
export function createDensePaintAdapter(resources: PaintLayerResources, host: LayerHost, report: (error: unknown) => void) {
    let staged: Plan | null = null, ready: Plan | null = null, disposed = false, denied = false, serial = 0;
    let lastFrame = -1;
    const plans = new Set<Plan>();
    const working = (p: Plan) => p.blocks.length * BLOCK + (p.directLease?.bytes ?? 0)
        + p.bitmapBytes + (p.tile?.memoryBytes ?? 0) + p.bounds.memoryBytes;
    const finishRetirement = (p: Plan) => { if (p.retired && !p.pending) plans.delete(p); };
    const drop = (p: Plan | null) => {
        if (!p || p.retired) return;
        p.retired = true;
        p.tile?.cancel(); p.tile = null;
        if (p.cacheTicket) { p.cacheTicket.cache.cancel(p.cacheTicket.ticket); p.cacheTicket = null; }
        p.bounds.dispose();
        p.directAdapter?.dispose(); p.directAdapter = null; p.prepared = null;
        for (const bitmap of p.bitmaps.values()) bitmap.release(); p.bitmaps.clear(); p.bitmapBytes = 0;
        p.commands.length = 0;
        // Published arrays are immutable and may still be borrowed by the preceding GPU plan.
        p.outputs = { underlay: [], content: [] };
        p.direct.underlay.length = p.direct.content.length = 0;
        if (p.directLease) { host.allocator.cpu.release(p.directLease); p.directLease = null; }
        for (const block of p.blocks) host.allocator.cpu.release(block); p.blocks.length = 0;
        finishRetirement(p);
    };
    const reserveEntry = (p: Plan): boolean => {
        if (p.used + 512 > p.blocks.length * BLOCK) {
            const lease = host.allocator.cpu.reserve(BLOCK);
            if (!lease) { p.blocked = true; return false; }
            p.blocks.push(lease);
        }
        p.used += 512; return true;
    };
    const start = (frame: PaintFrame, view: ViewState, live: ReadonlySet<string> | undefined, fine: boolean): Plan | null => {
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
                bounds: new PaintBoundsCache(host.allocator.cpu), phase: 'partition', band: 'underlay', index: 0, run: 0, runHasImage: false,
                commands: [], command: 0, outputs: { underlay: [], content: [] }, direct: { underlay: [], content: [] },
                directAdapter: null, directLease: null, directEstimate: 0, directDemandPublished: false, estimateBand: 'underlay', estimateItem: 0, estimateClip: 0, estimateChunk: 0,
                tile: null, tileX: x0, tileY: y0, x0, x1, y0, y1, bitmaps: new Map(), bitmapBytes: 0, cacheTicket: null, blocks: [lease], used: 512, pending: 0,
                retired: false, blocked: false, prepared: null, resources };
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
    const estimateDirect = (p: Plan): boolean => {
        const items = p.direct[p.estimateBand];
        if (p.estimateItem === items.length) {
            if (p.estimateBand === 'underlay') { p.estimateBand = 'content'; p.estimateItem = 0; return false; }
            return true;
        }
        const item = items[p.estimateItem];
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
    const publish = (p: Plan) => {
        const direct = p.directAdapter!.borrowPrepared();
        if (!direct) return;
        const frame: PaintFrame = { ...p.source, underlay: Object.freeze(p.outputs.underlay), content: Object.freeze(p.outputs.content),
            inkNodeIds: p.sharp ? p.source.inkNodeIds : new FilteredInk(p.source.inkNodeIds, p.live, true) };
        p.prepared = { frame, sourceFrame: p.source, sharp: p.sharp, resources: {
            path: item => direct.resources.path(item), clip: key => direct.resources.clip(key),
            image: key => p.bitmaps.get(key)?.bitmap ?? direct.resources.image(key),
        } };
        p.phase = 'complete'; drop(ready); ready = p; staged = null; resources.invalidate();
    };
    const partition = (p: Plan): void => {
        const items = p.source[p.band];
        if (p.index === items.length) {
            if (p.run < p.index) {
                if (!reserveEntry(p)) return;
                p.commands.push({ band: p.band, first: p.run, end: p.index, direct: false, blend: blendOf(items[p.run]), hasImage: p.runHasImage }); p.run = p.index; p.runHasImage = false; return;
            }
            if (p.band === 'underlay') { p.band = 'content'; p.run = p.index = 0; }
            else p.phase = 'raster';
            return;
        }
        // Multiply composes associatively in (premultiplied RGB + transparency, transparency),
        // so only contiguous multiply paints may share a transparent tile and one backdrop multiply.
        const item = items[p.index], direct = directItem(item, p.live);
        if (p.run < p.index && (direct || blendOf(items[p.run]) !== blendOf(item))) {
            if (!reserveEntry(p)) return;
            p.commands.push({ band: p.band, first: p.run, end: p.index, direct: false, blend: blendOf(items[p.run]), hasImage: p.runHasImage }); p.run = p.index; p.runHasImage = false; return;
        }
        if (!direct) { p.runHasImage ||= item.kind === 'image'; p.index++; return; }
        if (!reserveEntry(p)) return;
        p.commands.push({ band: p.band, first: p.index, end: p.index + 1, direct: true, blend: blendOf(item), hasImage: item.kind === 'image' });
        p.direct[p.band].push(items[p.index]); p.run = ++p.index;
    };
    const borrowBitmap = (borrow: DenseRasterBorrow): DenseTileBitmap | null => {
        if (!borrow.bitmap) { borrow.release(); return null; }
        return { bitmap: borrow.bitmap, rect: borrow.rect, memoryBytes: 0, release: () => borrow.release() };
    };
    const putBitmap = (p: Plan, command: Command, bitmap: DenseTileBitmap) => {
        const key = `dense/${++serial}`;
        const image: PaintImageItem = { kind: 'image', key, geometryKey: key, imageKey: key, nodeId: key,
            localToWorld: [1, 0, 0, 1, 0, 0], clips: [], rect: bitmap.rect,
            sourceRect: { x: 2, y: 2, width: EDGE, height: EDGE }, opacity: 1, blend: command.blend, inverted: false, retainedTile: true };
        p.bitmaps.set(key, bitmap); p.bitmapBytes += bitmap.memoryBytes; p.outputs[command.band].push(image);
    };
    const fullSourceTile = (source: Readonly<Rect> | undefined, rect: Rect, scale: number): boolean => {
        if (!source) return true;
        const apron = nextUp(2 / scale);
        return source.x <= nextDown(rect.x - apron) && source.y <= nextDown(rect.y - apron) &&
            nextDown(source.x + source.width) >= nextUp(nextUp(rect.x + rect.width) + apron) &&
            nextDown(source.y + source.height) >= nextUp(nextUp(rect.y + rect.height) + apron);
    };
    const raster = (p: Plan, view: ViewState, budget: FrameBudget): void => {
        if (p.command === p.commands.length) { p.phase = 'direct'; return; }
        const command = p.commands[p.command], items = p.source[command.band];
        if (command.direct) { p.outputs[command.band].push(items[command.first]); p.command++; return; }
        const side = EDGE / p.scale;
        const rect: Rect = { x: p.tileX * side, y: p.tileY * side, width: side, height: side };
        const cache = p.source.sessionRasters, variant = p.source.rasterVariant;
        const tileScale = chooseTileScale(p.scale);
        const eligible = !!cache && !!variant && !command.hasImage && (!p.live || p.live.values().next().done === true) &&
            tileScale.scale === p.scale && fullSourceTile(p.source.sourceWorld, rect, p.scale);
        const address: TileAddress = { pyramid: tileScale.pyramid, level: tileScale.level, x: p.tileX, y: p.tileY };
        const interval = eligible ? JSON.stringify([variant, command.band, command.blend, items[command.first].nodeId, items[command.first].key,
            items[command.end - 1].nodeId, items[command.end - 1].key, command.end - command.first]) : '';
        if (eligible && !p.tile && !p.cacheTicket) {
            cache.bindMemory(host.allocator.cpu);
            if (cache.advanceRevision(p.source.sceneRevision)) {
                const found = cache.borrowAncestor(interval, address);
                if (found) {
                    const exact = found.address.pyramid === address.pyramid && found.address.level === address.level && found.address.x === address.x && found.address.y === address.y;
                    if (exact) {
                        if (found.bitmap && !reserveEntry(p)) { found.release(); return; }
                        const bitmap = borrowBitmap(found);
                        if (bitmap) putBitmap(p, command, bitmap);
                        if (++p.tileX === p.x1) { p.tileX = p.x0; if (++p.tileY === p.y1) { p.tileY = p.y0; p.command++; } }
                        return;
                    }
                    found.release();
                }
                const ticket = cache.begin(interval, address, p.source.sceneRevision);
                if (!ticket) { p.blocked = true; return; }
                p.cacheTicket = { cache, ticket };
            }
        }
        p.tile ??= new DenseTileJob(p.resources, host, report, p.source, items, rect, p.scale, command, p.bounds, command.blend);
        p.tile.prepare(view, budget);
        if (!p.tile.isEmpty) {
            if (!p.tile.isComplete) return;
            if (!reserveEntry(p)) return;
            let bitmap = p.tile.result;
            if (p.cacheTicket) {
                const owned = bitmap.takeOwnership?.(), pending = p.cacheTicket; p.cacheTicket = null;
                if (owned) {
                    let accepted: boolean;
                    try { accepted = pending.cache.publish(pending.ticket, { ...owned, rect: bitmap.rect, scale: p.scale }); }
                    catch (error) {
                        pending.cache.cancel(pending.ticket);
                        try { owned.bitmap.close(); } finally { owned.owner.release(owned.bytesLease); }
                        throw error;
                    }
                    if (accepted) {
                        const found = pending.cache.borrowAncestor(interval, address);
                        if (!found || !found.bitmap) { found?.release(); throw new Error('Published dense tile cannot be borrowed'); }
                        bitmap = borrowBitmap(found)!;
                    } else {
                        let held = true;
                        bitmap = { bitmap: owned.bitmap, rect: bitmap.rect, memoryBytes: owned.bytesLease.bytes, release: () => {
                            if (!held) return; held = false;
                            try { owned.bitmap.close(); } finally { owned.owner.release(owned.bytesLease); }
                        } };
                    }
                } else pending.cache.cancel(pending.ticket);
            }
            putBitmap(p, command, bitmap);
        } else if (p.cacheTicket) { p.cacheTicket.cache.cancel(p.cacheTicket.ticket); p.cacheTicket = null; }
        p.tile = null;
        if (++p.tileX === p.x1) { p.tileX = p.x0; if (++p.tileY === p.y1) { p.tileY = p.y0; p.command++; } }
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
                    if (p.phase === 'partition') partition(p);
                    else if (p.phase === 'raster') {
                        raster(p, view, budget);
                        if (p.tile && !p.tile.needsFrame()) return;
                    } else if (p.phase === 'direct') {
                        if (!p.directAdapter) {
                            if (!estimateDirect(p)) continue;
                            if (!p.directDemandPublished && p.directEstimate) {
                                p.directDemandPublished = true; host.invalidate('dense-live-demand-ready'); return;
                            }
                            const lease = host.allocator.cpu.reserve(Math.max(1, p.directEstimate));
                            if (!lease) { p.blocked = true; return; }
                            p.directLease = lease;
                            const directFrame: PaintFrame = { ...p.source, underlay: p.direct.underlay, content: p.direct.content };
                            p.directAdapter = createCanvasPaintAdapter({ ...p.resources, frames: {
                                readFrame: () => directFrame,
                                isCurrent: candidate => candidate === directFrame && resources.frames.isCurrent(p.source),
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
                    host.paintWorld(ctx, view, () => paintItem2d(ctx, item, prepared.resources)); continue;
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
            return held + (staged?.tile ? Math.max(0, staged.tile.cpuWorkingSet - staged.tile.memoryBytes) : 2 * BITMAP_BYTES)
                + Math.max(0, (staged?.bounds.cpuWorkingSet ?? 0) - (staged?.bounds.memoryBytes ?? 0))
                + (staged && !staged.directAdapter ? staged.directEstimate : 0) + BLOCK + nativePathUpperBound
                + (resources.frames.readFrame()?.sessionRasters ? 4096 : 0);
        },
        memory() { let cpuBytes = 0; for (const p of plans) cpuBytes += working(p); return { gpuBytes: 0, cpuBytes }; },
        needsFrame() {
            if (disposed || denied || staged?.blocked) return false;
            if (!staged) return !!ready && !ready.sharp;
            if (staged.tile) return staged.tile.needsFrame();
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
