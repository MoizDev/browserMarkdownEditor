// The board's tile composer. A tile is one slice of one position of one band at one scale: its parts are composed on
// the GPU by the item routes into a render target, and the frame lays each target on the surface as a quad. Design:
// planning/60-implementation/gpu-handoff/PLAN.md §3.1 (scale policy, slices, compose limit, dirty, stand-ins).
// The routes, the tile store and the parts index are injected, so this module imports no route and no store.
import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice, GpuPass, GroupToken, RectI, RgbaP, TextureHandle } from '../../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason, OffscreenPasses } from '../../../platform/render/types';
import { tileTargetBytes, tileView } from '../../../platform/render/tileTarget';
import { auditCount, auditStage, renderAuditEnabled, type AuditStage } from '../../../platform/render/renderAudit';
import { TILE_EDGE, TILE_GUTTER, TILE_SIZE } from '../imageSampling';
import type { PaintBand } from '../material';
import type { PaintClip, PaintInkItem, PaintItem } from '../paintStream';
import type { AdmitClips, PreparedClips } from './routePath';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';
import type { PaintResources2d } from '../reference/paint2d';
import type {
    Blend, InkRouteFor, ItemRoute, PreparedRun, TileEntry, TileIdFn, TileKey, TileParts, TilePart, TileStore, TileWorldFn,
} from './contracts';

const EDGE = TILE_EDGE, GUTTER = TILE_GUTTER, SIZE = TILE_SIZE;
const BANDS: readonly PaintBand[] = ['underlay', 'content'];
const SQRT2 = Math.SQRT2;
const TARGET_BYTES = tileTargetBytes(SIZE);
const CLEAR: RgbaP = [0, 0, 0, 0], WHITE: RgbaP = [1, 1, 1, 1];
/** The texture's interior. The gutter is composed (so edges are right) and never drawn. */
const CROP: Readonly<Rect> = Object.freeze({ x: GUTTER, y: GUTTER, width: EDGE, height: EDGE });
const GROUP = Object.freeze({ opacity: 1, blend: 'multiply', colourEffect: 'none' } as const);
const NO_OPAQUE: readonly Rect[] = Object.freeze([]);

/** Draws `draw` under prepared clips (masks and scissors); the route's own helper, injected. */
export type WithPreparedClips = (pass: GpuPass, prepared: PreparedClips, draw: () => void) => void;
/** The kind of a run's items, or 'mixed' when a run holds more than one kind. */
function kindOf(items: readonly PaintItem[]): string {
    const kind = items[0].kind;
    return items.every(item => item.kind === kind) ? kind : 'mixed';
}
/** One stage's wall time, read only while the render audit is on. */
function timedStage<T>(surface: string, stage: AuditStage, fn: () => T): T {
    if (!renderAuditEnabled()) return fn();
    const t0 = performance.now();
    try { return fn(); } finally { auditStage(surface, stage, performance.now() - t0); }
}

/** How a composed slice reaches the surface. `over` is alpha-blended; `modulate` multiplies the surface by the tile
 * (fixed-function, so no backdrop copy); `isolated` is an over-composed tile laid by a multiply group, used where the
 * backdrop under it is not opaque (a multiply over transparency is not a multiply). */
type Mode = 'over' | 'modulate' | 'isolated';
/** A position's status at a scale: `missing` has no complete picture; `dirty` shows a picture a change has overtaken. */
type Status = 'missing' | 'dirty' | 'ok';
/** Per composed entry, kept beside the store so a store entry that is evicted and replaced starts with no slot. */
interface Slot { readonly mode: Mode; readonly count: number }
/** A consecutive run of one route's items within a slice. A run the CPU route takes (a GPU route refused it, or it has no route
 * yet, or its clips were refused) carries `why` and `label`, and is counted once as a fallback. A clipped item (on a route that
 * does not clip itself) is a run of its own: its clips are admitted in prepare, into `prepared`, and drawn around its draw. */
interface Run {
    readonly items: PaintItem[]; route: ItemRoute;
    /** The item's clips still to admit; null once admitted, or for a route that clips itself or the CPU route. */
    clips: readonly PaintClip[] | null;
    prepared: PreparedClips | null;
    why: string | null; label: string | null; counted: boolean;
}
interface Admitted { readonly route: ItemRoute; readonly run: PreparedRun; readonly clips: PreparedClips | null }
/** One slice of a position: what its target draws, in paint order, and how far its admission has got. */
interface Slice {
    readonly key: TileKey;
    readonly id: string;
    readonly mode: Mode;
    /** The blend the content is composed with: `modulate` only for a modulate slice, which is laid by fixed-function blending. */
    readonly blend: Blend;
    readonly view: ViewState;
    readonly runs: Run[];
    next: number;
    readonly admitted: Admitted[];
    entry: TileEntry | null;
}
/** A position being composed. The cursor is the first slice that is not yet admitted and acquired. */
interface Position {
    readonly band: PaintBand;
    readonly scale: number;
    readonly x: number;
    readonly y: number;
    readonly slices: Slice[];
    cursor: number;
}
/** Tile positions across a view, as integer coordinates with exclusive ends. */
interface Span { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
/** One tile to lay this frame. Pooled: a steady frame rewrites its fields and allocates nothing. */
interface Draw {
    band: PaintBand; texture: TextureHandle; mode: Mode;
    /** The tile's interior, in world units. */
    x: number; y: number; w: number; h: number;
    /** A stand-in is clipped to the position it covers; device pixels. */
    clipOn: boolean; cx: number; cy: number; cw: number; ch: number;
}

/** The item routes a composer draws through. `cpu` takes what a GPU route refuses; its own counters name that raster. */
export interface TileRoutes {
    readonly path: ItemRoute;
    readonly inkAnalytic: ItemRoute<PaintInkItem>;
    readonly inkUnion: ItemRoute<PaintInkItem>;
    /** Absent until the route is built: its items are then rastered by `cpu`, counted as a fallback. */
    readonly image?: ItemRoute;
    readonly text?: ItemRoute;
    readonly cpu: ItemRoute;
}
/** A route that needs the paint's resources (decoded images, path and clip geometry); called once per paint, before admit. */
export interface ResourcedRoute { useResources?(resources: PaintResources2d): void }
/** Lays a composed texture on the current surface. `modulate` multiplies the surface by it; `dest` is in device pixels. */
export type TileLay = (pass: GpuPass, texture: TextureHandle, source: Readonly<Rect>, dest: Readonly<Rect>, blend: Blend) => void;

export interface TileComposerOptions {
    readonly host: LayerHost;
    readonly audit: string;
    readonly parts: TileParts;
    readonly store: TileStore;
    readonly routes: TileRoutes;
    readonly tileId: TileIdFn;
    readonly tileWorld: TileWorldFn;
    readonly inkRouteFor: InkRouteFor;
    readonly lay: TileLay;
    /** Admits an item's clips in prepare (rectangles as scissors, others as masks), and draws under them. The composer owns
     * clipping for every route but the path route, which clips its own items. */
    readonly admitClips: AdmitClips;
    readonly withPreparedClips: WithPreparedClips;
    /** Rects whose surface is opaque. A modulate slice inside one is laid by `modulate`; elsewhere it is isolated. */
    readonly opaqueWorld?: () => readonly Rect[];
    /** True while the governor reports a slow GPU: the compose limit halves. */
    readonly slowGpu?: () => boolean;
}

export interface TileComposer {
    /** Indexes `prepared`, composes what the view needs within the frame's limit, and fixes what this frame draws. `null`
     * (nothing presented) draws nothing. `omit` is the nodes a drag previews elsewhere: their tiles are composed without them. */
    prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): void;
    /** Encodes the composed targets of one band; the frame's surface pass then draws them with `drawGpu`. */
    encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void;
    /** Lays the frame's tiles of one band. Draws only: no allocation, no upload, no readback. */
    drawGpu(pass: GpuPass, view: ViewState, band: PaintBand): void;
    coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean };
    /** False while nothing can make progress this frame: composed and settled, or waiting for memory. */
    needsFrame(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    release(reason: GpuReleaseReason): void;
    dispose(): void;
}

/** The exact tile scale for a demand: device pixels per world unit, rounded so a return to a zoom reuses its tiles. */
function exactScale(demand: number): number {
    return Number(demand.toPrecision(12));
}
/** The √2 ladder level at or above a demand: the scale a zoom composes at. */
function ladderScale(demand: number): number {
    return Math.pow(SQRT2, Math.ceil(Math.log(demand) / Math.log(SQRT2)));
}
/** Cuts a position's parts, in paint order, wherever the blend changes. */
function cutSlices(parts: readonly TilePart[]): { blend: Blend; parts: TilePart[] }[] {
    const out: { blend: Blend; parts: TilePart[] }[] = [];
    for (const part of parts) {
        const last = out[out.length - 1];
        if (last && last.blend === part.blend) last.parts.push(part);
        else out.push({ blend: part.blend, parts: [part] });
    }
    return out;
}
function covers(outer: Readonly<Rect>, inner: Readonly<Rect>): boolean {
    return outer.x <= inner.x && outer.y <= inner.y
        && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}
function sameOmit(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
    if (!a || !b) return a === b;
    if (a.size !== b.size) return false;
    for (const id of b) if (!a.has(id)) return false;
    return true;
}
function spanAt(view: ViewState, scale: number): Span {
    const { camera: c, viewport: v } = view;
    const x0 = Math.floor(c.x * scale / EDGE), y0 = Math.floor(c.y * scale / EDGE);
    const x1 = Math.ceil((c.x + v.width / c.z) * scale / EDGE), y1 = Math.ceil((c.y + v.height / c.z) * scale / EDGE);
    if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Invalid board tile projection');
    return { x0, y0, x1, y1 };
}
function inSpan(span: Span, x: number, y: number): boolean {
    return x >= span.x0 && x < span.x1 && y >= span.y0 && y < span.y1;
}

export function createTileComposer(options: TileComposerOptions): TileComposer {
    const { host, audit, parts, store, routes, tileId, tileWorld, inkRouteFor, lay, admitClips, withPreparedClips } = options;
    const routeList: ItemRoute[] = [routes.path, routes.inkAnalytic, routes.inkUnion, routes.image, routes.text, routes.cpu]
        .filter((route): route is ItemRoute => route !== undefined);
    let resourcesSeen: PaintResources2d | null = null;
    // Slots live beside their entries (keyed by the entry object), so an entry the store drops takes its slot with it.
    const slots = new WeakMap<TileEntry, Slot>();
    // Positions being admitted, by key. A finished position waits in `finished` for its band's encode.
    const building = new Map<string, Position>();
    let finished: Position[] = [];
    const draws: Draw[] = [];
    let drawCount = 0;

    let disposed = false, presenting = false, indexing = false;
    let denied = false, settled = false, preparedSharp = true;
    let device: GfxDevice | null = null;
    let frame = 0, validRevision = 0;
    let omitIds: ReadonlySet<string> | null = null;
    let lastZoom: number | undefined, zoomScale = 0;
    // The scale the last prepare composed and drew. Coverage describes this scale, not the exact demand: a zoom draws its
    // ladder scale, and coverage asked about the exact one, where nothing is composed, so every frame of a zoom read incomplete.
    let drawnTarget = 0;

    const wake = (): void => { host.invalidate('tile-composer-capacity'); };
    const refuseTarget = (): void => { denied = true; auditCount(audit, 'tile:denied'); store.wait(TARGET_BYTES, wake); };
    const refuseAdmission = (pool: 'gpu' | 'cpu', bytes: number): void => {
        denied = true; auditCount(audit, 'tile:denied');
        if (pool === 'gpu') store.wait(bytes, wake); else host.allocator.cpu.whenAvailable?.(wake);
    };

    const keyOf = (band: PaintBand, scale: number, x: number, y: number, slice: number): TileKey => ({ band, scale, x, y, slice });
    const idOf = (band: PaintBand, scale: number, x: number, y: number, slice: number): string => tileId(keyOf(band, scale, x, y, slice));
    const positionKey = (band: PaintBand, scale: number, x: number, y: number): string => `${band}|${scale}|${x}|${y}`;

    /** A position's status at a scale, from its slices: every slice present, none overtaken by a change. */
    const statusAt = (band: PaintBand, scale: number, x: number, y: number): Status => {
        const first = store.get(idOf(band, scale, x, y, 0));
        const slot = first && slots.get(first);
        if (!first || !slot) return 'missing';
        let dirty = first.dirty;
        for (let s = 1; s < slot.count; s++) {
            const entry = store.get(idOf(band, scale, x, y, s));
            if (!entry) return 'missing';
            dirty ||= entry.dirty;
        }
        return dirty ? 'dirty' : 'ok';
    };

    /** Composed tiles of the nearest other scale that cover a position, every slice of them, in slice order. */
    const standInsOf = (band: PaintBand, scale: number, x: number, y: number): TileEntry[] => {
        const world: Rect = { x: x * EDGE / scale, y: y * EDGE / scale, width: EDGE / scale, height: EDGE / scale };
        const list = store.standIns(band, world, scale);
        if (!list.length) return [];
        const nearest = list[0].key.scale;
        return list.filter(entry => entry.key.scale === nearest && entry.target !== null)
            .sort((a, b) => a.key.x - b.key.x || a.key.y - b.key.y || a.key.slice - b.key.slice);
    };

    /** The GPU route for an item, or the CPU route with the reason no GPU route takes it. */
    const routeOf = (item: PaintItem): { route: ItemRoute; why: string | null } => {
        const kind = item.kind;
        const gpu: ItemRoute | undefined = kind === 'path' ? routes.path : kind === 'image' ? routes.image
            : kind === 'text' ? routes.text : inkRouteFor(item) === 'ink-union' ? routes.inkUnion : routes.inkAnalytic;
        if (!gpu) return { route: routes.cpu, why: `${kind}-route-absent` };
        if (!gpu.accepts(item)) return { route: routes.cpu, why: `${kind}-not-accepted` };
        return { route: gpu, why: null };
    };
    const runsOf = (list: readonly TilePart[]): Run[] => {
        const runs: Run[] = [];
        for (const part of list) {
            const item = part.item;
            const { route, why } = routeOf(item);
            // The path route clips its own items and the CPU raster paints them with theirs; any other route's clips are the
            // composer's, admitted per item in prepare.
            const clips = item.clips.length && route !== routes.path && route !== routes.cpu ? item.clips : null;
            const last = runs[runs.length - 1];
            if (last && last.route === route && last.why === why && !last.clips && !clips) last.items.push(item);
            else runs.push({ items: [item], route, clips, prepared: null, why, label: null, counted: false });
        }
        return runs;
    };
    /** Counts a run the CPU route rasters, once: one scrap per run, so one count per raster. */
    const countFallback = (run: Run): void => {
        if (run.counted || run.why === null) return;
        run.counted = true;
        auditCount(audit, `fallback:item-cpu:${run.label ?? kindOf(run.items)}:${run.why}`, 1, { px: SIZE * SIZE });
    };
    /** Hands a run to the CPU route for good, with its reason; any clips it had admitted are released (the raster paints them). */
    const toCpu = (run: Run, why: string, label: string | null): void => {
        run.prepared?.retire();
        run.prepared = null; run.clips = null;
        run.route = routes.cpu; run.why = why; run.label = label;
        countFallback(run);
    };

    /** Admits a slice's runs in order: a run's clips first, then its items. 'deferred' resumes next frame, with the clips it has
     * already admitted; a refusal names its pool and bytes. A run whose clips exclude the view is hidden, which is not a fallback. */
    const admitSlice = (slice: Slice, budget: FrameBudget): 'ok' | 'deferred' | { pool: 'gpu' | 'cpu'; bytes: number } => {
        while (slice.next < slice.runs.length) {
            const run = slice.runs[slice.next];
            if (run.clips && !run.prepared) {
                const clipped = admitClips(run.clips, slice.view, budget);
                if (clipped.status === 'deferred') return 'deferred';
                if (clipped.status === 'denied') return { pool: clipped.pool, bytes: clipped.bytes };
                if (clipped.status === 'empty') { run.clips = null; slice.next++; continue; }
                if (clipped.status === 'unsupported') toCpu(run, clipped.why, 'clip');
                else { run.prepared = clipped.value; run.clips = null; }
            }
            countFallback(run);
            let outcome = run.route.admit(run.items, slice.view, slice.blend, budget);
            if (outcome.status === 'unsupported') {
                // A GPU route that refuses a run hands it to the CPU route for good, with the reason (the raster paints its clips).
                toCpu(run, outcome.why, null);
                outcome = run.route.admit(run.items, slice.view, slice.blend, budget);
            }
            switch (outcome.status) {
                case 'ready': slice.admitted.push({ route: run.route, run: outcome.value, clips: run.prepared }); run.prepared = null; slice.next++; break;
                case 'empty': run.prepared?.retire(); run.prepared = null; slice.next++; break;
                case 'deferred': return 'deferred';
                case 'denied': return { pool: outcome.pool, bytes: outcome.bytes };
                case 'unsupported': throw new Error(`CPU route refused a ${run.items[0]?.kind ?? 'paint'} item: ${outcome.why}`);
            }
        }
        return 'ok';
    };

    /** Starts a position. A position with no parts is marked present at once, with no target, and returns null. */
    const begin = (band: PaintBand, scale: number, x: number, y: number, view: ViewState): Position | null => {
        const key0 = keyOf(band, scale, x, y, 0);
        const interior = tileWorld(key0);
        const pad = GUTTER / scale;
        const gutter: Rect = { x: interior.x - pad, y: interior.y - pad, width: interior.width + 2 * pad, height: interior.height + 2 * pad };
        const cut = cutSlices(parts.partsFor(band, gutter, omitIds ?? undefined));
        if (!cut.length) {
            const entry = store.putEmpty(key0);
            slots.set(entry, { mode: 'over', count: 0 });
            auditCount(audit, 'tile:empty');
            return null;
        }
        const opaque = options.opaqueWorld?.() ?? NO_OPAQUE;
        const tile = tileView(gutter.x, gutter.y, scale, SIZE, view.epoch);
        const onOpaque = opaque.some(rect => covers(rect, interior));
        const slices = cut.map((group, s): Slice => {
            const mode: Mode = group.blend === 'over' ? 'over' : onOpaque ? 'modulate' : 'isolated';
            const key = keyOf(band, scale, x, y, s), id = tileId(key);
            // A dirty entry is recomposed into the target it already has; a missing one is acquired once its content is admitted.
            const existing = store.get(id);
            return {
                key, id, mode, blend: mode === 'modulate' ? 'modulate' : 'over', view: tile, runs: runsOf(group.parts),
                next: 0, admitted: [], entry: existing && existing.target ? existing : null,
            };
        });
        return { band, scale, x, y, slices, cursor: 0 };
    };

    /** Admits and acquires a position's slices in order. 'wait' resumes next frame; 'denied' waits for memory. */
    const advance = (position: Position, budget: FrameBudget, gpu: GfxDevice): 'done' | 'wait' | 'denied' => {
        for (; position.cursor < position.slices.length; position.cursor++) {
            const slice = position.slices[position.cursor];
            if (slice.next < slice.runs.length) {
                const outcome = timedStage(audit, 'admit', () => admitSlice(slice, budget));
                if (outcome === 'deferred') return 'wait';
                if (outcome !== 'ok') { refuseAdmission(outcome.pool, outcome.bytes); return 'denied'; }
            }
            if (!slice.entry) {
                const entry = store.acquire(slice.key, slice.blend, gpu);
                if (!entry) { refuseTarget(); return 'denied'; }
                slice.entry = entry;
            }
        }
        return 'done';
    };

    /** Releases what a position admitted; its acquired targets stay in the store, still missing their slots. */
    const cancel = (position: Position): void => {
        for (const slice of position.slices) {
            for (const run of slice.runs) { run.prepared?.retire(); run.prepared = null; }
            for (const { route, run, clips } of slice.admitted) { route.retire(run); clips?.retire(); }
            slice.admitted.length = 0;
        }
    };

    /** The compose pass of one frame, in priority order: dirty visible positions, then missing visible ones, then the
     * missing positions one ring outside the view. The frame's limit is the number of tiles it may compose. */
    const compose = (view: ViewState, budget: FrameBudget, gpu: GfxDevice, target: number, span: Span, zooming: boolean, demand: number): void => {
        let limit = view.moving ? 2 : 8;
        if (options.slowGpu?.()) limit = Math.max(1, limit >> 1);
        let composed = 0;
        // While zooming, a missing position may wait for a stand-in that is at most 2× magnified (the stand-in is drawn meanwhile).
        const magnifiedAtMost2 = (band: PaintBand, x: number, y: number): boolean => {
            const list = standInsOf(band, target, x, y);
            return list.length > 0 && list[0].key.scale >= demand / 2;
        };
        for (const pass of ['dirty', 'missing', 'ring'] as const) {
            const margin = pass === 'ring' ? 1 : 0;
            for (const band of BANDS) {
                for (let y = span.y0 - margin; y < span.y1 + margin; y++) {
                    for (let x = span.x0 - margin; x < span.x1 + margin; x++) {
                        const visible = inSpan(span, x, y);
                        if (pass === 'ring' ? visible : !visible) continue;
                        const key = positionKey(band, target, x, y);
                        let position = building.get(key);
                        if (!position) {
                            const status = statusAt(band, target, x, y);
                            if (pass === 'dirty' ? status !== 'dirty' : status !== 'missing') continue;
                            if (pass !== 'dirty' && zooming && magnifiedAtMost2(band, x, y)) continue;
                            const started = begin(band, target, x, y, view);
                            if (!started) continue;
                            position = started;
                            building.set(key, position);
                        }
                        // Why a frame composes nothing is the zoom question: each exit is counted (pass and cause).
                        if (composed >= limit) { auditCount(audit, `compose:limit:${pass}`); return; }
                        if (budget.shouldYield()) { auditCount(audit, `compose:yield:${pass}`); return; }
                        const outcome = advance(position, budget, gpu);
                        if (outcome !== 'done') { auditCount(audit, `compose:${outcome}:${pass}`); return; }
                        auditCount(audit, `compose:done:${pass}`);
                        building.delete(key);
                        finished.push(position);
                        composed += position.slices.length;
                    }
                }
            }
        }
    };

    const addDraw = (band: PaintBand, entry: TileEntry, slot: Slot, clip: Rect | null): void => {
        const target = entry.target;
        if (!target) return;
        const world = tileWorld(entry.key);
        let draw = draws[drawCount];
        if (!draw) {
            draw = { band, texture: target.texture, mode: slot.mode, x: 0, y: 0, w: 0, h: 0, clipOn: false, cx: 0, cy: 0, cw: 0, ch: 0 };
            draws.push(draw);
        }
        drawCount++;
        draw.band = band; draw.texture = target.texture; draw.mode = slot.mode;
        draw.x = world.x; draw.y = world.y; draw.w = world.width; draw.h = world.height;
        draw.clipOn = clip !== null;
        if (clip) { draw.cx = clip.x; draw.cy = clip.y; draw.cw = clip.width; draw.ch = clip.height; }
        if (draw.mode === 'isolated') auditCount(audit, 'isolation:copy');
        store.touch(entry, frame);
    };

    /** This frame's draws, per band. A band whose visible positions all have their exact tile swaps to them in one frame;
     * until then (and while zooming) each position shows its exact tile if it has one, else a stand-in clipped to it. */
    const buildDraws = (view: ViewState, target: number, zooming: boolean): void => {
        const surfaceW = Math.round(view.viewport.width * view.viewport.dpr), surfaceH = Math.round(view.viewport.height * view.viewport.dpr);
        drawCount = 0;
        const cam = view.camera, scale = cam.z * view.viewport.dpr;
        const span = spanAt(view, target);
        for (const band of BANDS) {
            let complete = true;
            for (let y = span.y0; y < span.y1 && complete; y++) {
                for (let x = span.x0; x < span.x1 && complete; x++) if (statusAt(band, target, x, y) === 'missing') complete = false;
            }
            if (!zooming && complete) store.dropScalesExcept(target, band);
            for (let y = span.y0; y < span.y1; y++) {
                for (let x = span.x0; x < span.x1; x++) {
                    const status = statusAt(band, target, x, y);
                    const exact = status !== 'missing' && (zooming || complete || standInsOf(band, target, x, y).length === 0);
                    if (exact) {
                        const first = store.get(idOf(band, target, x, y, 0));
                        const count = (first && slots.get(first)?.count) ?? 0;
                        for (let s = 0; s < count; s++) {
                            const entry = store.get(idOf(band, target, x, y, s));
                            const slot = entry && slots.get(entry);
                            if (entry && slot) addDraw(band, entry, slot, null);
                        }
                        auditCount(audit, 'tile:hit');
                        continue;
                    }
                    // The stand-in's clip is the part of its position on the surface: a scissor outside the surface, or with a
                    // negative origin, is refused by the device (measured: 'invalid-input' on open).
                    const left = Math.max(0, Math.round((x * EDGE / target - cam.x) * scale)), top = Math.max(0, Math.round((y * EDGE / target - cam.y) * scale));
                    const right = Math.min(surfaceW, Math.round(((x + 1) * EDGE / target - cam.x) * scale));
                    const bottom = Math.min(surfaceH, Math.round(((y + 1) * EDGE / target - cam.y) * scale));
                    if (right <= left || bottom <= top) continue;
                    const clip: Rect = { x: left, y: top, width: right - left, height: bottom - top };
                    for (const entry of standInsOf(band, target, x, y)) {
                        const slot = slots.get(entry);
                        if (slot) addDraw(band, entry, slot, clip);
                    }
                    auditCount(audit, 'tile:standin');
                }
            }
        }
    };

    /** Every visible position of both bands has its exact tile at `exact`, or no content: the band's picture is current. */
    const allExact = (view: ViewState, exact: number): boolean => {
        const span = spanAt(view, exact);
        for (const band of BANDS) {
            for (let y = span.y0; y < span.y1; y++) {
                for (let x = span.x0; x < span.x1; x++) if (statusAt(band, exact, x, y) !== 'ok') return false;
            }
        }
        return true;
    };

    const encodePosition = (passes: OffscreenPasses, position: Position): void => {
        for (const slice of position.slices) {
            const entry = slice.entry;
            if (entry && entry.target && store.get(slice.id) === entry) {
                const target = entry.target;
                const pass = passes.begin(target.target, { x: 0, y: 0, width: target.size, height: target.size },
                    { clear: slice.blend === 'modulate' ? WHITE : CLEAR, stencil: false });
                for (const { route, run, clips } of slice.admitted) {
                    timedStage(audit, 'draw', () => {
                        if (clips) withPreparedClips(pass, clips, () => route.draw(pass, run));
                        else route.draw(pass, run);
                    });
                    auditCount(audit, `route:${route.id}`);
                }
                pass.end();
                auditCount(audit, 'tile:compose', 1, { px: target.size * target.size });
                entry.dirty = false; entry.composed = true; entry.revision = validRevision;
                slots.set(entry, { mode: slice.mode, count: position.slices.length });
                store.touch(entry, frame);
            }
            for (const { route, run, clips } of slice.admitted) { route.retire(run); clips?.retire(); }
            slice.admitted.length = 0;
        }
    };

    const releaseAll = (): void => {
        for (const position of building.values()) cancel(position);
        building.clear();
        for (const position of finished) cancel(position);
        finished = [];
        drawCount = 0;
        store.releaseAll();
        for (const route of routeList) route.release();
        denied = false; settled = false; presenting = false;
    };

    return {
        prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): void {
            if (disposed) return;
            frame = budget.frameId;
            denied = false; settled = false;
            // A position finished and never encoded (its band was not encoded this frame) is begun again from its admissions.
            for (const position of finished) cancel(position);
            finished = [];
            const demand = view.camera.z * view.viewport.dpr;
            device = host.device();
            if (!prepared || !device || !(demand > 0) || !Number.isFinite(demand)) {
                drawCount = 0; presenting = false; return;
            }
            presenting = true;
            preparedSharp = prepared.sharp !== false;
            if (prepared.resources !== resourcesSeen) {
                resourcesSeen = prepared.resources;
                for (const route of routeList) (route as ItemRoute & ResourcedRoute).useResources?.(prepared.resources);
            }
            // The scale moves only with the camera's zoom: a pan or a drag keeps the tiles' scale and their pixels.
            const zooming = lastZoom !== undefined && view.camera.z !== lastZoom;
            lastZoom = view.camera.z;
            if (!zooming) zoomScale = 0;
            else if (!(zoomScale >= demand && zoomScale <= demand * 1.2 * SQRT2)) zoomScale = ladderScale(demand);
            const exact = exactScale(demand);
            const target = zooming ? zoomScale : exact;
            drawnTarget = target;

            indexing = !parts.sync(prepared, budget);
            if (!indexing) {
                let invalidated = false;
                const changes = parts.takeChanges();
                if (changes === 'all') { store.markDirty('all'); invalidated = true; }
                else if (changes.length) { for (const rect of changes) store.markDirty(rect); invalidated = true; }
                validRevision = prepared.root.sceneRevision;
                // A node a drag omits leaves the tiles it painted: its old bounds are recomposed once, when the set changes.
                const nextOmit = omit && omit.size ? omit : null;
                if (!sameOmit(omitIds, nextOmit)) {
                    const diff = new Set<string>();
                    for (const id of omitIds ?? []) if (!nextOmit?.has(id)) diff.add(id);
                    for (const id of nextOmit ?? []) if (!omitIds?.has(id)) diff.add(id);
                    for (const rect of parts.boundsOfNodes(diff)) store.markDirty(rect);
                    omitIds = nextOmit ? new Set(nextOmit) : null;
                    invalidated = true;
                }
                // A position admitted against the old content or omission would be encoded stale (it is not in the store
                // yet, so markDirty cannot reach it): every position in progress restarts when either changes.
                const span = spanAt(view, target);
                const ring: Span = { x0: span.x0 - 1, y0: span.y0 - 1, x1: span.x1 + 1, y1: span.y1 + 1 };
                for (const [key, position] of building) {
                    if (!invalidated && position.scale === target && inSpan(ring, position.x, position.y)) continue;
                    cancel(position); building.delete(key);
                }
                if (device) compose(view, budget, device, target, span, zooming, demand);
            }
            buildDraws(view, target, zooming);
            settled = !indexing && allExact(view, target);
        },
        encodeOffscreen(passes: OffscreenPasses, _view: ViewState, band: PaintBand): void {
            if (!finished.length) return;
            let kept = 0;
            for (const position of finished) {
                if (position.band !== band) { finished[kept++] = position; continue; }
                encodePosition(passes, position);
            }
            finished.length = kept;
        },
        drawGpu(pass: GpuPass, view: ViewState, band: PaintBand): void {
            if (!drawCount) return;
            const cam = view.camera, scale = cam.z * view.viewport.dpr;
            const surfaceW = Math.round(view.viewport.width * view.viewport.dpr), surfaceH = Math.round(view.viewport.height * view.viewport.dpr);
            // Scratch rectangles, rewritten per draw: the pass reads them before this loop moves on.
            const dest: Rect = { x: 0, y: 0, width: 0, height: 0 };
            const scissor: RectI = { x: 0, y: 0, width: 0, height: 0 };
            const bounds: RectI = { x: 0, y: 0, width: 0, height: 0 };
            for (let i = 0; i < drawCount; i++) {
                const draw = draws[i];
                if (draw.band !== band) continue;
                dest.x = (draw.x - cam.x) * scale; dest.y = (draw.y - cam.y) * scale;
                dest.width = draw.w * scale; dest.height = draw.h * scale;
                // A draw wholly off the surface draws nothing; it is skipped before any clip or group is pushed.
                if (dest.x + dest.width <= 0 || dest.y + dest.height <= 0 || dest.x >= surfaceW || dest.y >= surfaceH) continue;
                let clip: ReturnType<GpuPass['pushClip']> | null = null;
                if (draw.clipOn) {
                    scissor.x = draw.cx; scissor.y = draw.cy; scissor.width = draw.cw; scissor.height = draw.ch;
                    clip = pass.pushClip(scissor);
                }
                let group: GroupToken | null = null;
                if (draw.mode === 'isolated') {
                    // A group's bounds are on the surface too: a negative origin is refused like a negative scissor.
                    bounds.x = Math.max(0, Math.floor(dest.x)); bounds.y = Math.max(0, Math.floor(dest.y));
                    bounds.width = Math.min(surfaceW, Math.ceil(dest.x + dest.width)) - bounds.x;
                    bounds.height = Math.min(surfaceH, Math.ceil(dest.y + dest.height)) - bounds.y;
                    group = pass.beginGroup(bounds, GROUP);
                }
                lay(pass, draw.texture, CROP, dest, draw.mode === 'modulate' ? 'modulate' : 'over');
                if (group) pass.endGroup(group);
                if (clip) pass.popClip(clip);
            }
        },
        coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean } {
            if (!presenting) return { complete: false, sharp: false };
            const exact = exactScale(view.camera.z * view.viewport.dpr);
            const target = drawnTarget;
            const span = spanAt(view, target);
            // A position with any picture (its tile at the drawn scale, a dirty one, or a stand-in of another scale) is
            // complete; only a position with nothing is not. Sharp needs the drawn scale to be the demanded one, and every
            // position exact and clean there.
            let complete = true, sharp = !indexing && preparedSharp && target === exact, stale = indexing;
            for (const band of BANDS) {
                for (let y = span.y0; y < span.y1; y++) {
                    for (let x = span.x0; x < span.x1; x++) {
                        const status = statusAt(band, target, x, y);
                        if (status === 'ok') continue;
                        sharp = false;
                        if (status === 'dirty') { stale = true; continue; }
                        if (!standInsOf(band, target, x, y).length) complete = false;
                    }
                }
            }
            return { complete, sharp: complete && sharp, ...(stale ? { staleVersion: true } : {}) };
        },
        needsFrame(): boolean {
            if (disposed || denied || !presenting) return false;
            return indexing || !settled || building.size > 0 || finished.length > 0;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            const own = store.memory();
            let gpuBytes = own.gpuBytes, cpuBytes = own.cpuBytes;
            for (const route of routeList) { const m = route.memory(); gpuBytes += m.gpuBytes; cpuBytes += m.cpuBytes; }
            return { gpuBytes, cpuBytes };
        },
        release(_reason: GpuReleaseReason): void { releaseAll(); },
        dispose(): void {
            if (disposed) return;
            releaseAll();
            disposed = true;
        },
    };
}
