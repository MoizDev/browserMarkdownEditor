import type { Affine, PathCommand, Rect, ViewState } from '../../platform/types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease, GfxDevice, GpuPass, TextureHandle } from '../../platform/render/gfx/api';
import type { FrameBudget, FrameToken, GpuReleaseReason } from '../../platform/render/types';
import { createPathCoverageKit, type PathCoverageAdmission, type PathCoverageRule, type PreparedPathCoverage } from '../../platform/render/pathCoverage';
import { pathFillTriangles } from './pathFillTriangles';
import { pathStrokeTriangles } from './pathStrokeTriangles';
import type { PaintBand } from './material';
import { PaintBoundsJob } from './paintBounds';
import { paintContributions } from './paintContributions';
import { analyticInkPaint, type AnalyticInkPaint } from './analyticInk';
import { isGutterQuadTile, texturedQuad, TILE_EDGE, TILE_GUTTER, TILE_SIZE } from './imageSampling';
import { createAnalyticInkBatch, type PreparedAnalyticInkBatch } from './analyticInkBatch';
import type { PaintFrame, PaintItem, PaintPathItem } from './paintStream';
import type { CanvasPaintAdapter } from './reference/canvasPaintAdapter';
import { paintItem2d } from './reference/paint2d';

const EDGE = TILE_EDGE, GUTTER = TILE_GUTTER, SIZE = TILE_SIZE;
const GPU_BYTES = SIZE * SIZE * 4, CPU_BYTES = GPU_BYTES * 2;
interface CachedTile { texture: TextureHandle; device: GfxDevice; refs: number; key: string; bytes: number }
type Tile = { item: PaintItem; x: number; y: number; cached: CachedTile; multiply: boolean; worldRect?: Readonly<Rect>; analytic?: never; path?: never }
    | { item: PaintItem; x: number; y: number; analytic: AnalyticInkPaint; cached?: never; path?: never }
    | { item: PaintItem; x: number; y: number; path: PreparedPathItem; cached?: never; analytic?: never; multiply?: never; worldRect?: never };
/** One path item's admitted stencil work, in draw order: clip masks, then fill, then stroke. */
interface PreparedPathItem { readonly clips: readonly PreparedPathCoverage[]; readonly fill: PreparedPathCoverage | null; readonly stroke: PreparedPathCoverage | null }
/** Device pixels of flattening error allowed for a stencil-covered path (design §5.1: ≤0.1 px). */
const PATH_FLATTEN_DEVICE_PX = 0.1;
interface AnalyticGroup {
    band: PaintBand; first: number; end: number; paints: AnalyticInkPaint[]; batch: PreparedAnalyticInkBatch | null;
}
interface Plan {
    frame: PaintFrame; sourceFrame: PaintFrame; token: FrameToken; device: GfxDevice; projection: string; scale: number; sharp: boolean;
    x0: number; y0: number; x1: number; y1: number;
    band: PaintBand; item: number; x: number; y: number; tiles: Record<PaintBand, Tile[]>;
    boundsJob: PaintBoundsJob | null; tileBounds: { x0: number; y0: number; x1: number; y1: number } | null; itemKey: string;
    analyticReady: boolean;
    parts: Generator<PaintItem> | null; part: PaintItem | null; partIndex: number; hasMultiply: boolean;
    cpuLeases: ByteLease[]; cpuUsed: number;
    groups: AnalyticGroup[]; groupAt: Record<PaintBand, Map<number, AnalyticGroup>>;
    scanBand: PaintBand; scanIndex: number; scanned: boolean; groupIndex: number; waitingBatch: boolean;
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

const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identity(value: object): number {
    let id = identities.get(value);
    if (id === undefined) {
        if (!Number.isSafeInteger(nextIdentity)) throw new RangeError('Paint identity exhausted');
        id = nextIdentity++; identities.set(value, id);
    }
    return id;
}
function contentKey(item: PaintItem): string {
    const common = [item.kind, item.key, item.geometryKey, item.localToWorld,
        item.clips.map(clip => [clip.key, clip.fillRule, clip.localToWorld, identity(clip.d)])];
    if (item.kind === 'image') return JSON.stringify([common, item.imageKey, item.rect, item.sourceRect, item.opacity, item.blend, item.inverted]);
    if (item.kind === 'text') return JSON.stringify([common, item.paint.key, item.paint.fontEpoch, identity(item.faces), item.material.blend,
        identity(item.material.glyphs), identity(item.material.backgrounds), identity(item.material.decorations)]);
    if (item.kind === 'path') {
        const stroke = item.material.stroke;
        return JSON.stringify([common, item.fillRule, item.material.blend, item.material.fill,
            stroke && [stroke.color, stroke.width, stroke.cap, stroke.join, stroke.miterLimit,
                stroke.dash && [identity(stroke.dash.array), stroke.dash.phase]]]);
    }
    return JSON.stringify([common, item.material.blend, item.material.color]);
}

/** Lower-left corner of the path's control points: local coordinates are rebased here in double
 * precision before any single-precision upload (a conservative bound: control points included). */
function pathOrigin(commands: readonly PathCommand[]): { x: number; y: number } {
    let x = Infinity, y = Infinity;
    for (const command of commands) {
        if (command[0] === 'Z') continue;
        for (let i = 1; i + 1 < command.length; i += 2) {
            x = Math.min(x, command[i] as number); y = Math.min(y, command[i + 1] as number);
        }
    }
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : { x: 0, y: 0 };
}

/** Local to device-pixel affine: the item's world transform, camera and device scale applied once, with
 * the origin rebase folded in. Flattening tolerance is divided by the Frobenius norm of the linear
 * part (at least its spectral norm), so the device error bound holds in every direction. */
function deviceAffine(localToWorld: Affine, origin: { x: number; y: number }, view: ViewState): { affine: Affine; scale: number; norm: number } | null {
    const [a, b, c, d, e, f] = localToWorld;
    const scale = view.camera.z * view.viewport.dpr;
    const norm = Math.hypot(a, b, c, d);
    if (!(norm > 0) || !Number.isFinite(scale) || scale <= 0) return null;
    return { scale, norm, affine: [scale * a, scale * b, scale * c, scale * d,
        scale * (a * origin.x + c * origin.y + e - view.camera.x), scale * (b * origin.x + d * origin.y + f - view.camera.y)] };
}

type PathAdmission = { status: 'ready'; value: PreparedPathItem } | { status: 'empty' | 'denied' | 'unsupported' };

/** Admits one path item's clip masks, fill and stroke, all or nothing: a later refusal retires the
 * earlier admissions, and any unsupported part sends the whole item to the exact canonical raster. */
function admitPathItem(item: PaintPathItem, view: ViewState, kit: ReturnType<typeof createPathCoverageKit>,
    budget: FrameBudget): PathAdmission {
    const viewport = { width: Math.round(view.viewport.width * view.viewport.dpr), height: Math.round(view.viewport.height * view.viewport.dpr) };
    const acquired: PreparedPathCoverage[] = [];
    const fail = (status: 'empty' | 'denied' | 'unsupported'): PathAdmission => {
        for (const prepared of acquired) kit.retire(prepared);
        return { status };
    };
    const clips: PreparedPathCoverage[] = [];
    const place = (result: PathCoverageAdmission): 'ok' | 'empty' | 'denied' | 'unsupported' => {
        if (result.status === 'ready') { acquired.push(result.value); return 'ok'; }
        return result.status;
    };
    for (const clip of item.clips) {
        const origin = pathOrigin(clip.d);
        const frame = deviceAffine(clip.localToWorld, origin, view);
        if (!frame) return fail('unsupported');
        const shapes = pathFillTriangles(clip.d, { tolerance: PATH_FLATTEN_DEVICE_PX / (frame.scale * frame.norm), origin: [origin.x, origin.y] });
        if (!shapes) return fail('unsupported');
        const outcome = place(kit.admit({ shapes, rule: clip.fillRule, affine: frame.affine, viewport, colour: [1, 1, 1, 1],
            output: { kind: 'mask' } }, budget));
        if (outcome === 'empty') return fail('empty');  // a clip that excludes the viewport hides the item
        if (outcome !== 'ok') return fail(outcome as 'denied' | 'unsupported');
        clips.push(acquired[acquired.length - 1]);
    }
    const blend = item.material.blend === 'multiply' ? 'multiply' : 'normal';
    let fill: PreparedPathCoverage | null = null;
    if (item.material.fill) {
        const origin = pathOrigin(item.d);
        const frame = deviceAffine(item.localToWorld, origin, view);
        if (!frame) return fail('unsupported');
        const shapes = pathFillTriangles(item.d, { tolerance: PATH_FLATTEN_DEVICE_PX / (frame.scale * frame.norm), origin: [origin.x, origin.y] });
        if (!shapes) return fail('unsupported');
        const outcome = place(kit.admit({ shapes: { positive: shapes.positive, negative: shapes.negative, edges: shapes.edges, bounds: shapes.bounds },
            rule: item.fillRule, affine: frame.affine, viewport, colour: item.material.fill, output: { kind: 'composite', blend } }, budget));
        if (outcome === 'ok') fill = acquired[acquired.length - 1];
        else if (outcome !== 'empty') return fail(outcome as 'denied' | 'unsupported');
    }
    let stroke: PreparedPathCoverage | null = null;
    const style = item.material.stroke;
    if (style && style.width > 0) {
        const origin = pathOrigin(item.d);
        const frame = deviceAffine(item.localToWorld, origin, view);
        if (!frame) return fail('unsupported');
        const outline = pathStrokeTriangles(item.d, { width: style.width, cap: style.cap, join: style.join, miterLimit: style.miterLimit,
            ...(style.dash ? { dash: style.dash } : {}), tolerance: PATH_FLATTEN_DEVICE_PX / (frame.scale * frame.norm),
            origin: [origin.x, origin.y] });
        if (!outline) return fail('unsupported');
        const outcome = place(kit.admit({ shapes: { positive: outline.triangles, negative: new Float64Array(0), edges: 0, bounds: outline.bounds },
            rule: 'union', affine: frame.affine, viewport, colour: style.color, output: { kind: 'composite', blend } }, budget));
        if (outcome === 'ok') stroke = acquired[acquired.length - 1];
        else if (outcome !== 'empty') return fail(outcome as 'denied' | 'unsupported');
    }
    if (!fill && !stroke) return fail('empty');
    return { status: 'ready', value: { clips, fill, stroke } };
}

/** Draw order inside one item: clip masks render first, then the item's coverage inside the pushed clips. */
function drawPathItem(pass: GpuPass, item: PreparedPathItem, kit: ReturnType<typeof createPathCoverageKit>): void {
    for (const clip of item.clips) kit.drawMask(pass, clip);
    const tokens = item.clips.map(clip => pass.pushClip(clip.clip!));
    try {
        if (item.fill) kit.draw(pass, item.fill);
        if (item.stroke) kit.draw(pass, item.stroke);
    } finally {
        for (let i = tokens.length - 1; i >= 0; i--) pass.popClip(tokens[i]);
    }
}

/** Item-isolated raster tiles preserve ordering and permit exact node omission. */
export function createGpuPaintAdapter(reference: CanvasPaintAdapter, host: LayerHost, report: (error: unknown) => void) {
    let staged: Plan | null = null, ready: Plan | null = null, disposed = false, denied = false;
    let currentToken: FrameToken | null = null, lastFrame = -1, scratch = 0;
    let movingScale = 0, tileBytes = 0;
    const cache = new Map<string, CachedTile>();
    const analytic = createAnalyticInkBatch(host, () => { /* optional pipeline failure keeps canonical coverage tiles */ });
    const pathCoverage = createPathCoverageKit(host, report);
    const retirePathItem = (item: PreparedPathItem) => {
        for (const clip of item.clips) pathCoverage.retire(clip);
        if (item.fill) pathCoverage.retire(item.fill);
        if (item.stroke) pathCoverage.retire(item.stroke);
    };
    const drop = (plan: Plan | null) => {
        if (!plan) return;
        plan.parts?.return(undefined); plan.parts = null; plan.part = null;
        for (const group of plan.groups) {
            if (group.batch) analytic.retire(group.batch); else analytic.cancel(group.paints);
        }
        plan.groups.length = 0;
        for (const band of ['underlay', 'content'] as const) {
            for (const tile of plan.tiles[band]) {
                if (tile.analytic) continue;
                if (tile.path) { retirePathItem(tile.path); continue; }
                const entry = tile.cached;
                if (--entry.refs === 0) { cache.delete(entry.key); tileBytes -= entry.bytes; entry.device.destroy(entry.texture); }
            }
            plan.tiles[band].length = 0; plan.groupAt[band].clear();
        }
        for (const lease of plan.cpuLeases) host.allocator.cpu.release(lease);
        plan.cpuLeases.length = 0;
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
    const ensurePlanCapacity = (plan: Plan): boolean => {
        if (plan.cpuUsed + 512 <= plan.cpuLeases.length * 65_536) return true;
        const lease = host.allocator.cpu.reserve(65_536);
        if (!lease) { denied = true; return false; }
        plan.cpuLeases.push(lease); return true;
    };
    const reset = () => { drop(staged); drop(ready); staged = ready = null; };
    return {
        prepare(view: ViewState, budget: FrameBudget): void {
            if (disposed || lastFrame === budget.frameId) return;
            lastFrame = budget.frameId; currentToken = { ...budget.token };
            analytic.warm();
            const prepared = reference.borrowPrepared(), device = host.device(), demand = view.camera.z * view.viewport.dpr;
            if (!prepared || !device || !documentMatches(prepared.frame, budget.token) || !documentMatches(prepared.sourceFrame ?? prepared.frame, budget.token) || device.generation !== budget.token.deviceGeneration ||
                host.generation !== budget.token.deviceGeneration || !Number.isFinite(demand) || demand <= 0) { reset(); return; }
            const sourceFrame = prepared.sourceFrame ?? prepared.frame;
            const scale = rasterScale(view, demand);
            // One bounded source group and its independently leased real backdrop are reused
            // sequentially; the node/group itself never becomes an isolated-opacity operation.
            if (ready?.hasMultiply || staged?.hasMultiply) host.reserveIsolation({ depth: 1, maskDepth: 0,
                bounds: { x: 0, y: 0, width: Math.min(Math.ceil(view.viewport.width * view.viewport.dpr), Math.ceil(EDGE * demand / scale) + 2),
                    height: Math.min(Math.ceil(view.viewport.height * view.viewport.dpr), Math.ceil(EDGE * demand / scale) + 2) }, multiply: true });
            // A denial suppresses polling via needsFrame(), but a real wake may bring a new grant.
            denied = false;
            if (ready && !validDevice(ready)) { drop(ready); ready = null; denied = false; }
            if (staged && (!valid(staged, view, scale) || (staged.frame !== prepared.frame || staged.sourceFrame !== sourceFrame) || staged.analyticReady !== analytic.ready())) { drop(staged); staged = null; denied = false; }
            if ((ready?.frame === prepared.frame && ready.sourceFrame === sourceFrame && valid(ready, view, scale) && ready.analyticReady === analytic.ready()) || denied) return;
            if (!staged) {
                const x0 = Math.floor(view.camera.x * scale / EDGE), y0 = Math.floor(view.camera.y * scale / EDGE);
                const x1 = Math.ceil((view.camera.x + view.viewport.width / view.camera.z) * scale / EDGE);
                const y1 = Math.ceil((view.camera.y + view.viewport.height / view.camera.z) * scale / EDGE);
                if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Invalid board tile projection');
                staged = { frame: prepared.frame, sourceFrame, token: { ...budget.token }, device, projection: projection(view), scale, sharp: prepared.sharp !== false,
                    x0, y0, x1, y1, band: 'underlay', item: 0, x: x0, y: y0, tiles: { underlay: [], content: [] }, boundsJob: null, tileBounds: null, itemKey: '', analyticReady: analytic.ready(),
                    parts: null, part: null, partIndex: 0, hasMultiply: false, cpuLeases: [], cpuUsed: 0,
                    groups: [], groupAt: { underlay: new Map(), content: new Map() }, scanBand: 'underlay', scanIndex: 0, scanned: false, groupIndex: 0, waitingBatch: false };
            }
            const p = staged;
            try {
                while (!budget.shouldYield()) {
                    const items = p.frame[p.band];
                    if (p.item >= items.length) {
                        if (p.band === 'underlay') { p.band = 'content'; p.item = 0; continue; }
                        while (!p.scanned && !budget.shouldYield()) {
                            const commands = p.tiles[p.scanBand];
                            if (p.scanIndex === commands.length) {
                                if (p.scanBand === 'underlay') { p.scanBand = 'content'; p.scanIndex = 0; continue; }
                                p.scanned = true; break;
                            }
                            const index = p.scanIndex++, command = commands[index];
                            if (!command.analytic) continue;
                            let group = p.groups[p.groups.length - 1];
                            if (!group || group.band !== p.scanBand || group.end !== index) {
                                group = { band: p.scanBand, first: index, end: index, paints: [], batch: null };
                                p.groups.push(group); p.groupAt[p.scanBand].set(index, group);
                            }
                            group.paints.push(command.analytic); group.end++;
                        }
                        if (!p.scanned) return;
                        while (p.groupIndex < p.groups.length && !budget.shouldYield()) {
                            const group = p.groups[p.groupIndex];
                            group.batch = analytic.prepare(group.paints, view, budget);
                            p.waitingBatch = !group.batch;
                            if (!group.batch) return;
                            p.groupIndex++;
                        }
                        if (p.groupIndex !== p.groups.length) return;
                        drop(ready); ready = p; staged = null; return;
                    }
                    const original = items[p.item];
                    if (!p.parts) { p.parts = paintContributions(original); p.partIndex = 0; }
                    if (!p.part) {
                        const next = p.parts.next();
                        if (next.done) { p.parts = null; p.item++; continue; }
                        p.part = next.value; p.partIndex++;
                    }
                    const item = p.part;
                    const multiply = (original.kind === 'image' ? original.blend : original.material.blend) === 'multiply';
                    p.hasMultiply ||= multiply;
                    if (item.kind === 'image' && !multiply && isGutterQuadTile(item)) {
                        const image = prepared.resources.image(item.imageKey);
                        if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap && image.width === SIZE && image.height === SIZE) {
                            if (!ensurePlanCapacity(p)) return;
                            const key = JSON.stringify(['retained', identity(p.sourceFrame), p.token.vaultEpoch, p.token.documentId,
                                p.token.bytesGeneration, p.token.session, p.token.viewLease, p.token.deviceGeneration,
                                EDGE / item.rect.width, identity(image), p.partIndex, contentKey(item)]);
                            let cached = cache.get(key);
                            if (cached) cached.refs++;
                            else {
                                const bytes = image.width * image.height * 4;
                                const lease = host.allocator.gpu.reserve(bytes);
                                if (!lease) { denied = true; return; }
                                if (!budget.claimUpload(bytes)) { host.allocator.gpu.release(lease); return; }
                                let texture: TextureHandle | null = null, attached = false;
                                try {
                                    texture = device.createTexture(image.width, image.height, 'rgba8', ['sample', 'copy-dst'], lease); attached = true;
                                    device.writeTexture(texture, { x: 0, y: 0, width: image.width, height: image.height },
                                        { source: image, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                                    cached = { texture, device, refs: 1, key, bytes };
                                    cache.set(key, cached); tileBytes += bytes; texture = null;
                                } finally {
                                    if (texture) device.destroy(texture);
                                    if (!attached) host.allocator.gpu.release(lease);
                                }
                            }
                            p.tiles[p.band].push({ item: original, x: 0, y: 0, cached, multiply: false, worldRect: item.rect });
                            p.cpuUsed += 512; p.part = null; return;
                        }
                    }
                    if (item.kind === 'path') {
                        if (!ensurePlanCapacity(p)) return;
                        const admission = admitPathItem(item, view, pathCoverage, budget);
                        if (admission.status === 'ready') { p.tiles[p.band].push({ item: original, x: 0, y: 0, path: admission.value }); p.cpuUsed += 512; p.part = null; continue; }
                        if (admission.status === 'empty') { p.part = null; continue; }
                        if (admission.status === 'denied') { denied = true; return; }
                        // 'unsupported': the exact canonical raster route below draws this item.
                    }
                    if (p.analyticReady && !p.tileBounds && item.kind === 'ink' && !multiply) {
                        if (!ensurePlanCapacity(p)) return;
                        const paint = analyticInkPaint(item, view);
                        if (paint) { p.tiles[p.band].push({ item: original, x: 0, y: 0, analytic: paint }); p.cpuUsed += 512; p.part = null; continue; }
                    }
                    if (!p.tileBounds) {
                        p.boundsJob ??= new PaintBoundsJob(item);
                        if (!p.boundsJob.step(1)) continue;
                        const bounds = p.boundsJob.result; p.boundsJob = null;
                        if (!bounds) { p.part = null; continue; }
                        const x0 = Math.max(p.x0, Math.floor((bounds.x * scale - GUTTER) / EDGE));
                        const y0 = Math.max(p.y0, Math.floor((bounds.y * scale - GUTTER) / EDGE));
                        const x1 = Math.min(p.x1, Math.ceil(((bounds.x + bounds.width) * scale + GUTTER) / EDGE));
                        const y1 = Math.min(p.y1, Math.ceil(((bounds.y + bounds.height) * scale + GUTTER) / EDGE));
                        if (x0 >= x1 || y0 >= y1) { p.part = null; continue; }
                        p.tileBounds = { x0, y0, x1, y1 }; p.x = x0; p.y = y0; p.itemKey = `${p.partIndex}:${contentKey(item)}`;
                    }
                    const tileKey = JSON.stringify([p.token.vaultEpoch, p.token.documentId, p.token.bytesGeneration, p.token.session,
                        p.token.viewLease, p.token.deviceGeneration, p.scale, p.x, p.y, p.itemKey]);
                    const existing = cache.get(tileKey);
                    if (!ensurePlanCapacity(p)) return;
                    if (existing) {
                        existing.refs++; p.tiles[p.band].push({ item: original, x: p.x, y: p.y, cached: existing, multiply }); p.cpuUsed += 512;
                        const bounds = p.tileBounds;
                        if (++p.x >= bounds.x1) { p.x = bounds.x0; if (++p.y >= bounds.y1) { p.part = null; p.tileBounds = null; } }
                        return;
                    }
                    const cpu = host.allocator.cpu.reserve(CPU_BYTES);
                    if (!cpu) { denied = true; return; }
                    scratch = cpu.bytes;
                    const gpu = host.allocator.gpu.reserve(GPU_BYTES);
                    if (!gpu) { host.allocator.cpu.release(cpu); scratch = 0; denied = true; return; }
                    if (!budget.claimUpload(GPU_BYTES)) { host.allocator.gpu.release(gpu); host.allocator.cpu.release(cpu); scratch = 0; return; }
                    let canvas: OffscreenCanvas | null = null, bitmap: ImageBitmap | null = null, texture: TextureHandle | null = null;
                    let attached = false;
                    try {
                        canvas = new OffscreenCanvas(SIZE, SIZE);
                        const ctx = canvas.getContext('2d');
                        if (!ctx) throw new Error('Offscreen 2D canvas unavailable');
                        ctx.setTransform(scale, 0, 0, scale, GUTTER - p.x * EDGE, GUTTER - p.y * EDGE);
                        paintItem2d(ctx, item, { ...prepared.resources, path: () => prepared.resources.path(original) });
                        bitmap = canvas.transferToImageBitmap();
                        texture = device.createTexture(SIZE, SIZE, 'rgba8', ['sample', 'copy-dst'], gpu); attached = true;
                        device.writeTexture(texture, { x: 0, y: 0, width: SIZE, height: SIZE },
                            { source: bitmap, premultiplied: true, colorSpace: 'srgb', origin: 'top-left' });
                        const cached: CachedTile = { texture, device, refs: 1, key: tileKey, bytes: GPU_BYTES };
                        cache.set(tileKey, cached); tileBytes += cached.bytes; p.tiles[p.band].push({ item: original, x: p.x, y: p.y, cached, multiply }); p.cpuUsed += 512; texture = null;
                    } finally {
                        bitmap?.close(); if (canvas) { canvas.width = 0; canvas.height = 0; }
                        if (texture) device.destroy(texture);
                        if (!attached) host.allocator.gpu.release(gpu);
                        host.allocator.cpu.release(cpu); scratch = 0;
                    }
                    const bounds = p.tileBounds;
                    if (++p.x >= bounds.x1) { p.x = bounds.x0; if (++p.y >= bounds.y1) { p.part = null; p.tileBounds = null; } }
                    return;
                }
            } catch (error) { drop(staged); drop(ready); staged = ready = null; denied = true; report(error); throw error; }
        },
        readyFrame(): PaintFrame | null { return disposed ? null : ready?.sourceFrame ?? null; },
        readyInkNodeIds(): ReadonlySet<string> | null { return disposed ? null : ready?.frame.inkNodeIds ?? null; },
        coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean } {
            if (!ready || !validDevice(ready)) return { complete: false, sharp: false };
            const complete = ready.projection === projection(view);
            return { complete, sharp: complete && ready.sharp && ready.scale >= view.camera.z * view.viewport.dpr,
                ...(ready.sourceFrame !== reference.readyFrame() ? { staleVersion: true } : {}) };
        },
        drawGpu(pass: GpuPass, view: ViewState, band: PaintBand, omitNodes?: ReadonlySet<string>): void {
            if (!ready || !validDevice(ready)) return;
            const factor = view.camera.z * view.viewport.dpr / ready.scale;
            for (let index = 0; index < ready.tiles[band].length; index++) {
                const group = ready.groupAt[band].get(index);
                if (group) {
                    if (!group.batch) throw new Error('Analytic ink batch is not prepared');
                    analytic.draw(pass, group.batch, view, omitNodes); index = group.end - 1; continue;
                }
                const tile = ready.tiles[band][index];
                if (omitNodes?.has(tile.item.nodeId)) continue;
                if (tile.analytic) throw new Error('Unbatched analytic ink command');
                if (tile.path) { drawPathItem(pass, tile.path, pathCoverage); continue; }
                if (tile.worldRect) {
                    const rect = tile.worldRect, scale = view.camera.z * view.viewport.dpr;
                    const x = (rect.x - view.camera.x) * scale, y = (rect.y - view.camera.y) * scale;
                    const width = rect.width * scale, height = rect.height * scale;
                    const left = Math.max(0, Math.ceil(x - 0.5)), top = Math.max(0, Math.ceil(y - 0.5));
                    const right = Math.min(Math.round(view.viewport.width * view.viewport.dpr), Math.ceil(x + width - 0.5));
                    const bottom = Math.min(Math.round(view.viewport.height * view.viewport.dpr), Math.ceil(y + height - 0.5));
                    if (right <= left || bottom <= top) continue;
                    const clip = pass.pushClip({ x: left, y: top, width: right - left, height: bottom - top });
                    try {
                        // The same quad the presentation facts classify (imageSampling.texturedQuad), gutter included.
                        const quad = texturedQuad({ x: x, y: y, width, height }, SIZE, { x: GUTTER, y: GUTTER, width: EDGE, height: EDGE });
                        host.drawTexturedQuad(pass, tile.cached.texture, { x: 0, y: 0, width: SIZE, height: SIZE },
                            { x: quad.x0, y: quad.y0, width: quad.x1 - quad.x0, height: quad.y1 - quad.y0 },
                            { opacity: 1, sampling: 'linear', coverage: 'none' });
                    } finally { pass.popClip(clip); }
                    continue;
                }
                const source: Rect = { x: GUTTER, y: GUTTER, width: EDGE, height: EDGE };
                const dest: Rect = { x: (tile.x * EDGE - view.camera.x * ready.scale) * factor, y: (tile.y * EDGE - view.camera.y * ready.scale) * factor, width: EDGE * factor, height: EDGE * factor };
                const left = Math.max(0, Math.floor(dest.x)), top = Math.max(0, Math.floor(dest.y));
                const right = Math.min(Math.round(view.viewport.width * view.viewport.dpr), Math.ceil(dest.x + dest.width));
                const bottom = Math.min(Math.round(view.viewport.height * view.viewport.dpr), Math.ceil(dest.y + dest.height));
                if (right <= left || bottom <= top) continue;
                const isolated = tile.multiply ? pass.beginGroup({ x: left, y: top, width: right - left, height: bottom - top },
                    { opacity: 1, blend: 'multiply', colourEffect: 'none' }) : null;
                host.drawTexturedQuad(pass, tile.cached.texture, source, dest, { opacity: 1, sampling: 'linear', coverage: 'none' });
                if (isolated) pass.endGroup(isolated);
            }
        },
        release(_reason: GpuReleaseReason): void { reset(); analytic.release(); pathCoverage.release(); denied = false; currentToken = null; lastFrame = -1; },
        needsFrame(): boolean {
            if (disposed || denied) return false;
            if (staged?.waitingBatch) return analytic.needsFrame();
            return !!staged || !ready || ready.sourceFrame !== reference.readyFrame() || ready.frame !== reference.borrowPrepared()?.frame;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            const batches = analytic.memory();
            return { gpuBytes: tileBytes + batches.gpuBytes + pathCoverage.memory().gpuBytes,
                cpuBytes: scratch + batches.cpuBytes + ((staged?.cpuLeases.length ?? 0) + (ready?.cpuLeases.length ?? 0)) * 65_536 };
        },
        cpuWorkingSet(): { mandatoryBytes: number; prefetchBytes: number } {
            const held = ((staged?.cpuLeases.length ?? 0) + (ready?.cpuLeases.length ?? 0)) * 65_536;
            const nextBatch = staged?.groups[staged.groupIndex]?.paints.length ?? 0;
            return { mandatoryBytes: held + CPU_BYTES + analytic.cpuWorkingSet(nextBatch).mandatoryBytes
                + (staged && staged.cpuUsed + 512 > staged.cpuLeases.length * 65_536 ? 65_536 : 0), prefetchBytes: 0 };
        },
        dispose(): void { if (!disposed) { disposed = true; reset(); analytic.release(); pathCoverage.dispose(); } },
    };
}
