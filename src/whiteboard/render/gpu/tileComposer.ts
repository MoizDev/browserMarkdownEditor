// The board's tile composer. A tile is one slice of one position of one band at one scale: its parts are composed on
// the GPU by the item routes into a render target, and the frame lays each target on the surface as a quad. Design:
// planning/60-implementation/gpu-handoff/PLAN.md §3.1 (scale policy, slices, compose limit, dirty, stand-ins).
// The routes, the tile store and the parts index are injected, so this module imports no route and no store.
import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost, TexturedQuadSpec } from '../../../platform/render/compositor.types';
import type { GfxDevice, GpuPass, GroupToken, RectI, RgbaP, TextureHandle } from '../../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason, OffscreenPasses } from '../../../platform/render/types';
import { tileTargetBytes, tileView } from '../../../platform/render/tileTarget';
import { auditCount, auditDrawn, auditStage, renderAuditEnabled, type AuditStage } from '../../../platform/render/renderAudit';
import { TILE_EDGE, TILE_GUTTER, TILE_SIZE } from '../imageSampling';
import type { PaintBand } from '../material';
import type { PaintClip, PaintInkItem, PaintItem } from '../paintStream';
import type { AdmitClips, PreparedClips } from './routePath';
import { tileKeyNum, TileKeyMap } from './tileKeys';
import { lowerTileKey, type NumericTileStore } from './tileStore';
import { blendOf, OmitTracker } from './tileParts';
import { VIDEO_FRAME_PREFIX } from '../../media/videoFrames';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';
import type { PaintResources2d } from '../reference/paint2d';
import type {
    Blend, InkRouteFor, ItemRoute, PreparedRun, TileEntry, TileKey, TileParts, TilePart, TileWorldFn,
} from './contracts';

const EDGE = TILE_EDGE, GUTTER = TILE_GUTTER, SIZE = TILE_SIZE;
const BANDS: readonly PaintBand[] = ['underlay', 'content'];
const TARGET_BYTES = tileTargetBytes(SIZE);
/** The bytes a refused position at rest asks its own store to free: a few targets, not the whole store. */
const FREE_FOR_REFUSAL = 8 * TARGET_BYTES;
/** A visible position refused a GPU admission retries at this deadline: the pool can change with no release that reaches the waiter
 * (gpu-h3's stall, two runs in ten). The deadline only invalidates; the retry runs in the frame it wakes, after the governor is asked. */
const GPU_RETRY_MS = 250;
/** The retry backs off from GPU_RETRY_MS to this, doubling per miss, so a pool that stays full costs a few frames, not four a second. */
const GPU_RETRY_MAX_MS = 4000;
/** Misses with no capacity change before the retries stop: the position then waits for the governor's wake (a real capacity change),
 * not a timer. A refusal the pool can never admit is counted (compose:retry:stopped) and draws its stand-in. */
const GPU_RETRY_LIMIT = 12;
const CLEAR: RgbaP = [0, 0, 0, 0], WHITE: RgbaP = [1, 1, 1, 1];
/** The texture's interior. The gutter is composed (so edges are right) and never drawn. */
const CROP: Readonly<Rect> = Object.freeze({ x: GUTTER, y: GUTTER, width: EDGE, height: EDGE });
const GROUP = Object.freeze({ opacity: 1, blend: 'multiply', colourEffect: 'none' } as const);
/** The most quads one batched call draws: 32 bytes each (8 floats), so 4096 is 128 KiB, a quarter of the 1 MiB uniform slot. */
const QUAD_BATCH = 4096;
const NO_IDS: readonly string[] = Object.freeze([]);
const NO_ORDERS: readonly number[] = Object.freeze([]);
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

/** A stable small number per object, for the draw signature: a texture or route is named by identity, not by its contents. */
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const idOfObject = (object: object | null): number => {
    if (!object) return 0;
    let id = objectIds.get(object);
    if (id === undefined) { id = nextObjectId++; objectIds.set(object, id); }
    return id;
};
const hashMix = (hash: number, value: number): number => Math.imul(hash ^ value, 16777619);
const hashText = (text: string): number => { let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = hashMix(hash, text.charCodeAt(i)); return hash; };
/** A position's status at a scale: `missing` has no complete picture; `dirty` shows a picture a change has overtaken. */
type Status = 'missing' | 'dirty' | 'ok';
/** Per composed entry, kept beside the store so a store entry that is evicted and replaced starts with no slot. */
interface Slot {
    readonly mode: Mode; readonly count: number; readonly inkNodes: readonly string[];
    /** The paint order of each slice's first part, by slice: a live part paints between the slices its order falls between. */
    readonly firstOrder: readonly number[];
    /** The position's live parts (video pictures drawn each frame, never composed). */
    readonly live: number;
    /** The tile holds geometry (a path or ink route's content): a zoom draws it at the exact scale each frame. */
    readonly geometry: boolean;
    /** The tile holds CPU raster content: a zoom never composes it again, since the CPU route would raster it afresh each frame. */
    readonly cpu: boolean;
}
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
    readonly mode: Mode;
    /** The blend the content is composed with: `modulate` only for a modulate slice, which is laid by fixed-function blending. */
    readonly blend: Blend;
    readonly view: ViewState;
    readonly runs: Run[];
    /** The ink nodes of this slice's parts: drawn into the composite's drawn-ink set with the tile. */
    readonly inkNodes: readonly string[];
    /** The paint order of the slice's first part. */
    readonly firstOrder: number;
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
    /** Refused by a pool: not advanced again until the governor's wake (no per-frame retry of a refusal). */
    parked: boolean;
    /** A visible position the governor refused, composed one level down (half the scale) until the store admits it. */
    lowered: boolean;
    /** The position's packed building key (tileKeys.ts). */
    readonly key: number;
    /** Live parts among the position's parts: they are drawn each frame, not composed. */
    readonly live: number;
}
/** Tile positions across a view, as integer coordinates with exclusive ends. */
interface Span { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
/** One tile to lay this frame. Pooled: a steady frame rewrites its fields and allocates nothing. */
interface Draw {
    band: PaintBand; texture: TextureHandle | null; mode: Mode;
    /** The tile's interior, in world units. */
    x: number; y: number; w: number; h: number;
    /** A stand-in is clipped to the position it covers; device pixels. */
    clipOn: boolean; cx: number; cy: number; cw: number; ch: number;
    /** The ink nodes of the tile, added to the drawn-ink set when the draw is laid. */
    ink: readonly string[];
    /** A live part's admitted run and the route that admitted it, drawn under the clip; null for a tile draw. */
    live: PreparedRun | null;
    liveRoute: ItemRoute | null;
}

/** A live part admitted for this frame: its run and the route that owns it, retired by that route. */
interface LiveAdmission { readonly route: ItemRoute; readonly run: PreparedRun }

/** The item routes a composer draws through. `cpu` takes what a GPU route refuses; its own counters name that raster. */
export interface TileRoutes {
    readonly path: ItemRoute;
    readonly inkAnalytic: ItemRoute<PaintInkItem>;
    readonly inkUnion: ItemRoute<PaintInkItem>;
    /** Absent until the route is built: its items are then rastered by `cpu`, counted as a fallback. */
    readonly image?: ItemRoute;
    readonly text?: ItemRoute & ZoomRoute;
    readonly cpu: ItemRoute;
}
/** The text route's zoom hooks (gpu-h8). `setZoom` is called once per frame before the admits: while it is true a missing exact mask is
 * drawn from its cached stand-in, never rastered. `exact` is false for a run that drew one: its tile recomposes exact once the camera rests. */
export interface ZoomRoute { setZoom(zooming: boolean): void; exact(run: PreparedRun): boolean }
/** A route that needs the paint's resources (decoded images, path and clip geometry); called once per paint, before admit. */
export interface ResourcedRoute { useResources?(resources: PaintResources2d): void }
/** Lays a composed texture on the current surface. `modulate` multiplies the surface by it; `dest` is in device pixels. */
export type TileLay = (pass: GpuPass, texture: TextureHandle, source: Readonly<Rect>, dest: Readonly<Rect>, blend: Blend) => void;
/** Lays a batch of 'over' quads of one tile texture in one call (the host's batched quads, one GPU draw). */
export type TileLayQuads = (pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[]) => void;

export interface TileComposerOptions {
    readonly host: LayerHost;
    readonly audit: string;
    readonly parts: TileParts;
    readonly store: NumericTileStore;
    readonly routes: TileRoutes;
    readonly tileWorld: TileWorldFn;
    readonly inkRouteFor: InkRouteFor;
    readonly lay: TileLay;
    readonly layQuads: TileLayQuads;
    /** Admits an item's clips in prepare (rectangles as scissors, others as masks), and draws under them. The composer owns
     * clipping for every route but the path route, which clips its own items. */
    readonly admitClips: AdmitClips;
    readonly withPreparedClips: WithPreparedClips;
    /** Rects whose surface is opaque. A modulate slice inside one is laid by `modulate`; elsewhere it is isolated. */
    readonly opaqueWorld?: () => readonly Rect[];
    /** True while the governor reports a slow GPU: the compose limit halves. */
    readonly slowGpu?: () => boolean;
    /** An overlay (a drag's preview): a paint of a few plain 'over' parts is drawn live each frame at the view, with no tiles, so
     * no tile grant can stall it. A paint over the threshold, or with a part that needs tiles, composes tiles as before. */
    readonly liveOverlay?: boolean;
}

export interface TileComposer {
    /** Indexes `prepared`, composes what the view needs within the frame's limit, and fixes what this frame draws. `null`
     * (nothing presented) draws nothing. `omit` is the nodes a drag previews elsewhere: their tiles are composed without them. */
    /** Prepares one frame. True when anything visible changed since the previous call: a position composed, cancelled or dropped, a
     * store slot freed for it, an invalidation, an index still settling, or a different draw list. False only when the frame draws
     * exactly what the previous one drew. The caller must still treat a frame it did not present as changed. */
    prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): boolean;
    /** Encodes the composed targets of one band; the frame's surface pass then draws them with `drawGpu`. */
    encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void;
    /** Lays the frame's tiles of one band. Draws only: no allocation, no upload, no readback. */
    drawGpu(pass: GpuPass, view: ViewState, band: PaintBand): void;
    coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean };
    /** The ids whose every visible position is composed exactly at the drawn scale (no stand-in, no dirty tile, no index in
     * progress). The board shows a wet stroke until its node is in this set, so committed and wet ink overlap, never gap. */
    inkComposed(view: ViewState, ids: ReadonlySet<string>): Set<string>;
    /** The ink node ids in the tiles drawn by the last drawGpu calls of this composite. Filled in drawGpu, cleared in prepare;
     * one set reused for the composer's life. */
    drawnInkNodeIds(): ReadonlySet<string>;
    /** The GPU bytes the visible tiles at the drawn scale hold, for a viewport of `width` by `height` (view units): one
     * tile target per slice of each visible position that is composed. The governor's mandatory working set. */
    mandatoryBytes(width: number, height: number): number;
    /** False while nothing can make progress this frame: composed and settled, or waiting for memory. */
    needsFrame(): boolean;
    /** True while the composer waits on a refused GPU admission and has no other work (no indexing, nothing finished to encode): a
     * budget refusal defers the composer, it never holds the frame. */
    memoryBlocked(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    release(reason: GpuReleaseReason): void;
    dispose(): void;
}

/** The exact tile scale for a demand: device pixels per world unit, rounded so a return to a zoom reuses its tiles. */
function exactScale(demand: number): number {
    return Number(demand.toPrecision(12));
}
/** The most parts a live-only overlay draws each frame; a larger paint composes tiles (its per-frame admission is the cost). */
const LIVE_OVERLAY_MAX_PARTS = 256;
/** A live part: a video picture, whose image key carries the video prefix. It is never composed into a tile: it is drawn each
 * frame through the image route, between the slices its paint order falls between. */
function isLivePart(item: PaintItem): boolean {
    return item.kind === 'image' && item.blend !== 'multiply' && item.imageKey.startsWith(VIDEO_FRAME_PREFIX);
}
/** Whether a paint holds a live part (a video picture). Walked once per paint version, not once per stand-in position. */
function windowsHaveLive(prepared: PreparedPaint2d): boolean {
    for (const win of prepared.windows) for (const item of win.items) if (isLivePart(item)) return true;
    return false;
}
/** Cuts a position's parts, in paint order, wherever the blend changes or a live part sits. */
function cutSlices(parts: readonly TilePart[]): { blend: Blend; parts: TilePart[] }[] {
    const out: { blend: Blend; parts: TilePart[] }[] = [];
    let barrier = false;
    for (const part of parts) {
        if (isLivePart(part.item)) { barrier = true; continue; }
        const last = out[out.length - 1];
        if (last && last.blend === part.blend && !barrier) last.parts.push(part);
        else out.push({ blend: part.blend, parts: [part] });
        barrier = false;
    }
    return out;
}
/** The ink nodes among a slice's parts, each once. Built once per position, when its slices are cut. */
function inkNodesOf(parts: readonly TilePart[]): readonly string[] {
    let out: string[] | null = null;
    for (const part of parts) {
        if (part.item.kind !== 'ink') continue;
        out ??= [];
        if (!out.includes(part.nodeId)) out.push(part.nodeId);
    }
    return out ?? NO_IDS;
}
function covers(outer: Readonly<Rect>, inner: Readonly<Rect>): boolean {
    return outer.x <= inner.x && outer.y <= inner.y
        && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}
function spanAt(view: ViewState, scale: number): Span {
    const { camera: c, viewport: v } = view;
    const x0 = Math.floor(c.x * scale / EDGE), y0 = Math.floor(c.y * scale / EDGE);
    const x1 = Math.ceil((c.x + v.width / c.z) * scale / EDGE), y1 = Math.ceil((c.y + v.height / c.z) * scale / EDGE);
    if (![x0, y0, x1, y1].every(Number.isSafeInteger)) throw new RangeError('Invalid board tile projection');
    return { x0, y0, x1, y1 };
}
/** The surface rectangle a position of `target` covers, clamped to the surface; null when none of it is on the surface. */
function clipOnSurface(view: ViewState, target: number, x: number, y: number): Rect | null {
    const cam = view.camera, scale = cam.z * view.viewport.dpr;
    const surfaceW = Math.round(view.viewport.width * view.viewport.dpr), surfaceH = Math.round(view.viewport.height * view.viewport.dpr);
    const left = Math.max(0, Math.round((x * EDGE / target - cam.x) * scale)), top = Math.max(0, Math.round((y * EDGE / target - cam.y) * scale));
    const right = Math.min(surfaceW, Math.round(((x + 1) * EDGE / target - cam.x) * scale));
    const bottom = Math.min(surfaceH, Math.round(((y + 1) * EDGE / target - cam.y) * scale));
    return right <= left || bottom <= top ? null : { x: left, y: top, width: right - left, height: bottom - top };
}
function inSpan(span: Span, x: number, y: number): boolean {
    return x >= span.x0 && x < span.x1 && y >= span.y0 && y < span.y1;
}

export function createTileComposer(options: TileComposerOptions): TileComposer {
    const { host, audit, parts, store, routes, tileWorld, inkRouteFor, lay, layQuads, admitClips, withPreparedClips } = options;
    const routeList: ItemRoute[] = [routes.path, routes.inkAnalytic, routes.inkUnion, routes.image, routes.text, routes.cpu]
        .filter((route): route is ItemRoute => route !== undefined);
    let resourcesSeen: PaintResources2d | null = null;
    // Slots live beside their entries (keyed by the entry object), so an entry the store drops takes its slot with it.
    const slots = new WeakMap<TileEntry, Slot>();
    // Entries encoded with a run that drew a stand-in (the text route's zoom). They recompose exact once the camera rests: the last
    // zoom frame's entries are the ones at the scale the camera rests on, so the set is cleared at the start of each zoom frame.
    const inexactPending = new Set<TileEntry>();
    // Positions being admitted, by key. A finished position waits in `finished` for its band's encode.
    const building = new TileKeyMap<Position>();
    const staleScratch: Position[] = [];
    // Scale indexes for the building keys: the key's index is a small integer, so the scales in use are interned. The table
    // is cleared whenever it could pass the key's 64 indexes (prepare does that, before any position of the frame is begun).
    const scaleIndexes = new Map<number, number>();
    const scaleIndexOf = (scale: number): number => {
        let index = scaleIndexes.get(scale);
        if (index === undefined) { index = scaleIndexes.size; scaleIndexes.set(scale, index); }
        return index;
    };
    let finished: Position[] = [];
    const draws: Draw[] = [];
    // The ink nodes the composite draws, filled in drawGpu and cleared in prepare: one set for the composer's life.
    const drawnInk = new Set<string>();
    // Live parts: admitted each frame through the image route, released at the next prepare. Scratch holds the ones of the
    // position being drawn, in paint order.
    const liveRuns: LiveAdmission[] = [];
    const liveAdmitted = new Map<PaintItem, LiveAdmission | null>();
    const liveScratch: { order: number; run: PreparedRun; route: ItemRoute }[] = [];
    const standScratch: { order: number; entry: TileEntry; slot: Slot }[] = [];
    // Batch scratch: the quads of one call, reused. The pool holds spec objects for the composer's life.
    const quadPool: { sourceRect: Rect; destRect: Rect }[] = [];
    const quadList: TexturedQuadSpec[] = [];
    let drawCount = 0;

    let disposed = false, presenting = false, indexing = false;
    // This frame's zoom, set in prepare: while zooming, coverage does not hold the frame for a position with nothing (see coverage).
    let zoomingFrame = false;
    // Visible edits: counted wherever the composer changes what it draws or holds for drawing (a position composed, cancelled or
    // dropped, a store slot freed for it, an invalidation). prepare reports whether any happened since its last call, together with
    // a signature of the draw list it laid, so a frame that draws what the last one drew is reported unchanged.
    let visibleEdits = 0;
    // The kinds of edit this prepare made (one bit each), so a 'changed' answer names its reason as audit counters.
    let editBits = 0;
    const EDIT_SUPERSEDED = 1, EDIT_EMPTY = 2, EDIT_CANCEL = 4, EDIT_FREE = 8, EDIT_DONE = 16, EDIT_SCALES = 32, EDIT_INVALID = 64;
    const editEvent = (bit: number): void => { visibleEdits++; editBits |= bit; };
    let drawSignature = 0;
    // The visible span at the compose scale while zooming, null otherwise: the positions a superseded entry must be exact under to be dropped.
    let zoomSpan: Span | null = null;
    let routesEncodedFrame = -1;
    const omitTracker = new OmitTracker();
    let denied = false, settled = false, preparedSharp = true;
    // A refusal waits for the governor's wake. Set by a refusal, cleared only by wake (or release): prepare clears `denied`
    // every frame, which let a refused board request a frame every vsync until the wake (measured by gpu's review).
    let waiting = false;
    // The refusal that set `waiting` was a GPU admission (a budget the governor may free), not a CPU one.
    let blockedOnGpu = false;
    // The deadline (performance.now) of the armed retry; 0 when none is armed or it was satisfied. A deadline that fires with nothing
    // to do is a no-op: the layer's wake slot is shared with the store's trim deadline, so it is not cancelled with null.
    let retryAt = 0;
    let retryDelay = GPU_RETRY_MS, retryMisses = 0;
    // The paint's live-part flag, scanned once per paint version: a stand-in position queries the parts index only when set.
    let paintScanned: PreparedPaint2d | null = null, paintHasLive = false, paintLiveOnly = false;
    let device: GfxDevice | null = null;
    let frame = 0, validRevision = 0;
    let omitIds: ReadonlySet<string> | null = null;
    // Nodes that left the omit set while their tiles lack them: drawn live until the tiles under them are composed (see prepare).
    // The value is the frame it left: a tile encoded from that frame on already holds the node, so its live part is skipped.
    const heldNodes = new Map<string, number>();
    // The frame each tile entry was last encoded (its content's frame), read against heldNodes.
    const composedAt = new WeakMap<TileEntry, number>();
    let lastZoom: number | undefined;
    // The scale the last prepare composed and drew. Coverage describes this scale, not the exact demand: a zoom draws its
    // ladder scale, and coverage asked about the exact one, where nothing is composed, so every frame of a zoom read incomplete.
    let drawnTarget = 0;
    let drawnCamX = 0, drawnCamY = 0, drawnCamZ = 1;

    // The governor's wake for a refusal: the parked positions may be advanced again, and the board is asked for a frame.
    const wake = (): void => {
        for (const position of building.values()) position.parked = false;
        waiting = false; blockedOnGpu = false;
        retryDelay = GPU_RETRY_MS; retryMisses = 0;
        if (retryAt !== 0) { retryAt = 0; host.wakeAt(null); }
        host.invalidate('tile-composer-capacity');
    };
    // Arms the retry deadline for a visible GPU refusal, once: a deadline already armed for later stands.
    const armRetry = (): void => {
        const now = performance.now();
        if (retryAt > now) return;
        if (++retryMisses > GPU_RETRY_LIMIT) { auditCount(audit, 'compose:retry:stopped'); return; }
        retryAt = now + retryDelay;
        retryDelay = Math.min(retryDelay * 2, GPU_RETRY_MAX_MS);
        host.wakeAt(retryAt);
    };
    const refuseTarget = (): void => { denied = true; waiting = true; blockedOnGpu = true; auditCount(audit, 'tile:denied'); store.wait(TARGET_BYTES, wake); };
    const refuseAdmission = (pool: 'gpu' | 'cpu', bytes: number): void => {
        denied = true; waiting = true; blockedOnGpu = pool === 'gpu'; auditCount(audit, 'tile:denied');
        if (pool === 'gpu') store.wait(bytes, wake); else host.allocator.cpu.whenAvailable?.(wake, bytes);
    };

    const keyOf = (band: PaintBand, scale: number, x: number, y: number, slice: number): TileKey => ({ band, scale, x, y, slice });
    /** The entry stored at a key now, by its packed number. The registry index is read here, per lookup: the store may renumber a
     * scale when it evicts one (its 65-scale cap), so a number kept across an acquire could name another scale's tile. */
    const entryAt = (band: PaintBand, scale: number, x: number, y: number, slice: number): TileEntry | undefined => {
        const index = store.scaleIndexOf(scale);
        return index < 0 ? undefined : store.getByNum(tileKeyNum(band, index, x, y, slice));
    };
    const entryOfKey = (key: TileKey): TileEntry | undefined => {
        const num = store.numOf(key);
        return num < 0 ? undefined : store.getByNum(num);
    };
    const positionKey = (band: PaintBand, scale: number, x: number, y: number): number => tileKeyNum(band, scaleIndexOf(scale), x, y, 0);

    /** A position's status at a scale, from its slices: every slice present, none overtaken by a change. */
    const statusAt = (band: PaintBand, scale: number, x: number, y: number): Status => {
        const first = entryAt(band, scale, x, y, 0);
        const slot = first && slots.get(first);
        if (!first || !slot) return 'missing';
        let dirty = first.dirty;
        for (let s = 1; s < slot.count; s++) {
            const entry = entryAt(band, scale, x, y, s);
            if (!entry) return 'missing';
            dirty ||= entry.dirty;
        }
        return dirty ? 'dirty' : 'ok';
    };

    /** Composed tiles of the nearest other scale that cover a position, every slice of them, in slice order. */
    /** Composed tiles of the nearest other scale that cover a position, in the store's nearest-first order. One reused array:
     * valid until the next call, which every caller honours by reading it at once. */
    const standInScratch: TileEntry[] = [];
    const standInsOf = (band: PaintBand, scale: number, x: number, y: number): readonly TileEntry[] => {
        const world: Rect = { x: x * EDGE / scale, y: y * EDGE / scale, width: EDGE / scale, height: EDGE / scale };
        const list = store.standIns(band, world, scale);
        standInScratch.length = 0;
        if (!list.length) return standInScratch;
        const nearest = list[0].key.scale;
        for (const entry of list) if (entry.key.scale === nearest && entry.target !== null) standInScratch.push(entry);
        return standInScratch;
    };

    /** Whether a zoom holds a position at its nearest composed tiles instead of composing it at the exact scale. It holds when those
     * tiles have content and either none of it is geometry (raster only: drawn scaled, not re-rastered) or some of it is CPU raster
     * (the CPU route would raster it afresh each frame). Mixed GPU content composes exact: its text route scales its cached masks. A
     * position with no composed content (an empty tile, or none at all) is composed. */
    const heldByZoom = (band: PaintBand, scale: number, x: number, y: number): boolean => {
        let content = false, geometry = false, cpu = false;
        for (const entry of standInsOf(band, scale, x, y)) {
            const slot = slots.get(entry);
            if (!slot) return false;
            if (slot.count === 0) continue;
            content = true; geometry ||= slot.geometry; cpu ||= slot.cpu;
        }
        return content && (!geometry || cpu);
    };

    /** Whether every visible position under a stored entry is exact at `scale` (composed, or finished this frame). */
    const exactUnder = (band: PaintBand, scale: number, entry: TileEntry, span: Span): boolean => {
        const world = tileWorld(entry.key);
        const x0 = Math.max(span.x0, Math.floor(world.x * scale / EDGE)), x1 = Math.min(span.x1, Math.ceil((world.x + world.width) * scale / EDGE));
        const y0 = Math.max(span.y0, Math.floor(world.y * scale / EDGE)), y1 = Math.min(span.y1, Math.ceil((world.y + world.height) * scale / EDGE));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            if (statusAt(band, scale, x, y) !== 'ok' && !finishedAt(band, scale, x, y)) return false;
        }
        return true;
    };
    /** While zooming, a position encoded at its exact scale supersedes its stand-ins at other scales. Each such entry, once every visible
     * position under it is exact, is dropped: its target goes to the free list, and the next composition takes it. A zoom then keeps one
     * scale's targets, not one set per frame (gpu's zoom memory rule). An entry that still stands in for a position not yet exact stays. */
    const dropSuperseded = (band: PaintBand, scale: number, x: number, y: number): void => {
        const span = zoomSpan;
        if (!span) return;
        for (let guard = 0; guard < 16; guard++) {
            let victim: TileEntry | null = null;
            for (const entry of standInsOf(band, scale, x, y)) {
                if (slots.has(entry) && exactUnder(band, scale, entry, span)) { victim = entry; break; }
            }
            if (!victim) return;
            store.remove(victim.key);
            editEvent(EDIT_SUPERSEDED);
            auditCount(audit, 'compose:zoom:superseded');
        }
    };

    /** The admitted, not yet encoded position at (x, y) of `scale`, when its entries are still stored with targets. The compositor
     * encodes it this frame, before it draws, so it is covered now. Null for any other position. */
    const finishedAt = (band: PaintBand, scale: number, x: number, y: number): Position | null => {
        for (const position of finished) {
            if (position.band !== band) continue;
            const covers = position.scale === scale ? position.x === x && position.y === y
                : position.lowered && position.scale * 2 === scale && position.x === Math.floor(x / 2) && position.y === Math.floor(y / 2);
            if (!covers) continue;
            for (const slice of position.slices) {
                const entry = slice.entry;
                if (!entry || !entry.target || entryOfKey(slice.key) !== entry) return null;
            }
            return position;
        }
        return null;
    };

    /** True while a node's tiles at `target` lack it: a position under its bounds is dirty (it still holds the old content), or a
     * visible one has nothing yet. Positions out of view are not waited for: they hold their dirty tiles until they are seen. */
    const heldStillMissing = (id: string, target: number, span: Span): boolean => {
        for (const rect of parts.boundsOfNodes(new Set([id]))) {
            const x0 = Math.floor(rect.x * target / EDGE), x1 = Math.ceil((rect.x + rect.width) * target / EDGE);
            const y0 = Math.floor(rect.y * target / EDGE), y1 = Math.ceil((rect.y + rect.height) * target / EDGE);
            for (const band of BANDS) {
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                    const status = statusAt(band, target, x, y);
                    if (status === 'dirty') return true;
                    if (status === 'missing' && inSpan(span, x, y) && !finishedAt(band, target, x, y)) return true;
                }
            }
        }
        return false;
    };

    /** The routes that draw geometry: paths and ink. Every other route's content is raster (the text masks and decoded images, which
     * the GPU draws from rastered or decoded pixels, and the CPU raster), which a zoom does not re-raster (gpu's ruling). */
    const isGeometryRoute = (route: ItemRoute): boolean => route === routes.path || route === routes.inkAnalytic || route === routes.inkUnion;
    /** The GPU route for an item, or the CPU route with the reason no GPU route takes it. */
    /** A paint a live-only overlay draws without tiles: every part a plain unclipped 'over' item on a route that draws over the
     * surface (the CPU route rasters a tile-sized scratch, so it cannot), and no more parts than the overlay's threshold. */
    const liveOnlyPaint = (prepared: PreparedPaint2d): boolean => {
        if (options.liveOverlay !== true) return false;
        let count = 0;
        for (const win of prepared.windows) for (const item of win.items) {
            if (++count > LIVE_OVERLAY_MAX_PARTS) return false;
            if (blendOf(item) !== 'over' || item.clips.length) return false;
            if (!isLivePart(item) && routeOf(item).route === routes.cpu) return false;
        }
        return count > 0;
    };
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
            let outcome = run.route.admit(run.items, slice.view, slice.blend, budget);
            if (outcome.status === 'unsupported') {
                // A GPU route that refuses a run hands it to the CPU route for good, with the reason (the raster paints its clips).
                toCpu(run, outcome.why, null);
                outcome = run.route.admit(run.items, slice.view, slice.blend, budget);
            }
            switch (outcome.status) {
                case 'ready':
                    // Counted where the CPU route's raster succeeded: a deferred or refused attempt is not a fallback.
                    if (run.route === routes.cpu) countFallback(run);
                    slice.admitted.push({ route: run.route, run: outcome.value, clips: run.prepared }); run.prepared = null; slice.next++; break;
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
        const raw = parts.partsFor(band, gutter, omitIds ?? undefined);
        const cut = cutSlices(raw);
        let live = 0;
        for (const part of raw) if (isLivePart(part.item)) live++;
        if (!cut.length) {
            editEvent(EDIT_EMPTY);
            dropOrphanSlices(band, scale, x, y, 1);
            const entry = store.putEmpty(key0);
            slots.set(entry, { mode: 'over', count: 0, inkNodes: NO_IDS, firstOrder: NO_ORDERS, live, geometry: false, cpu: false });
            auditCount(audit, 'tile:empty');
            return null;
        }
        const opaque = options.opaqueWorld?.() ?? NO_OPAQUE;
        const tile = tileView(gutter.x, gutter.y, scale, SIZE, view.epoch);
        const onOpaque = opaque.some(rect => covers(rect, interior));
        const slices = cut.map((group, s): Slice => {
            const mode: Mode = group.blend === 'over' ? 'over' : onOpaque ? 'modulate' : 'isolated';
            const key = keyOf(band, scale, x, y, s);
            // A dirty entry is recomposed into the target it already has; a missing one is acquired once its content is admitted.
            const existing = entryOfKey(key);
            return {
                key, mode, blend: mode === 'modulate' ? 'modulate' : 'over', view: tile, runs: runsOf(group.parts),
                next: 0, admitted: [], entry: existing && existing.target ? existing : null, inkNodes: inkNodesOf(group.parts),
                firstOrder: group.parts[0].order,
            };
        });
        return { band, scale, x, y, slices, cursor: 0, parked: false, lowered: false, key: positionKey(band, scale, x, y), live };
    };

    /** Admits and acquires a position's slices in order. 'wait' resumes next frame; 'denied' waits for memory. */
    const advance = (position: Position, budget: FrameBudget, gpu: GfxDevice): 'done' | 'wait' | 'denied' | 'refused' => {
        for (; position.cursor < position.slices.length; position.cursor++) {
            const slice = position.slices[position.cursor];
            if (slice.next < slice.runs.length) {
                const outcome = timedStage(audit, 'admit', () => admitSlice(slice, budget));
                if (outcome === 'deferred') return 'wait';
                if (outcome !== 'ok') { refuseAdmission(outcome.pool, outcome.bytes); return 'denied'; }
            }
            if (!slice.entry) {
                const entry = store.acquire(slice.key, slice.blend, gpu);
                if (!entry) return 'refused';
                slice.entry = entry;
            }
        }
        return 'done';
    };

    /** Releases what a position admitted; its acquired targets stay in the store, still missing their slots. */
    const cancel = (position: Position): void => {
        editEvent(EDIT_CANCEL);
        for (const slice of position.slices) {
            for (const run of slice.runs) { run.prepared?.retire(); run.prepared = null; }
            for (const { route, run, clips } of slice.admitted) { route.retire(run); clips?.retire(); }
            slice.admitted.length = 0;
        }
    };

    /** Frees this composer's own tiles for a refused position at rest, so it is admitted now instead of waiting on capacity that
     * nothing else releases (gpu, round 5: the paper froze with 31.9 MB held, its waiter armed and never woken). The free list and
     * the unprotected off-view tiles go first. When that frees nothing, the other scales go too, the stand-ins they were with them;
     * the exact scale stays. A lowered position still building is cancelled first: its entries are at another scale. Returns
     * whether any bytes were freed. */
    // The frame in which an own-store free found nothing: every later refusal this frame would scan and find nothing too.
    let freeOwnEmptyFrame = -1;
    const freeOwn = (view: ViewState, target: number): boolean => {
        if (freeOwnEmptyFrame === frame) return false;
        editEvent(EDIT_FREE);
        if (store.evict(FREE_FOR_REFUSAL, -1, view) > 0) return true;
        for (const position of building.values()) if (position.lowered) { cancel(position); building.delete(position.key); }
        for (const band of BANDS) store.dropScalesExcept(target, band);
        const freed = store.evict(FREE_FOR_REFUSAL, -1, view) > 0;
        if (freed) auditCount(audit, 'compose:free-own:scales');
        else freeOwnEmptyFrame = frame;
        return freed;
    };

    /** Whether a building or finished position is still wanted at `target` for the visible `ring`: a position at the target
     * scale by its own cell, a lowered one (half the scale) by any of the four target cells it covers. */
    const stillWanted = (position: Position, target: number, ring: Span): boolean => {
        if (!position.lowered) return position.scale === target && inSpan(ring, position.x, position.y);
        if (position.scale * 2 !== target) return false;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            if (inSpan(ring, position.x * 2 + dx, position.y * 2 + dy)) return true;
        }
        return false;
    };

    /** The compose pass of one frame, in priority order: dirty visible positions, then missing visible ones, then the
     * missing positions one ring outside the view. The frame's limit is the number of tiles it may compose. */
    const compose = (view: ViewState, budget: FrameBudget, gpu: GfxDevice, target: number, span: Span): void => {
        let limit = view.moving ? 2 : 8;
        if (options.slowGpu?.()) limit = Math.max(1, limit >> 1);
        let composed = 0;
        // Advances one position. False when this frame's compose is spent (limit, budget, a wait); true when the pass goes on.
        const drive = (position: Position, key: number, pass: 'held' | 'dirty' | 'missing' | 'ring'): boolean => {
            if (position.parked) return true;
            // Why a frame composes nothing is the zoom question: each exit is counted (pass and cause).
            if (composed >= limit) { auditCount(audit, `compose:limit:${pass}`); return false; }
            if (budget.shouldYield()) { auditCount(audit, `compose:yield:${pass}`); return false; }
            let outcome = advance(position, budget, gpu);
            // At rest a refused or denied position frees this composer's own tiles and is admitted in the same frame, instead of
            // waiting for the governor (see freeOwn). While zooming the stand-ins stay: they are what the zoom shows.
            // Only a GPU refusal frees this composer's own tiles: a CPU denial (path staging) is not a GPU shortage, and evicting
            // tiles for it recomposes what was just freed.
            if ((outcome === 'refused' || (outcome === 'denied' && blockedOnGpu)) && !zoomingFrame && freeOwn(view, target)) {
                auditCount(audit, `compose:free-retry:${pass}`);
                outcome = advance(position, budget, gpu);
            }
            if (outcome === 'done') {
                editEvent(EDIT_DONE);
                auditCount(audit, `compose:done:${pass}`);
                building.delete(key);
                finished.push(position);
                composed += position.slices.length;
                return true;
            }
            if (outcome === 'refused' && pass !== 'ring' && !position.lowered) {
                // The governor refused a visible position: it composes one level down, at half the scale, which covers this
                // position and three others. The stand-in keeps it on screen meanwhile; a second refusal waits.
                const low = lowerTileKey(keyOf(position.band, position.scale, position.x, position.y, 0));
                const lowKey = positionKey(low.band, low.scale, low.x, low.y);
                if (!building.has(lowKey) && statusAt(low.band, low.scale, low.x, low.y) === 'ok') {
                    // The lower cell already holds its tile, shown as the stand-in: this position parks, keeping the runs it admitted,
                    // so the lower tile is not re-rastered each prepare. The governor's wake advances it again.
                    refuseTarget(); position.parked = true; auditCount(audit, `compose:lower-present:${pass}`); return true;
                }
                cancel(position); building.delete(key);
                let lower = building.get(lowKey);
                if (!lower) {
                    const started = begin(low.band, low.scale, low.x, low.y, view);
                    if (!started) { auditCount(audit, 'compose:lower-empty'); return true; }
                    started.lowered = true;
                    building.set(lowKey, started);
                    lower = started;
                }
                auditCount(audit, `compose:lowered:${pass}`);
                return drive(lower, lowKey, pass);
            }
            if (outcome === 'refused') { refuseTarget(); position.parked = true; if (pass !== 'ring') armRetry(); auditCount(audit, `compose:refused:${pass}`); return true; }
            if (outcome === 'denied') { position.parked = true; if (pass !== 'ring') armRetry(); auditCount(audit, `compose:denied:${pass}`); return true; }
            auditCount(audit, `compose:wait:${pass}`);
            return false;
        };
        // The positions under a held node come first: it stays live until they are composed, so they shorten every hold, and
        // a held node's content is composed before any other tile in the frame's budget (gpu).
        for (const id of heldNodes.keys()) {
            for (const rect of parts.boundsOfNodes(new Set([id]))) {
                const x0 = Math.max(span.x0, Math.floor(rect.x * target / EDGE)), x1 = Math.min(span.x1, Math.ceil((rect.x + rect.width) * target / EDGE));
                const y0 = Math.max(span.y0, Math.floor(rect.y * target / EDGE)), y1 = Math.min(span.y1, Math.ceil((rect.y + rect.height) * target / EDGE));
                for (const band of BANDS) {
                    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                        const key = positionKey(band, target, x, y);
                        let position = building.get(key);
                        if (!position) {
                            const status = statusAt(band, target, x, y);
                            if (status !== 'dirty' && !(status === 'missing' && !finishedAt(band, target, x, y))) continue;
                            const started = begin(band, target, x, y, view);
                            if (!started) continue;
                            position = started;
                            building.set(key, position);
                        }
                        if (!drive(position, key, 'held')) return;
                    }
                }
            }
        }
        for (const pass of ['dirty', 'missing', 'ring'] as const) {
            // While zooming only the visible positions are composed: the ring is the next view's, and the zoom's compose is its cost.
            if (pass === 'ring' && zoomingFrame) continue;
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
                            // While zooming, content a stand-in can show is not composed again at this scale: its raster is scaled.
                            if (zoomingFrame && pass !== 'dirty' && heldByZoom(band, target, x, y)) { auditCount(audit, 'compose:zoom:held'); continue; }
                            const started = begin(band, target, x, y, view);
                            if (!started) continue;
                            position = started;
                            building.set(key, position);
                        }
                        if (!drive(position, key, pass)) return;
                    }
                }
            }
        }
    };

    // The run an encode draws, set by the encode loop: one object for the composer's life, so no closure is built per run.
    const encodeDraw: { pass: GpuPass | null; route: ItemRoute | null; run: PreparedRun | null } = { pass: null, route: null, run: null };
    const drawEncoded = (): void => {
        const { pass, route, run } = encodeDraw;
        if (!pass || !route || !run) throw new Error('Encode draw without a run');
        route.draw(pass, run);
    };

    /** Fills `spec` with the surface rect of `draw` and the texels that show it. A clipped draw shows only its clip: its source is
     * the part of the tile texture under that part, so the batch needs no scissor. False when none of it is on the surface. */
    const quadOf = (draw: Draw, spec: { sourceRect: Rect; destRect: Rect }, camX: number, camY: number, scale: number,
        surfaceW: number, surfaceH: number): boolean => {
        const x0 = (draw.x - camX) * scale, y0 = (draw.y - camY) * scale;
        const w = draw.w * scale, h = draw.h * scale;
        let dx0 = x0, dy0 = y0, dx1 = x0 + w, dy1 = y0 + h;
        if (draw.clipOn) {
            dx0 = Math.max(dx0, draw.cx); dy0 = Math.max(dy0, draw.cy);
            dx1 = Math.min(dx1, draw.cx + draw.cw); dy1 = Math.min(dy1, draw.cy + draw.ch);
        }
        dx0 = Math.max(dx0, 0); dy0 = Math.max(dy0, 0); dx1 = Math.min(dx1, surfaceW); dy1 = Math.min(dy1, surfaceH);
        if (dx1 <= dx0 || dy1 <= dy0) return false;
        // The interior's EDGE texels span w by h device pixels: a device pixel is EDGE / w texels across.
        const tx = EDGE / w, ty = EDGE / h;
        spec.destRect.x = dx0; spec.destRect.y = dy0; spec.destRect.width = dx1 - dx0; spec.destRect.height = dy1 - dy0;
        spec.sourceRect.x = GUTTER + (dx0 - x0) * tx; spec.sourceRect.y = GUTTER + (dy0 - y0) * ty;
        spec.sourceRect.width = (dx1 - dx0) * tx; spec.sourceRect.height = (dy1 - dy0) * ty;
        return true;
    };
    /** Lays the first `count` quads of the pool as one batched call. */
    const layBatch = (pass: GpuPass, texture: TextureHandle, count: number): void => {
        quadList.length = 0;
        for (let k = 0; k < count; k++) quadList.push(quadPool[k]);
        layQuads(pass, texture, quadList);
    };

    const addDraw = (band: PaintBand, entry: TileEntry, slot: Pick<Slot, 'mode' | 'inkNodes'>, clip: Rect | null): void => {
        const target = entry.target;
        if (!target) return;
        const world = tileWorld(entry.key);
        let draw = draws[drawCount];
        if (!draw) {
            draw = { band, texture: target.texture, mode: slot.mode, x: 0, y: 0, w: 0, h: 0, clipOn: false, cx: 0, cy: 0, cw: 0, ch: 0, ink: NO_IDS, live: null, liveRoute: null };
            draws.push(draw);
        }
        drawCount++;
        draw.band = band; draw.texture = target.texture; draw.mode = slot.mode;
        draw.x = world.x; draw.y = world.y; draw.w = world.width; draw.h = world.height;
        draw.clipOn = clip !== null;
        draw.ink = slot.inkNodes;
        draw.live = null; draw.liveRoute = null;
        if (clip) { draw.cx = clip.x; draw.cy = clip.y; draw.cw = clip.width; draw.ch = clip.height; }
        if (draw.mode === 'isolated') auditCount(audit, 'isolation:copy');
        store.touch(entry, frame);
    };

    /** This frame's draws, per band. A band whose visible positions all have their exact tile swaps to them in one frame;
     * until then (and while zooming) each position shows its exact tile if it has one, else a stand-in clipped to it. */
    /** Retires the live runs admitted for the last frame. Called at the next prepare, after that frame was drawn. */
    const retireLive = (): void => {
        for (const live of liveRuns) live.route.retire(live.run);
        liveRuns.length = 0;
        liveAdmitted.clear();
    };

    /** A live part's run for this frame, admitted once however many positions show it. Video parts take the image route; any other
     * part is admitted by the route that draws its kind (a held node's parts). A part no route draws this frame is counted
     * (live:dropped:<why>), never skipped silently. */
    const admitLive = (item: PaintItem, blend: Blend, view: ViewState, budget: FrameBudget): LiveAdmission | null => {
        const known = liveAdmitted.get(item);
        if (known !== undefined) return known;
        let admitted: LiveAdmission | null = null;
        const route = isLivePart(item) ? routes.image : routeOf(item).route;
        // The CPU route rasters a tile-sized scratch at the camera origin: it cannot draw a live part over the surface.
        if (!route || route === routes.cpu) auditCount(audit, route ? 'live:dropped:cpu-route' : 'live:dropped:route-absent');
        else {
            const outcome = route.admit([item], view, blend, budget);
            if (outcome.status === 'ready') { admitted = { route, run: outcome.value }; liveRuns.push(admitted); }
            else if (outcome.status === 'unsupported') auditCount(audit, `live:dropped:${outcome.why}`);
            else if (outcome.status !== 'empty') auditCount(audit, `live:dropped:${outcome.status}`);
        }
        liveAdmitted.set(item, admitted);
        return admitted;
    };

    /** A held node's parts are drawn live here unless a stand-in entry of this position was encoded since the node left the omit
     * set: that tile already holds the node, so the live part would be a second copy. */
    const heldLive = (nodeId: string, stand: readonly { readonly entry: TileEntry }[]): boolean => {
        const since = heldNodes.get(nodeId);
        if (since === undefined) return false;
        for (const { entry } of stand) if ((composedAt.get(entry) ?? -1) >= since) return false;
        return true;
    };

    /** The live parts of a position, in paint order, admitted for this frame into `liveScratch`. Video parts only when `wanted`; the
     * parts of a held node (its tiles lack it) when `held`. */
    const collectLive = (band: PaintBand, target: number, x: number, y: number, view: ViewState, budget: FrameBudget,
        wanted: boolean, stand: readonly { readonly entry: TileEntry }[] | null): void => {
        liveScratch.length = 0;
        // A position's parts are queried only for video or while a node is held: a board with neither pays nothing here.
        if (!wanted && !(stand && heldNodes.size)) return;
        const interior = tileWorld(keyOf(band, target, x, y, 0));
        const pad = GUTTER / target;
        const gutter: Rect = { x: interior.x - pad, y: interior.y - pad, width: interior.width + 2 * pad, height: interior.height + 2 * pad };
        // partsFor answers in paint order, so the scratch is too.
        for (const part of parts.partsFor(band, gutter, omitIds ?? undefined)) {
            const video = isLivePart(part.item);
            if (video ? !wanted : !(stand && heldLive(part.nodeId, stand))) continue;
            const admitted = admitLive(part.item, part.blend, view, budget);
            if (admitted) liveScratch.push({ order: part.order, run: admitted.run, route: admitted.route });
        }
    };

    /** A live draw: its run under `clip`, in the draw order of the position it shows. */
    const addLiveDraw = (band: PaintBand, run: PreparedRun, route: ItemRoute, clip: Rect): void => {
        let draw = draws[drawCount];
        if (!draw) {
            draw = { band, texture: null, mode: 'over', x: 0, y: 0, w: 0, h: 0, clipOn: true, cx: 0, cy: 0, cw: 0, ch: 0, ink: NO_IDS, live: null, liveRoute: null };
            draws.push(draw);
        }
        drawCount++;
        draw.band = band; draw.texture = null; draw.mode = 'over'; draw.clipOn = true;
        draw.cx = clip.x; draw.cy = clip.y; draw.cw = clip.width; draw.ch = clip.height;
        draw.ink = NO_IDS; draw.live = run; draw.liveRoute = route;
        auditCount(audit, 'tile:live-part');
    };

    /** Draws the scratch live parts that paint before `order`, from index `from`, clipped to `clip`. Returns the next index. */
    const liveBefore = (band: PaintBand, order: number, from: number, clip: Rect | null): number => {
        let li = from;
        for (; li < liveScratch.length && liveScratch[li].order < order; li++) {
            if (clip) addLiveDraw(band, liveScratch[li].run, liveScratch[li].route, clip);
        }
        return li;
    };

    /** A live-only overlay's parts: every part of every visible position, drawn live at the view, with no tile (liveOverlay). */
    const collectAllLive = (band: PaintBand, target: number, x: number, y: number, view: ViewState, budget: FrameBudget): void => {
        liveScratch.length = 0;
        const interior = tileWorld(keyOf(band, target, x, y, 0));
        const pad = GUTTER / target;
        const gutter: Rect = { x: interior.x - pad, y: interior.y - pad, width: interior.width + 2 * pad, height: interior.height + 2 * pad };
        for (const part of parts.partsFor(band, gutter, omitIds ?? undefined)) {
            if (part.item.kind === 'ink') drawnInk.add(part.nodeId);
            const admitted = admitLive(part.item, part.blend, view, budget);
            if (admitted) liveScratch.push({ order: part.order, run: admitted.run, route: admitted.route });
        }
    };
    /** The live-only overlay's draw list: each visible position's parts, in paint order, clipped to that position on the surface. */
    const buildLiveDraws = (view: ViewState, target: number, budget: FrameBudget): void => {
        const span = spanAt(view, target);
        for (const band of BANDS) {
            for (let y = span.y0; y < span.y1; y++) {
                for (let x = span.x0; x < span.x1; x++) {
                    const clip = clipOnSurface(view, target, x, y);
                    if (!clip) continue;
                    collectAllLive(band, target, x, y, view, budget);
                    liveBefore(band, Infinity, 0, clip);
                    auditCount(audit, 'tile:live-overlay');
                }
            }
        }
    };

    const buildDraws = (view: ViewState, target: number, zooming: boolean, budget: FrameBudget): void => {
        drawCount = 0;
        if (paintLiveOnly) { buildLiveDraws(view, target, budget); return; }
        const span = spanAt(view, target);
        const clipAt = (x: number, y: number): Rect | null => clipOnSurface(view, target, x, y);
        for (const band of BANDS) {
            let complete = true;
            for (let y = span.y0; y < span.y1 && complete; y++) {
                for (let x = span.x0; x < span.x1 && complete; x++) if (statusAt(band, target, x, y) === 'missing') complete = false;
            }
            if (!zooming && complete && store.dropScalesExcept(target, band) > 0) editEvent(EDIT_SCALES);
            for (let y = span.y0; y < span.y1; y++) {
                for (let x = span.x0; x < span.x1; x++) {
                    const status = statusAt(band, target, x, y);
                    // Admitted and encoded this frame: its fresh entries are drawn now, as the exact tile they will be.
                    const pending = status === 'missing' ? finishedAt(band, target, x, y) : null;
                    if (pending) {
                        // A lowered tile covers four positions: each draw is clipped to the position it shows.
                        const pendingClip = pending.lowered ? clipAt(x, y) : null;
                        if (pending.lowered && !pendingClip) continue;
                        collectLive(band, target, x, y, view, budget, pending.live > 0, null);
                        let li = 0;
                        for (const slice of pending.slices) {
                            if (!slice.entry) continue;
                            li = liveBefore(band, slice.firstOrder, li, pendingClip);
                            addDraw(band, slice.entry, { mode: slice.mode, inkNodes: slice.inkNodes }, pendingClip);
                        }
                        liveBefore(band, Infinity, li, pendingClip);
                        auditCount(audit, 'tile:encoding');
                        continue;
                    }
                    const exact = status !== 'missing' && (zooming || complete || standInsOf(band, target, x, y).length === 0);
                    if (exact) {
                        const first = entryAt(band, target, x, y, 0);
                        const slot0 = first ? slots.get(first) : undefined;
                        const count = slot0?.count ?? 0;
                        const withLive = (slot0?.live ?? 0) > 0;
                        const clip = withLive ? clipAt(x, y) : null;
                        collectLive(band, target, x, y, view, budget, withLive, null);
                        let li = 0;
                        for (let s = 0; s < count; s++) {
                            const entry = entryAt(band, target, x, y, s);
                            const slot = entry && slots.get(entry);
                            if (entry && slot) {
                                li = liveBefore(band, slot.firstOrder[s], li, clip);
                                addDraw(band, entry, slot, null);
                            }
                        }
                        liveBefore(band, Infinity, li, clip);
                        auditCount(audit, 'tile:hit');
                        if (zooming) auditCount(audit, 'zoom:draw:exact');
                        continue;
                    }
                    // The stand-in's clip is the part of its position on the surface: a scissor outside the surface, or with a
                    // negative origin, is refused by the device (measured: 'invalid-input' on open).
                    const clip = clipAt(x, y);
                    if (!clip) continue;
                    // The stand-in's entries are drawn in paint order, so its live parts interleave as they do in an exact tile
                    // (the list is in position order, which is not paint order).
                    standScratch.length = 0;
                    for (const entry of standInsOf(band, target, x, y)) {
                        const slot = slots.get(entry);
                        if (slot) standScratch.push({ order: slot.firstOrder[entry.key.slice] ?? Infinity, entry, slot });
                    }
                    standScratch.sort((a, b) => a.order - b.order);
                    collectLive(band, target, x, y, view, budget, paintHasLive, standScratch);
                    let li = 0;
                    for (const item of standScratch) {
                        li = liveBefore(band, item.order, li, clip);
                        addDraw(band, item.entry, item.slot, clip);
                    }
                    liveBefore(band, Infinity, li, clip);
                    // What this position shows: its stand-in's entries (drawn above), or nothing at all, a hole the audit counts. Its origin
                    // is geometry when any stand-in holds geometry, which a zoom must draw exact (the audit counts it apart).
                    if (standScratch.length) {
                        const geometry = standScratch.some(item => item.slot.geometry);
                        auditDrawn('stand-in', 1, geometry ? 'geometry' : 'raster');
                        if (zooming) auditCount(audit, geometry ? 'zoom:draw:standin:geometry' : 'zoom:draw:standin:raster');
                    } else auditDrawn('hole');
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

    /** Releases the stored slices at `from` and above, up to the count the position's first slice last recorded: a position that
     * now has fewer slices (an erased multiply item) would keep their targets, counted but never drawn. */
    const dropOrphanSlices = (band: PaintBand, scale: number, x: number, y: number, from: number): void => {
        const first = entryOfKey(keyOf(band, scale, x, y, 0));
        const oldCount = first ? slots.get(first)?.count ?? 0 : 0;
        for (let s = from; s < oldCount; s++) store.remove(keyOf(band, scale, x, y, s));
    };
    const encodePosition = (passes: OffscreenPasses, position: Position): void => {
        dropOrphanSlices(position.band, position.scale, position.x, position.y, position.slices.length);
        for (const slice of position.slices) {
            const entry = slice.entry;
            if (entry && entry.target && entryOfKey(slice.key) === entry) {
                const target = entry.target;
                composedAt.set(entry, frame);
                const pass = passes.begin(target.target, { x: 0, y: 0, width: target.size, height: target.size },
                    { clear: slice.blend === 'modulate' ? WHITE : CLEAR, stencil: false });
                const audited = renderAuditEnabled();
                for (const { route, run, clips } of slice.admitted) {
                    // Drawn through the shared `drawEncoded` with the run in `encodeDraw`: no closure is built per run.
                    const t0 = audited ? performance.now() : 0;
                    encodeDraw.pass = pass; encodeDraw.route = route; encodeDraw.run = run;
                    if (clips) withPreparedClips(pass, clips, drawEncoded);
                    else drawEncoded();
                    if (audited) auditStage(audit, 'draw', performance.now() - t0);
                    auditCount(audit, `route:${route.id}`);
                }
                encodeDraw.pass = null; encodeDraw.route = null; encodeDraw.run = null;
                pass.end();
                auditCount(audit, 'tile:compose', 1, { px: target.size * target.size });
                entry.dirty = false; entry.composed = true; entry.revision = validRevision;
                slots.set(entry, { mode: slice.mode, count: position.slices.length, inkNodes: slice.inkNodes,
                    firstOrder: position.slices.map(part => part.firstOrder), live: position.live,
                    geometry: slice.admitted.some(admitted => isGeometryRoute(admitted.route)),
                    cpu: slice.admitted.some(admitted => admitted.route === routes.cpu) });
                const text = routes.text;
                if (text && slice.admitted.some(admitted => admitted.route === text && !text.exact(admitted.run))) inexactPending.add(entry);
                store.touch(entry, frame);
            }
            for (const { route, run, clips } of slice.admitted) { route.retire(run); clips?.retire(); }
            slice.admitted.length = 0;
        }
    };

    const releaseAll = (): void => {
        for (const position of building.values()) cancel(position);
        building.clear();
        inexactPending.clear();
        scaleIndexes.clear();
        for (const position of finished) cancel(position);
        finished = [];
        drawCount = 0;
        retireLive();
        store.releaseAll();
        for (const route of routeList) route.release();
        denied = false; waiting = false; blockedOnGpu = false; retryAt = 0; retryDelay = GPU_RETRY_MS; retryMisses = 0; settled = false; presenting = false;
        heldNodes.clear();
    };

    return {
        prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): boolean {
            if (disposed) return true;
            const editsBefore = visibleEdits;
            editBits = 0;
            frame = budget.frameId;
            drawnInk.clear();
            retireLive();
            // The interned scales only name the positions in progress: with none in progress they are forgotten now, so a zoom's
            // scales are not kept after it ends (gpu: the churn cannot hold memory). The restart at 60 stays for a long zoom.
            if (!building.size) scaleIndexes.clear();
            else if (scaleIndexes.size >= 60) {
                // The keys' scale indexes are nearly spent: the positions in progress are restarted, which frees their indexes.
                for (const position of building.values()) cancel(position);
                building.clear(); scaleIndexes.clear();
            }
            denied = false; settled = false;
            const demand = view.camera.z * view.viewport.dpr;
            device = host.device();
            if (!prepared || !device || !(demand > 0) || !Number.isFinite(demand)) {
                for (const position of finished) cancel(position);
                finished = [];
                drawCount = 0; presenting = false; drawSignature = 0; return true;
            }
            presenting = true;
            preparedSharp = prepared.sharp !== false;
            if (prepared !== paintScanned) { paintScanned = prepared; paintHasLive = windowsHaveLive(prepared); paintLiveOnly = liveOnlyPaint(prepared); }
            if (prepared.resources !== resourcesSeen) {
                resourcesSeen = prepared.resources;
                for (const route of routeList) (route as ItemRoute & ResourcedRoute).useResources?.(prepared.resources);
            }
            // The scale moves only with the camera's zoom: a pan or a drag keeps the tiles' scale and their pixels.
            const zooming = lastZoom !== undefined && view.camera.z !== lastZoom;
            lastZoom = view.camera.z;
            zoomingFrame = zooming;
            // The text route draws a missing exact mask from its stand-in while the zoom is live; the flag is set before its admits.
            routes.text?.setZoom(zooming);
            if (zooming) inexactPending.clear();
            const exact = exactScale(demand);
            // Compose targets the exact scale every frame, visible positions first (exact-first zoom, gpu).
            const target = exact;
            zoomSpan = zooming ? spanAt(view, target) : null;
            drawnCamX = view.camera.x; drawnCamY = view.camera.y; drawnCamZ = view.camera.z;

            indexing = !parts.sync(prepared, budget);
            if (!indexing) {
                let invalidated = false;
                const changes = parts.takeChanges();
                if (changes === 'all') { store.markDirty('all'); invalidated = true; }
                else if (changes.length) { for (const rect of changes) store.markDirty(rect); invalidated = true; }
                validRevision = prepared.root.sceneRevision;
                // A node a drag omits leaves the tiles it painted: its old bounds are recomposed once, when the set changes. The
                // tracker reports a change of members only, so a new Set of the same nodes costs nothing here.
                if (omitTracker.changed(omit)) {
                    const nextOmit = omit && omit.size ? omit : null;
                    const diff = new Set<string>();
                    for (const id of omitIds ?? []) if (!nextOmit?.has(id)) diff.add(id);
                    for (const id of nextOmit ?? []) if (!omitIds?.has(id)) diff.add(id);
                    for (const rect of parts.boundsOfNodes(diff)) store.markDirty(rect);
                    // A node that leaves the omit set is drawn live until the tiles under it are composed: its old tiles lack it.
                    for (const id of omitIds ?? []) if (!nextOmit?.has(id)) heldNodes.set(id, frame);
                    omitIds = nextOmit ? new Set(nextOmit) : null;
                    invalidated = true;
                }
                if (invalidated) editEvent(EDIT_INVALID);
                // A position admitted against the old content or omission would be encoded stale (it is not in the store
                // yet, so markDirty cannot reach it): every position in progress restarts when either changes.
                const span = spanAt(view, target);
                const ring: Span = { x0: span.x0 - 1, y0: span.y0 - 1, x1: span.x1 + 1, y1: span.y1 + 1 };
                staleScratch.length = 0;
                for (const position of building.values()) if (invalidated || !stillWanted(position, target, ring)) staleScratch.push(position);
                for (const position of staleScratch) { cancel(position); building.delete(position.key); }
                staleScratch.length = 0;
                // A finished position still valid for this content and scale waits for this frame's encode, so it is kept.
                const kept: Position[] = [];
                for (const position of finished) {
                    if (!invalidated && stillWanted(position, target, ring)) kept.push(position);
                    else cancel(position);
                }
                finished = kept;
                // At rest, the entries that drew a stand-in during the zoom recompose exact: marked dirty, they take the dirty pass.
                if (!zooming && inexactPending.size) {
                    for (const entry of inexactPending) if (entry.target && entry.key.scale === target) entry.dirty = true;
                    inexactPending.clear();
                }
                // The armed retry is due and the refused position still waits on the GPU: it is advanced again this frame, after the
                // governor has been asked (the admission reserves). A refusal that persists arms the next retry.
                if (waiting && blockedOnGpu && retryAt !== 0 && performance.now() >= retryAt) {
                    retryAt = 0; host.wakeAt(null); waiting = false; blockedOnGpu = false;
                    for (const position of building.values()) position.parked = false;
                    auditCount(audit, 'compose:retry:deadline');
                }
                // The free list's idle trim: released once the store has been idle, and re-armed on the layer's wake while it is not due.
                store.trimIdle(performance.now());
                if (paintLiveOnly) {
                    // Drawn live at the view, so nothing is composed: any position in progress or finished is let go.
                    for (const position of building.values()) cancel(position);
                    building.clear();
                    for (const position of finished) cancel(position);
                    finished = [];
                } else if (device) compose(view, budget, device, target, span);
                // A held node stays live while a tile under it is dirty, or a visible one under it has nothing yet.
                for (const id of heldNodes.keys()) if (!heldStillMissing(id, target, span)) heldNodes.delete(id);
            } else {
                for (const position of finished) cancel(position);
                finished = [];
            }
            // Each position draws its exact tile where it is there, and otherwise its nearest composed tiles, clipped to it. No frame
            // waits for the compose: a zoom shows what exists (gpu's ruling: geometry exact, raster scaled).
            drawnTarget = target;
            buildDraws(view, target, zooming, budget);
            settled = !indexing && (paintLiveOnly || allExact(view, target));
            // Changed unless the frame drew what the last one drew: no edit, the same draw list, and a settled index.
            let signature = hashMix(drawCount, paintLiveOnly ? 1 : 0);
            for (let i = 0; i < drawCount; i++) {
                const draw = draws[i];
                signature = hashMix(signature, draw.band === 'underlay' ? 1 : 2);
                signature = hashMix(signature, hashText(String(draw.mode)));
                signature = hashMix(signature, Math.round(draw.x * 64)); signature = hashMix(signature, Math.round(draw.y * 64));
                signature = hashMix(signature, Math.round(draw.w * 64)); signature = hashMix(signature, Math.round(draw.h * 64));
                signature = hashMix(signature, draw.clipOn ? Math.round(draw.cx) * 4 + Math.round(draw.cy) * 8 + Math.round(draw.cw) * 16 + Math.round(draw.ch) * 32 : 0);
                signature = hashMix(signature, idOfObject(draw.texture));
                signature = hashMix(signature, draw.live ? 1 + idOfObject(draw.liveRoute) : 0);
                if (draw.ink.length) signature = hashMix(signature, hashText(draw.ink.join('\u0001')));
            }
            const sigChanged = signature !== drawSignature;
            const changed = indexing || visibleEdits !== editsBefore || sigChanged;
            drawSignature = signature;
            // Why it answered changed, as audit counters (gh14): a prepare names every condition that held.
            if (changed && renderAuditEnabled()) {
                if (indexing) auditCount(audit, 'prepare:changed:indexing');
                if (editBits & EDIT_SUPERSEDED) auditCount(audit, 'prepare:changed:superseded');
                if (editBits & EDIT_EMPTY) auditCount(audit, 'prepare:changed:empty');
                if (editBits & EDIT_CANCEL) auditCount(audit, 'prepare:changed:cancelled');
                if (editBits & EDIT_FREE) auditCount(audit, 'prepare:changed:freed');
                if (editBits & EDIT_DONE) auditCount(audit, 'prepare:changed:composed');
                if (editBits & EDIT_SCALES) auditCount(audit, 'prepare:changed:scales-dropped');
                if (editBits & EDIT_INVALID) auditCount(audit, 'prepare:changed:invalidated');
                if (sigChanged) auditCount(audit, 'prepare:changed:draw-list');
            }
            return changed;
        },
        encodeOffscreen(passes: OffscreenPasses, _view: ViewState, band: PaintBand): void {
            // A route that converts its own inputs on the GPU (the text masks) does it once per frame, before any tile pass reads them.
            if (routesEncodedFrame !== frame) {
                routesEncodedFrame = frame;
                for (const route of routeList) route.encodeOffscreen?.(passes);
            }
            if (!finished.length) return;
            let kept = 0;
            for (const position of finished) {
                if (position.band !== band) { finished[kept++] = position; continue; }
                encodePosition(passes, position);
                if (zoomSpan) dropSuperseded(position.band, position.scale, position.x, position.y);
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
            let i = 0;
            while (i < drawCount) {
                const draw = draws[i];
                if (draw.band !== band) { i++; continue; }
                if (draw.live) {
                    // A live part: drawn through the image route under its position's clip, in paint order; never batched.
                    if (draw.clipOn) {
                        scissor.x = draw.cx; scissor.y = draw.cy; scissor.width = draw.cw; scissor.height = draw.ch;
                        const clip = pass.pushClip(scissor);
                        draw.liveRoute?.draw(pass, draw.live);
                        pass.popClip(clip);
                    }
                    i++;
                    continue;
                }
                const texture = draw.texture;
                if (!texture) { i++; continue; }
                if (draw.mode === 'over') {
                    // Consecutive 'over' draws of one texture are batched, in their order: one call per QUAD_BATCH quads.
                    let count = 0, j = i;
                    for (; j < drawCount && draws[j].band === band && draws[j].mode === 'over' && draws[j].live === null && draws[j].texture === texture; j++) {
                        const d = draws[j];
                        const spec = quadPool[count] ?? (quadPool[count] = { sourceRect: { x: 0, y: 0, width: 0, height: 0 }, destRect: { x: 0, y: 0, width: 0, height: 0 } });
                        if (!quadOf(d, spec, cam.x, cam.y, scale, surfaceW, surfaceH)) continue;
                        for (const id of d.ink) drawnInk.add(id);
                        count++;
                        if (count === QUAD_BATCH) { layBatch(pass, texture, count); count = 0; }
                    }
                    if (count) layBatch(pass, texture, count);
                    i = j;
                    continue;
                }
                // Isolated and modulate draws keep their own pass: a group, or the fixed-function modulate, with a clip per draw.
                dest.x = (draw.x - cam.x) * scale; dest.y = (draw.y - cam.y) * scale;
                dest.width = draw.w * scale; dest.height = draw.h * scale;
                // A draw wholly off the surface draws nothing; it is skipped before any clip or group is pushed.
                if (dest.x + dest.width <= 0 || dest.y + dest.height <= 0 || dest.x >= surfaceW || dest.y >= surfaceH) { i++; continue; }
                for (const id of draw.ink) drawnInk.add(id);
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
                lay(pass, texture, CROP, dest, draw.mode === 'modulate' ? 'modulate' : 'over');
                if (group) pass.endGroup(group);
                if (clip) pass.popClip(clip);
                i++;
            }
        },
        coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean } {
            if (!presenting) return { complete: false, sharp: false };
            const exact = exactScale(view.camera.z * view.viewport.dpr);
            if (paintLiveOnly && !indexing) return { complete: true, sharp: preparedSharp && drawnTarget === exact };
            const target = drawnTarget;
            const span = spanAt(view, target);
            // A position with any picture (its tile at the drawn scale, a dirty one, or a stand-in of another scale) is
            // complete; only a position with nothing is not. Sharp needs the drawn scale to be the demanded one, and every
            // position exact and clean there.
            // While zooming, a position with nothing is a hole the compose pass is filling, and it does not hold the frame: the
            // compositor refused 58 of 141 zoom frames for holes waiting on upload allowance (the audit's board-underlay:incomplete,
            // equal to compositor:refuse:coverage). PLAN 3.1: a zoom presents what exists, scaled, every frame.
            let complete = true, sharp = !indexing && preparedSharp && target === exact, stale = indexing;
            for (const band of BANDS) {
                for (let y = span.y0; y < span.y1; y++) {
                    for (let x = span.x0; x < span.x1; x++) {
                        const status = statusAt(band, target, x, y);
                        if (status === 'ok') continue;
                        // Composed this frame: drawn fresh (buildDraws' pending path), so the frame is sharp here. The compositor reads
                        // coverage before the encode, and the entry it still finds is the old one; the draw is not.
                        if (status === 'missing' && finishedAt(band, target, x, y)) continue;
                        sharp = false;
                        if (status === 'dirty') { stale = true; continue; }
                        if (!zoomingFrame && !standInsOf(band, target, x, y).length) complete = false;
                    }
                }
            }
            return { complete, sharp: complete && sharp, ...(stale ? { staleVersion: true } : {}) };
        },
        drawnInkNodeIds(): ReadonlySet<string> { return drawnInk; },
        mandatoryBytes(width: number, height: number): number {
            if (disposed || !presenting) return 0;
            const target = drawnTarget;
            // The span spanAt computes for the drawn camera, counted by the store per band: composed slices only.
            const index = store.scaleIndexOf(target);
            if (index < 0) return 0;
            const x0 = Math.floor(drawnCamX * target / EDGE), y0 = Math.floor(drawnCamY * target / EDGE);
            const x1 = Math.ceil((drawnCamX + width / drawnCamZ) * target / EDGE), y1 = Math.ceil((drawnCamY + height / drawnCamZ) * target / EDGE);
            let bytes = 0;
            for (const band of BANDS) bytes += store.countComposed(band, index, x0, y0, x1 - 1, y1 - 1) * TARGET_BYTES;
            return bytes;
        },
        inkComposed(view: ViewState, ids: ReadonlySet<string>): Set<string> {
            const out = new Set<string>();
            if (disposed || !presenting || indexing) return out;
            const target = drawnTarget, span = spanAt(view, target);
            // A node the index does not know is not composed, whatever the view shows; a node with no visible position is.
            const exactIn = (rect: Readonly<Rect>): boolean => {
                const x0 = Math.max(span.x0, Math.floor(rect.x * target / EDGE));
                const x1 = Math.min(span.x1 - 1, Math.ceil((rect.x + rect.width) * target / EDGE) - 1);
                const y0 = Math.max(span.y0, Math.floor(rect.y * target / EDGE));
                const y1 = Math.min(span.y1 - 1, Math.ceil((rect.y + rect.height) * target / EDGE) - 1);
                for (const band of BANDS) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    if (statusAt(band, target, x, y) !== 'ok') return false;
                }
                return true;
            };
            for (const id of ids) {
                const rects = parts.boundsOfNodes(new Set([id]));
                if (rects.length && rects.every(exactIn)) out.add(id);
            }
            return out;
        },
        memoryBlocked(): boolean {
            return !disposed && waiting && blockedOnGpu && !indexing && finished.length === 0;
        },
        needsFrame(): boolean {
            if (disposed || denied || !presenting) return false;
            if (waiting) return indexing || finished.length > 0;
            return indexing || !settled || building.size > 0 || finished.length > 0 || inexactPending.size > 0;
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
