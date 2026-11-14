import type { Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason } from '../../platform/render/types';
import { DenseTileJob, type DenseTileBitmap } from './densePaintAdapter';
import type { PaintBand } from './material';
import { inkCoverageChunks, type PaintFrame, type PaintImageItem, type PaintItem } from './paintStream';
import type { PaintLayerResources } from './resources';
import { chooseTileScale } from './tileHierarchy';
import { createCanvasPaintAdapter, type CanvasPaintAdapter, type PreparedPaint2d } from './reference/canvasPaintAdapter';
import { paintItem2d } from './reference/paint2d';

const EDGE = 512, BITMAP_BYTES = 516 * 516 * 4, BLOCK = 65_536;
type Command = { band: PaintBand; first: number; end: number; direct: boolean };
type Plan = {
    source: PaintFrame; view: string; scale: number; live: ReadonlySet<string> | undefined;
    phase: 'partition' | 'raster' | 'direct' | 'complete'; band: PaintBand; index: number; run: number;
    commands: Command[]; command: number; outputs: Record<PaintBand, PaintItem[]>; direct: Record<PaintBand, PaintItem[]>;
    directAdapter: CanvasPaintAdapter | null; directLease: ByteLease | null; directEstimate: number; directDemandPublished: boolean;
    estimateBand: PaintBand; estimateItem: number; estimateClip: number; estimateChunk: number;
    tile: DenseTileJob | null; tileX: number; tileY: number; x0: number; x1: number; y0: number; y1: number;
    bitmaps: Map<string, DenseTileBitmap>; blocks: ByteLease[]; used: number; pending: number;
    retired: boolean; blocked: boolean; prepared: PreparedPaint2d | null; resources: PaintLayerResources;
};
const projection = (view: ViewState) => [view.camera.x, view.camera.y, view.camera.z,
    view.viewport.width, view.viewport.height, view.viewport.dpr].join(':');
const directItem = (item: PaintItem, live?: ReadonlySet<string>) => live?.has(item.nodeId)
    || (item.kind === 'image' ? item.blend : item.material.blend) !== 'normal';

/** A private ordered-interval replay. Neither its first tile nor one finished band is a frame.
 * Source pins remain the caller's; retainedFrames includes aborted native image acquisitions. */
export function createDensePaintAdapter(resources: PaintLayerResources, host: LayerHost, report: (error: unknown) => void) {
    let staged: Plan | null = null, ready: Plan | null = null, disposed = false, serial = 0;
    let lastFrame = -1;
    const plans = new Set<Plan>();
    const working = (p: Plan) => p.blocks.length * BLOCK + (p.directLease?.bytes ?? 0)
        + p.bitmaps.size * BITMAP_BYTES + (p.tile?.memoryBytes ?? 0);
    const finishRetirement = (p: Plan) => { if (p.retired && !p.pending) plans.delete(p); };
    const drop = (p: Plan | null) => {
        if (!p || p.retired) return;
        p.retired = true;
        p.tile?.cancel(); p.tile = null;
        p.directAdapter?.dispose(); p.directAdapter = null; p.prepared = null;
        for (const bitmap of p.bitmaps.values()) bitmap.release(); p.bitmaps.clear();
        p.commands.length = 0; p.outputs.underlay.length = p.outputs.content.length = 0;
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
    const start = (frame: PaintFrame, view: ViewState, live?: ReadonlySet<string>): Plan => {
        const scale = chooseTileScale(view.camera.z * view.viewport.dpr).scale;
        const side = EDGE / scale;
        const x0 = Math.floor(view.camera.x / side), y0 = Math.floor(view.camera.y / side);
        const x1 = Math.ceil((view.camera.x + view.viewport.width / view.camera.z) / side);
        const y1 = Math.ceil((view.camera.y + view.viewport.height / view.camera.z) / side);
        if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Dense viewport grid overflows');
        const p: Plan = { source: frame, view: projection(view), scale, live, phase: 'partition', band: 'underlay', index: 0, run: 0,
            commands: [], command: 0, outputs: { underlay: [], content: [] }, direct: { underlay: [], content: [] },
            directAdapter: null, directLease: null, directEstimate: 0, directDemandPublished: false, estimateBand: 'underlay', estimateItem: 0, estimateClip: 0, estimateChunk: 0,
            tile: null, tileX: x0, tileY: y0, x0, x1, y0, y1, bitmaps: new Map(), blocks: [], used: 0, pending: 0,
            retired: false, blocked: false, prepared: null, resources };
        p.resources = { ...resources, images: { acquire(key, token, signal) {
            p.pending++;
            let promise;
            try { promise = resources.images.acquire(key, token, signal); }
            catch (error) { p.pending--; finishRetirement(p); throw error; }
            return promise.finally(() => { p.pending--; finishRetirement(p); resources.invalidate(); });
        } } };
        plans.add(p); return p;
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
        const frame: PaintFrame = { ...p.source, underlay: Object.freeze(p.outputs.underlay), content: Object.freeze(p.outputs.content) };
        p.prepared = { frame, sourceFrame: p.source, resources: {
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
                p.commands.push({ band: p.band, first: p.run, end: p.index, direct: false }); p.run = p.index; return;
            }
            if (p.band === 'underlay') { p.band = 'content'; p.run = p.index = 0; }
            else p.phase = 'raster';
            return;
        }
        if (!directItem(items[p.index], p.live)) { p.index++; return; }
        if (p.run < p.index) {
            if (!reserveEntry(p)) return;
            p.commands.push({ band: p.band, first: p.run, end: p.index, direct: false }); p.run = p.index; return;
        }
        if (!reserveEntry(p)) return;
        p.commands.push({ band: p.band, first: p.index, end: p.index + 1, direct: true });
        p.direct[p.band].push(items[p.index]); p.run = ++p.index;
    };
    const raster = (p: Plan, view: ViewState, budget: FrameBudget): void => {
        if (p.command === p.commands.length) { p.phase = 'direct'; return; }
        const command = p.commands[p.command], items = p.source[command.band];
        if (command.direct) { p.outputs[command.band].push(items[command.first]); p.command++; return; }
        const side = EDGE / p.scale;
        const rect: Rect = { x: p.tileX * side, y: p.tileY * side, width: side, height: side };
        p.tile ??= new DenseTileJob(p.resources, host, report, p.source, items, rect, p.scale, command);
        p.tile.prepare(view, budget);
        if (!p.tile.isEmpty) {
            if (!p.tile.isComplete) return;
            const bitmap = p.tile.result;
            if (!reserveEntry(p)) return;
            const key = `dense/${++serial}`;
            const image: PaintImageItem = { kind: 'image', key, geometryKey: key, imageKey: key, nodeId: key,
                localToWorld: [1, 0, 0, 1, 0, 0], clips: [], rect: bitmap.rect,
                sourceRect: { x: 2, y: 2, width: EDGE, height: EDGE }, opacity: 1, blend: 'normal', inverted: false, retainedTile: true };
            p.bitmaps.set(key, bitmap); p.outputs[command.band].push(image);
        }
        p.tile = null;
        if (++p.tileX === p.x1) { p.tileX = p.x0; if (++p.tileY === p.y1) { p.tileY = p.y0; p.command++; } }
    };
    const adapter: CanvasPaintAdapter & {
        prepare(view: ViewState, budget: FrameBudget, liveNodes?: ReadonlySet<string>): void;
        coverage(view: ViewState, liveNodes?: ReadonlySet<string>): { complete: boolean; sharp: boolean; staleVersion?: boolean };
        retainedFrames(): ReadonlySet<PaintFrame>;
        cpuWorkingSet(): number;
    } = {
        prepare(view, budget, liveNodes?: ReadonlySet<string>) {
            if (disposed || lastFrame === budget.frameId) return;
            lastFrame = budget.frameId;
            const frame = resources.frames.readFrame();
            if (!frame || !resources.frames.isCurrent(frame)) { drop(staged); staged = null; return; }
            const key = projection(view);
            if (staged && (staged.source !== frame || staged.view !== key || staged.live !== liveNodes)) { drop(staged); staged = null; }
            if (ready?.source === frame && ready.view === key && ready.live === liveNodes) return;
            try {
                staged ??= start(frame, view, liveNodes);
                const p = staged; p.blocked = false;
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
                    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
                    ctx.drawImage(bitmap.bitmap, left - gutter, top - gutter, right - left + 2 * gutter, bottom - top + 2 * gutter);
                } finally { ctx.restore(); }
            }
        },
        coverage(view, liveNodes) {
            const complete = !!ready && ready.view === projection(view) && ready.live === liveNodes;
            return { complete, sharp: complete, ...(ready?.source !== resources.frames.readFrame() ? { staleVersion: true } : {}) };
        },
        retainedFrames: () => new Set([...plans].map(p => p.source)),
        cpuWorkingSet() {
            let held = 0; for (const p of plans) held += working(p);
            return held + (staged?.tile ? Math.max(0, staged.tile.cpuWorkingSet - staged.tile.memoryBytes) : 2 * BITMAP_BYTES)
                + (staged && !staged.directAdapter ? staged.directEstimate : 0) + BLOCK;
        },
        memory() { let cpuBytes = 0; for (const p of plans) cpuBytes += working(p); return { gpuBytes: 0, cpuBytes }; },
        needsFrame() {
            if (disposed || !staged || staged.blocked) return false;
            if (staged.tile) return staged.tile.needsFrame();
            if (staged.directAdapter) return staged.directAdapter.needsFrame();
            return true;
        },
        release(reason: GpuReleaseReason) {
            if (reason === 'context-lost') return;
            drop(staged); drop(ready); staged = ready = null; lastFrame = -1;
        },
        dispose() { if (!disposed) { disposed = true; drop(staged); drop(ready); staged = ready = null; } },
    };
    return adapter;
}
