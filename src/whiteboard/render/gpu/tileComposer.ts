// The board's tile composer. A tile is one slice of one position of one band at one scale: its parts are composed on
// the GPU by the item routes into a render target, and the frame lays each target on the surface as a quad. Design:
// planning/60-implementation/gpu-handoff/PLAN.md §3.1 (scale policy, slices, compose limit, dirty, stand-ins).
// The routes, the tile store and the parts index are injected, so this module imports no route and no store.
import type { Rect, ViewState } from '../../../platform/types';
import type { IsolationReservation, LayerHost, TexturedQuadSpec } from '../../../platform/render/compositor.types';
import { IsolationShortfall } from '../../../platform/render/gfx/webgl2Isolation';
import { ArenaError } from '../../../platform/render/resourceArena';
import type { GfxDevice, GpuPass, GroupToken, RectI, RgbaP, TextureHandle } from '../../../platform/render/gfx/api';
import type { FrameBudget, GpuReleaseReason, OffscreenPasses } from '../../../platform/render/types';
import { tileTargetBytes, tileView } from '../../../platform/render/tileTarget';
import { auditCount, auditDrawn, auditGpuError, auditStage, auditTape, renderAuditEnabled, type AuditStage } from '../../../platform/render/renderAudit';
import { TILE_EDGE, TILE_GUTTER, TILE_SIZE } from '../imageSampling';
import { isBudgetRefusal } from '../budgetRefusal';
import type { PaintBand } from '../material';
import type { PaintClip, PaintInkItem, PaintItem } from '../paintStream';
import { everyClipIsRectangle, type AdmitClips, type PreparedClips } from './routePath';
import { exactTileScale as exactScale, tileKeyNum, TileKeyMap } from './tileKeys';
import { lowerTileKey, type NumericTileStore } from './tileStore';
import { blendOf, OmitTracker } from './tileParts';
import { VIDEO_FRAME_PREFIX } from '../../media/videoFrames';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';
import type { PaintResources2d } from '../reference/paint2d';
import type {
    Blend, InkRouteFor, ItemRoute, LiveEviction, PreparedRun, TileEntry, TileKey, TileParts, TilePart, TileWorldFn,
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
/** The most own-frees a refused position at rest makes in one frame before it is rastered on the CPU or waits (drive). */
const FREE_RETRY_ROUNDS = 8;
// A live part's admission is tried again within the frame while its budget has time: 4 tries at most, so a route that stays deferred
// costs a bounded share of the frame.
const LIVE_ADMIT_ATTEMPTS = 4;
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
/** The routes whose live part draws a pure function of its item and the view: path (exact area or coverage) and ink. */
const EXACT_LIVE_ROUTES: ReadonlySet<string> = new Set(['path', 'ink-analytic', 'ink-union']);
/** A route that can report its kit's draw refusal for the frame (the path route, gpu-h4's kit). Not on ItemRoute: contracts.ts is not edited. */
type RouteWithRefusal = { drawRefusedThisFrame?(): boolean };
/** The compose passes in order: the foreground takes visible missing positions first, the background dirty ones first. */
const DIRTY_FIRST = ['dirty', 'missing', 'ring'] as const;
/** Dirty positions under a pending region composed per frame. Their changed pixels are drawn live meanwhile (the region cover), so the
 * picture is current either way; composed all at once they were the gesture's worst frames (measured, DPR 2 dark: a commit and a drag's
 * end composed 4 to 7 dirty tiles in one frame, 25 to 50 ms of GPU). */
const DIRTY_COVERED_PER_FRAME = 1;
const MISSING_FIRST = ['missing', 'dirty', 'ring'] as const;
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
    /** The frame whose compose last advanced the position, or found it parked on a wait the governor will wake (audit: orphans). */
    drivenFrame: number;
    /** The GPU bytes its last admission was denied (0 when it was not): visible demand while it waits (settleVisibleWait). */
    deniedGpu: number;
}
/** Tile positions across a view, as integer coordinates with exclusive ends. */
interface Span { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
/** One tile to lay this frame. Pooled: a steady frame rewrites its fields and allocates nothing. */
interface Draw {
    band: PaintBand; texture: TextureHandle | null; mode: Mode;
    /** The drawn entry's compose generation (entryGen): a tile recomposed into the texture it already had draws new pixels. */
    gen: number;
    /** The tile's interior, in world units. */
    x: number; y: number; w: number; h: number;
    /** A stand-in is clipped to the position it covers; device pixels. */
    clipOn: boolean; cx: number; cy: number; cw: number; ch: number;
    /** The ink nodes of the tile, added to the drawn-ink set when the draw is laid. */
    ink: readonly string[];
    /** A live part's admitted run and the route that admitted it, drawn under the clip; null for a tile draw. */
    live: PreparedRun | null;
    liveRoute: ItemRoute | null;
    /** The paint item a live part draws (its identity, for the draw signature); null for a tile draw. */
    liveItem: object | null;
    /** The node a live part belongs to, added to the band's drawn-live set when the part is laid. */
    node: string;
    /** Drawn for a covered position, or one whose tile replaced its cover this frame: signed as its position (coverSignature). */
    cover: boolean;
}

/** A live part admitted for this frame: its run and the route that owns it, retired by that route. */
interface LiveAdmission { readonly route: ItemRoute; readonly run: PreparedRun }

/** The item routes a composer draws through. `cpu` takes what a GPU route refuses; its own counters name that raster. */
export interface TileRoutes {
    readonly path: ItemRoute & Partial<ZoomRoute>;
    readonly inkAnalytic: ItemRoute<PaintInkItem>;
    /** `exact` is false for a run that drew a stroke from another band's outline while its own uploaded (routeInk.ts admitArea). */
    readonly inkUnion: ItemRoute<PaintInkItem> & Partial<Pick<ZoomRoute, 'exact'>>;
    /** Absent until the route is built: its items are then rastered by `cpu`, counted as a fallback. */
    readonly image?: ItemRoute & Partial<PictureRoute>;
    readonly text?: ItemRoute & ZoomRoute;
    readonly cpu: ItemRoute;
}
/** The text route's zoom hooks (gpu-h8). `setZoom` is called once per frame before the admits: while it is true a missing exact mask is
 * drawn from its cached stand-in, never rastered. `exact` is false for a run that drew one: its tile recomposes exact once the camera rests. */
export interface ZoomRoute { setZoom(zooming: boolean): void; exact(run: PreparedRun): boolean }
/** The image route's picture hooks: it plans a large picture's finer tiles per composed tile, with the byte share of the screen named
 * once per frame (`setScreen`). A run that left out tiles still decoding names them (`waits`); its entry is kept aside without asking
 * frames, and is marked dirty once none is `waiting` (the decode's settlement invalidates the frame that finds it so). */
export interface PictureRoute {
    setScreen(world: Rect | null): void;
    pump(budget: FrameBudget): void;
    waits(run: PreparedRun): readonly string[] | null;
    waiting(keys: readonly string[]): boolean;
}
/** A route that needs the paint's resources (decoded images, path and clip geometry); called once per paint, before admit. */
export interface ResourcedRoute { useResources?(resources: PaintResources2d): void }
/** Lays a composed texture on the current surface. `modulate` multiplies the surface by it; `dest` is in device pixels. */
export type TileLay = (pass: GpuPass, texture: TextureHandle, source: Readonly<Rect>, dest: Readonly<Rect>, blend: Blend) => void;
/** Lays a batch of 'over' quads of one tile texture in one call (the host's batched quads, one GPU draw). */
export type TileLayQuads = (pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[]) => void;

/** The geometry service a live zoom pins (services.pinVisible / releasePins), as the composer uses it. A zoom frame pins the visible
 * nodes (every band of them is kept); a rest releases the pins, and they also lapse by time. Absent: nothing is pinned. */
export interface GeometryPins {
    pinVisible(ids: Iterable<string>): void;
    releasePins(): void;
}

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
    /** The geometry pins a live zoom holds (see GeometryPins). */
    readonly pins?: GeometryPins;
    /** True while the governor reports a slow GPU: the compose limit halves. */
    readonly slowGpu?: () => boolean;
    /** Frees up to `bytes` of the routes' own GPU caches that no admission holds and neither `frame` nor the frame before it used
     * (idle edge and coverage buffers, cached textures); returns the bytes freed. A refused position at rest asks it (freeOwn). */
    readonly reclaimRoutes?: (bytes: number, frame: number) => number;
    /** An overlay (a drag's preview): a paint of a few plain 'over' parts is drawn live each frame at the view, with no tiles, so
     * no tile grant can stall it. A paint over the threshold, or with a part that needs tiles, composes tiles as before. */
    readonly liveOverlay?: boolean;
    /** The content draws the same pixels live and from its tiles (a notebook's paper): settling ends as soon as the tiles are exact, and
     * the switch answers unchanged. Other content settles until the camera moves (a stroke's tip can differ by a sample). */
    readonly liveMatchesTiles?: boolean;
    /** Whether a pointer is down (a stroke, a drag, a marquee): the frame changes for that input anyway, so settling may end in it. */
    readonly inputActive?: () => boolean;
}

export interface TileComposer {
    /** Indexes `prepared`, composes what the view needs within the frame's limit, and fixes what this frame draws. `null`
     * (nothing presented) draws nothing. `omit` is the nodes a drag previews elsewhere: their tiles are composed without them. */
    /** Prepares one frame. True when anything visible changed since the previous call: a position composed, cancelled or dropped, a
     * store slot freed for it, an invalidation, an index still settling, or a different draw list. False only when the frame draws
     * exactly what the previous one drew. The caller must still treat a frame it did not present as changed. */
    prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): boolean;
    /** Indexes `prepared` to completion within `maxMs`, outside any frame (the overlay's pointer-down build). True once the index
     * holds it; false when the deadline came first, and the next call (or the frame's prepare) continues the same build. */
    warm(prepared: PreparedPaint2d, maxMs: number): boolean;
    /** Encodes the composed targets of one band; the frame's surface pass then draws them with `drawGpu`. */
    encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void;
    /** Whether the frame of the last encodes was submitted: a tile composed into a frame that was discarded is let go, so its position
     * reads missing and composes again (see Layer.offscreenSettled). Idempotent per frame: each band's layer forwards it. */
    offscreenSettled(submitted: boolean): void;
    /** Lays the frame's tiles of one band. Draws only: no allocation, no upload, no readback. */
    drawGpu(pass: GpuPass, view: ViewState, band: PaintBand): void;
    coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean };
    /** The ids whose every visible position is composed exactly at the drawn scale (no stand-in, no dirty tile, no index in
     * progress). The board shows a wet stroke until its node is in this set, so committed and wet ink overlap, never gap. */
    inkComposed(view: ViewState, ids: ReadonlySet<string>): Set<string>;
    /** The ink node ids in the tiles drawn by the last drawGpu calls of this composite. Filled in drawGpu, cleared in prepare;
     * one set reused for the composer's life. */
    drawnInkNodeIds(): ReadonlySet<string>;
    /** The nodes whose live parts this composite lays in one band (a live part deferred or denied this frame is absent). Filled in
     * drawGpu, cleared in prepare, one set per band for the composer's life. */
    drawnLiveNodeIds(band: PaintBand): ReadonlySet<string>;
    /** The band's last draw laid nothing on the surface (an empty draw list, or none of its draws in the band). */
    drewNothing(band: PaintBand): boolean;
    /** The nodes whose live parts this prepare planned to lay in one band: the draw list's live draws, known once prepare returns, before
     * any draw. Cleared at the next prepare. The board reads it for coverage, which runs before the composite's own draw. */
    plannedLiveNodeIds(band: PaintBand): ReadonlySet<string>;
    /** The GPU bytes the visible tiles at the drawn scale hold, for a viewport of `width` by `height` (view units): one
     * tile target per slice of each visible position that is composed. The governor's mandatory working set. */
    mandatoryBytes(width: number, height: number): number;
    /** True while this frame must not replace the picture on screen: it would take off the screen an item the last drawn frame showed
     * (a position it showed now has no picture, or a draw it planned was refused). Bounded by HOLE_HOLD_MS from the first such frame,
     * after which the frame is presented and counted (present:missing:hold-expired). The layer reads it as critical. */
    holding(): boolean;
    /** The last drawn frame left an item in view out (a hole, or a live part it could not admit and no tile showed): the board is
     * not current, whether or not anything can make progress now, and says so. */
    incomplete(): boolean;
    /** False while nothing can make progress this frame: composed and settled, or waiting for memory. */
    needsFrame(): boolean;
    /** True while the composer waits on a refused GPU admission and has no other work (no indexing, nothing finished to encode): a
     * budget refusal defers the composer, it never holds the frame. */
    memoryBlocked(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    release(reason: GpuReleaseReason): void;
    /** The adapter evicted something a draw list may hold (a tile, a texture or a coverage set): no list built before is drawn again. */
    noteEvicted(): void;
    /** How the last prepare's draw list draws the view, for an eviction (LiveEviction): live while it moves (a zoom or a pan drawn
     * direct), live while it settles, or not live. */
    liveEviction(): LiveEviction;
    /** A value that moves with what the composite draws (see contentVersion): equal keys mean the same picture. */
    contentKey(): number;
    /** True when the draw list cannot be drawn for this view (an eviction or a camera change since it was built, and no prepare since). */
    listInvalid(view: ViewState): boolean;
    dispose(): void;
}

/** The most parts a live-only overlay draws each frame; a larger paint composes tiles (its per-frame admission is the cost). */
const LIVE_OVERLAY_MAX_PARTS = 256;
/** The most visible parts a zoom draws live, at the view, instead of from tiles (zoom-direct): a zoom of a few hundred plain parts. */
const ZOOM_DIRECT_MAX_PARTS = 512;
/** The most items one GPU route run holds. A route admits a run whole or defers it, and a deferred run starts again from its first item
 * the next frame; a slice resumes run by run (admitSlice). Unbounded, one tile of the 10,000-stroke old board at its whole-board view
 * was a single union-ink run of ~5,000 strokes whose admission never fit one frame: it deferred at every vsync for good (measured,
 * WebGL2 with the CPU throttled 3x: 5,036 stroke admissions and one deferral per frame). The CPU route rasters a run as one scrap, so
 * its runs are not split. */
const RUN_MAX_ITEMS = 256;
/** The most parts a frame draws live to fill visible positions no tile of any scale pictures (live fill, see fillLive): the zoom-direct
 * bound, so a fill costs at most what a live zoom frame does. */
const LIVE_FILL_MAX_PARTS = 512;
/** How long a frame that would lose an item the screen shows is held (the previous picture stays) before it is presented anyway, counted
 * (present:missing:hold-expired). Bounded so a hole that cannot fill (memory refused, a slow compose) costs a stutter, never a freeze. */
const HOLE_HOLD_MS = 250;
/** The floor: a coarse picture of the view's neighbourhood, FLOOR_VIEWS viewports each side, composed at rest after the ring at the
 * power-of-two scale at which that whole region spans at most FLOOR_PIXELS (two tiles) across. It is kept through zooms and pans as the
 * last stand-in: zooming out of a dense board reveals far more than its ring, and no compose can keep up with it (measured, the 3 MB
 * read-only board pinched out from 456% in half a second: up to every stroke gone from the frames for 1.5 s). Composed as prefetch,
 * so it only takes room that is free. */
const FLOOR_VIEWS = 3;
const FLOOR_MAX_PARTS = 2048;
const FLOOR_PIXELS = 2 * EDGE;
/** The most tiles a rest margin composes beyond the visible span, each side (one viewport, bounded). */
const RING_MAX_TILES = 8;
/** The tiles each side of the view the ring holds: one while zooming, at rest a viewport each side (bounded). The compose pass and the
 * still-wanted test use the same margin: the test kept one tile, so every ring position past it was cancelled each frame and begun
 * again (measured, dark notebook at 332%, DPR 2: 64 positions cancelled, begun and refused per frame at rest, 60 frames a second). */
function ringMargin(span: Span, zooming: boolean): number {
    return zooming ? 1 : Math.min(RING_MAX_TILES, Math.max(1, span.x1 - span.x0, span.y1 - span.y0));
}
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
/** The changed regions a frame keeps pending: a bounded list, so a long drag cannot grow it past what a frame can lay live. */
const PENDING_REGION_LIMIT = 64;
function overlapsRect(a: Readonly<Rect>, b: Readonly<Rect>): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
/** The surface pixels a world rectangle may touch, rounded outward: a cut-out never leaves a stale pixel at its edge. */
function surfacePixels(view: ViewState, world: Readonly<Rect>): Rect {
    const cam = view.camera, scale = cam.z * view.viewport.dpr;
    const left = Math.floor((world.x - cam.x) * scale), top = Math.floor((world.y - cam.y) * scale);
    const right = Math.ceil((world.x + world.width - cam.x) * scale), bottom = Math.ceil((world.y + world.height - cam.y) * scale);
    return { x: left, y: top, width: right - left, height: bottom - top };
}
/** The parts of `rect` outside every hole, as disjoint rectangles: at most four per hole cut. */
function subtractRects(rect: Rect, holes: readonly Rect[]): Rect[] {
    let pieces: Rect[] = [rect];
    for (const hole of holes) {
        const next: Rect[] = [];
        for (const piece of pieces) {
            const px1 = piece.x + piece.width, py1 = piece.y + piece.height;
            const x0 = Math.max(piece.x, hole.x), y0 = Math.max(piece.y, hole.y);
            const x1 = Math.min(px1, hole.x + hole.width), y1 = Math.min(py1, hole.y + hole.height);
            if (x1 <= x0 || y1 <= y0) { next.push(piece); continue; }
            if (y0 > piece.y) next.push({ x: piece.x, y: piece.y, width: piece.width, height: y0 - piece.y });
            if (y1 < py1) next.push({ x: piece.x, y: y1, width: piece.width, height: py1 - y1 });
            if (x0 > piece.x) next.push({ x: piece.x, y: y0, width: x0 - piece.x, height: y1 - y0 });
            if (x1 < px1) next.push({ x: x1, y: y0, width: px1 - x1, height: y1 - y0 });
        }
        pieces = next;
    }
    return pieces;
}

export function createTileComposer(options: TileComposerOptions): TileComposer {
    const { host, audit, parts, store, routes, tileWorld, inkRouteFor, lay, layQuads, admitClips, withPreparedClips, pins } = options;
    const routeList: ItemRoute[] = [routes.path, routes.inkAnalytic, routes.inkUnion, routes.image, routes.text, routes.cpu]
        .filter((route): route is ItemRoute => route !== undefined);
    const uploadPrepared = (): void => { for (const route of routeList) route.uploadPrepared?.(); };
    let resourcesSeen: PaintResources2d | null = null;
    // Slots live beside their entries (keyed by the entry object), so an entry the store drops takes its slot with it.
    const slots = new WeakMap<TileEntry, Slot>();
    // Entries encoded with a run that drew a stand-in (the text route's zoom). They recompose exact once the camera rests: the last
    // zoom frame's entries are the ones at the scale the camera rests on, so the set is cleared at the start of each zoom frame.
    const inexactPending = new Set<TileEntry>();
    // Entries composed while finer picture tiles they cover were still decoding, with those tiles (PictureRoute). Never a reason for
    // a frame: recomposing a tile whose decode is still in flight drew the same pixels again each vsync (gpu-f1).
    const awaitingDecode = new Map<TileEntry, readonly string[]>();
    // The screen named to the image route each frame, rewritten in place (the route copies what it keeps).
    const screenScratch: Rect = { x: 0, y: 0, width: 0, height: 0 };
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
    // The ink the last draw drew, kept until the next frame's draw starts: a prepare reads what is on screen. Cleared at each prepare, it
    // read empty in every other layer's prepare and full after this draw, so the wet layer's picture key flipped on its hand-over flag
    // and presented the same picture again once per stroke (measured: 20 of the 33 redundant GPU presents over five documents).
    const drawnInk = new Set<string>();
    let drawnInkFrame = -1;
    /** Ink nodes with a live part this frame's prepare did not admit (deferred, denied): this frame will not draw them, so they leave
     * drawnInk at once, though the picture on screen still has them. The wet layer reads drawnInk in its own prepare, after this one,
     * and lets go of a stroke it finds there: kept, a deferred re-admission of the committed stroke left it on neither layer for a
     * frame (measured: pen-up on a notebook, 5,897 px for one frame). */
    const liveInkDropped = new Set<string>();
    // The nodes whose live parts the composite lays, per band: filled in drawGpu beside the live draw, cleared in prepare. The board
    // trusts a changed node as drawn only when it is in this set, so a live part that was deferred or denied is not counted.
    const drawnLive: Record<PaintBand, Set<string>> = { underlay: new Set<string>(), content: new Set<string>() };
    // The same nodes as the prepare planned them: filled as buildDraws adds each live draw, cleared at the next prepare. A deferred or
    // denied part never reaches a draw, so it is absent here too. drawnLive stays the truth check for what the composite laid.
    const plannedLive: Record<PaintBand, Set<string>> = { underlay: new Set<string>(), content: new Set<string>() };
    // Whether the band's last drawGpu laid any draw: a cleared overlay that drew nothing leaves the picture as it was.
    const drewAny: Record<PaintBand, boolean> = { underlay: false, content: false };
    // Live parts: admitted each frame through the image route, released at the next prepare. Scratch holds the ones of the
    // position being drawn, in paint order.
    const liveRuns: LiveAdmission[] = [];
    const liveAdmitted = new Map<PaintItem, LiveAdmission | null>();
    // The phase whose admission of an item was deferred. A deferral in the foreground call is not the frame's answer: the background
    // call of the same frame retries it once, with its own window, instead of reading the refused null (measured: a path part
    // deferred in the foreground showed as an uncovered position in the background call, with nothing retried).
    const liveDeferredBy = new Map<PaintItem, string>();
    // A live part deferred this frame asks for the next one. Consecutive deferred frames are counted and the asking stops at the
    // retry limit (a part that never fits its upload budget must not keep the board framing at rest).
    let liveDeferredNow = false, liveDeferredFrames = 0;
    // Live parts admitted by the end of the last frame, and the most any deferred frame of this run reached: a deferred frame that
    // admitted more than any before it made progress (its uploads resume where they stopped), so it does not count toward the stop.
    // Counted per frame alone, a board opening among ten dense tabs stopped asking after 12 deferred frames with 278 of 405 strokes
    // still to upload, and rested on part of its strokes (no frame came to admit the rest).
    let liveAdmittedNow = 0, liveAdmittedBest = 0;
    // A part reaching the view of a live frame was not admitted while its draws were built (deferred, denied, unsupported): the frame
    // then draws from tiles instead (buildDraws), so no item the view holds is left out of it.
    let liveMissed = false;
    // The positions this frame's draw list leaves with no picture while parts reach them (holes), and those of them whose world the
    // last drawn frame showed (regressions: the frame would take an item off the screen). A regression holds the frame (holding).
    let frameHoles = 0, frameRegressions = 0, holeCause = '';
    // A draw this frame planned was refused on the surface or in its encode (a route's draw, a live part, a tile's encode): what it
    // planned is not all laid, so the frame is held like a regression.
    let drawRefusedNow = false;
    // When the current run of held frames began (performance.now), -1 when the last frame was not held; and the frame last judged.
    let holdSince = -1, holdFrame = -1, holdNow = false, holdRefused = false;
    // The last frame's draw was refused (read by the next prepare: its hold's clock runs on until a frame is laid whole).
    let refusedBefore = false;
    // The world the last drawn frame's view showed (both bands draw one view), and live parts drawn this frame to fill positions.
    const shownWorld: Rect = { x: 0, y: 0, width: 0, height: 0 };
    let shownValid = false, shownFrame = -1, fillParts = 0, missingCounted = -1;
    // The floor's scale and span (see FLOOR_VIEWS), fixed at rest and kept through a zoom or a pan; 0 and null when there is none.
    let floorScale = 0, floorSpan: Span | null = null;
    // The floor last weighed (its scale, span and the scene revision): a region is counted once, not at every rest frame.
    const floorChecked = { scale: 0, x0: 0, y0: 0, x1: 0, y1: 0, revision: -1 };
    // The world rectangles of this frame's holes, and the last drawn frame's: a position that was a hole there showed nothing, so its
    // hole now takes nothing off the screen (an opening board's progressive tiles are not regressions).
    let curHoles: Rect[] = [], lastHoles: Rect[] = [];
    // A part of a cut is drawn inside its pieces only (pixel-disjoint from the tile pieces beside them); any other part, inside the clip.
    const liveScratch: { order: number; run: PreparedRun; route: ItemRoute; nodeId: string; item: object; pieces?: readonly Rect[] }[] = [];
    // A stand-in entry to lay for a position, clipped to the part of the position it pictures (surface pixels).
    const standScratch: { order: number; entry: TileEntry; slot: Slot; clip: Rect }[] = [];
    // Batch scratch: the quads of one call, reused. The pool holds spec objects for the composer's life.
    const quadPool: { sourceRect: Rect; destRect: Rect }[] = [];
    const quadList: TexturedQuadSpec[] = [];
    let drawCount = 0;
    // A draw list is drawable while nothing it draws can have been evicted since it was built and the camera is the one it was
    // built for. evictEpoch moves at every prepare and at every eviction the adapter makes; a list from an earlier frame that a
    // later prepare did not touch (a live-only or not-yet-current frame skips the prepare) still draws, the same picture.
    let drawsEpoch = -1, evictEpoch = 0, drawsFrame = -1;
    const drawsCam = { x: NaN, y: NaN, z: NaN, w: NaN, h: NaN, dpr: NaN };
    // Set when a draw list is not usable for the view asked: the next frame must prepare, and the layer is critical until it does.
    let wantFrame = false;
    // The store keys of the tiles this frame's encode composed, until the frame is settled (offscreenSettled). A tile is marked
    // composed when its pass is recorded; a frame discarded after that (its uniform ring refused a critical draw, another layer threw)
    // never wrote the target, and the position would draw that target's old or uncleared pixels for good.
    let composedUnsettled: TileKey[] = [];
    const listUsable = (view: ViewState): boolean => drawsFrame === frame || (drawsEpoch === evictEpoch && drawsCam.x === view.camera.x &&
        drawsCam.y === view.camera.y && drawsCam.z === view.camera.z && drawsCam.w === view.viewport.width &&
        drawsCam.h === view.viewport.height && drawsCam.dpr === view.viewport.dpr);

    let disposed = false, presenting = false, indexing = false;
    // This frame's zoom, set in prepare: while zooming, coverage does not hold the frame for a position with nothing (see coverage).
    let zoomingFrame = false, panned = false;
    // The kinds of store edit this prepare made (one bit each: a position composed, cancelled or dropped, a slot freed, an
    // invalidation), so a 'changed' answer names its reasons as audit counters. The answer itself is the draw signature (see prepare).
    let editBits = 0;
    const EDIT_SUPERSEDED = 1, EDIT_EMPTY = 2, EDIT_CANCEL = 4, EDIT_FREE = 8, EDIT_DONE = 16, EDIT_SCALES = 32, EDIT_INVALID = 64;
    // The content version moves on every change to what the composite draws that the draw signature cannot see: an eviction the adapter
    // made, a live part drawn (its pixels change), an index in progress. contentKey() reads it with the draw signature, which holds each
    // drawn entry's compose generation, so a store edit changes the key only where it changes a drawn tile. Counting every edit here
    // (a ring position composed, a build cancelled, an unused scale dropped) presented the unchanged picture again: measured, 26 of 52
    // redundant zoom presents named only such edits, and a new paint frame's resources object 31 of 31 at rest.
    let contentVersion = 0;
    const editEvent = (bit: number): void => { editBits |= bit; };
    // Each entry's compose generation, moved when its position is composed (the pixels its texture will hold): see Draw.gen.
    const entryGen = new WeakMap<TileEntry, number>();
    let genCounter = 0;
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
    // The GPU wait is a position's (its target or its admission refused), so new room is kept for it (see drive). A live part's refusal
    // is not: the live draw stands in for tiles not yet composed, and composing them is what ends it. Read as one, the live draw's
    // refusal stopped every missing compose, so the tiles that would replace it never came (measured, the ten-tabs case: a first visit
    // with 87 to 278 of ~450 strokes missing under 'Updating…' for good, its grant full of the live draw's ink edges).
    let roomForPosition = false;
    // The deadline (performance.now) of the armed retry; 0 when none is armed or it was satisfied. A deadline that fires with nothing
    // to do is a no-op: the layer's wake slot is shared with the store's trim deadline, so it is not cancelled with null.
    let retryAt = 0;
    let retryDelay = GPU_RETRY_MS, retryMisses = 0;
    // The paint's live-part flag, scanned once per paint version: a stand-in position queries the parts index only when set.
    let paintScanned: PreparedPaint2d | null = null, paintHasLive = false, paintLiveOnly = false;
    // The frame draws its visible parts live at the view, with no tile: a live-only paint, or a zoom whose visible parts are plain
    // (zoom-direct). Set per prepare once the index is known; tiles are composed when it is off (at rest).
    let liveNow = false;
    // A settling frame: a frame at rest after a direct (live) zoom or pan frame. It keeps drawing the visible parts live, as the direct
    // frame did, and composes the tiles meanwhile (encoded without a present); the draw list goes back to tiles at the next camera move,
    // a frame that presents anyway. Shown as stand-ins until composed, a paced zoom went exact-live, blurred stand-in, exact-live at every
    // step (gpu-f2, notebook: 21 stand-in presents a phase); switched to tiles as soon as composed, the switch presented again, pixel for
    // pixel the same on the paper (19 redundant presents a phase) and a slight edge change on the board.
    // A repeated settling frame (same camera, no scene change) draws the same live picture, so it does not move the content version.
    let directBefore = false, settling = false, settleRepeat = false;
    // The camera at which the last prepare found every visible tile exact; whether this frame is a quiet switch to them, and whether
    // its intake changed anything on the board.
    let exactAtX = Number.NaN, exactAtY = Number.NaN, exactAtZ = Number.NaN, quietSwitch = false, invalidatedNow = false;
    /** A live draw of the frame admitted a run its route marked inexact (a path area on the zoom-time coverage route, a text stand-in):
     * the next settling frame at the same camera draws it exact, so it is not a repeat and presents. Measured (notebook, 40% after a
     * zoom step): without it the zoom's last coverage picture stayed up at rest, paper ruled lines 11 levels off the exact picture. */
    let liveInexact = false, settleInexact = false;
    // The last live draw left finer picture tiles out (decoding or uploading): its runs are not the picture to repeat. Unlike an
    // inexact run it asks for no frame: the decode's settlement brings the next one, which admits the parts afresh (PictureRoute).
    let liveStale = false;
    let settleCamX = Number.NaN, settleCamY = Number.NaN, settleCamZ = Number.NaN;
    let device: GfxDevice | null = null;
    let frame = 0, validRevision = 0;
    let omitIds: ReadonlySet<string> | null = null;
    // Nodes that left the omit set while their tiles lack them: drawn live until the tiles under them are composed (see prepare).
    // The value is the frame it left: a tile encoded from that frame on already holds the node, so its live part is skipped.
    const heldNodes = new Map<string, number>();
    // Changed regions (world rects) whose tiles are still dirty: a dirty tile's pixels are cut out where a region is, and the parts
    // reaching the region are drawn live instead, until no dirty tile under it is in view. Bounded: the oldest is dropped past the
    // limit, and its tiles then draw as before, flagged stale.
    const pendingRegions: Rect[] = [];
    // The positions whose dirty tiles this frame's live parts cover (positionKey): their picture is current, not stale.
    const coveredPositions = new Set<number>();
    // The dirty positions under a pending region whose cover this frame's draws could not lay (its node no longer drawn live: a card
    // deselected, an embed the overlay draws): they show stale until composed, so the next compose does not defer them.
    const uncoveredPositions = new Set<number>();
    // Last frame's, read when this frame's draws are built: a position covered then and composed since shows the same picture.
    let lastCovered = new Set<number>(), spareCovered = new Set<number>();
    // The draw-list signature of the covered positions (and those whose tile replaced their cover this frame): each as its position and
    // clip only, not its textures or live parts. Swapping a cover for its fresh tile changes no pixel, and counted as a change it
    // presented once per staggered tile (gpu-f1's doc12 tape: 2 redundant presents per stroke at pen-up, 4 in a paced draw).
    let coverSignature = 0;
    // A position whose tile replaced its cover keeps signing as its position while it draws the tiles it swapped to (their texture and
    // generation, hashed): untagged the frame after the swap, its draws signed in full moved the signature over the same picture (the
    // next present after each swap was redundant). A recompose changes the hash and ends the tag; a position not drawn loses it.
    let swappedTiles = new Map<number, number>(), spareSwapped = new Map<number, number>();
    // A live draw refused on the surface (an unplanned isolation target, a full ring) left that frame's cover without the part: the
    // next prepare answers changed so its cover is presented. Signed by position alone, the refused cover stood, and so did every swap
    // after it (kinds arrow-label, WebGL2 light DPR 1: the arrow's body missing for good, its label clip's first live draw refused).
    let liveRefusedSerial = 0, liveRefusedSigned = 0;
    // Two-phase frames (budget.phase): the foreground call of frame `foregroundFrame` leaves its target, span, zoom and edit count for the
    // background call of the same frame. `frameComposed` counts this frame's composes across both calls, so the limit stays per frame.
    let foregroundFrame = -1;
    let fTarget = 0, fZooming = false;
    let fSpan: Span = { x0: 0, y0: 0, x1: 0, y1: 0 };
    let frameComposed = 0;
    // Dirty positions under a pending region driven this frame (see DIRTY_COVERED_PER_FRAME), keyed by position: a resumed one counts once.
    const frameDirtyCovered = new Set<number>();
    // The group targets this layer's mask clips need (an arrow's body cut around its label: an evenodd clip), learnt from the first
    // draw the isolation pool refused, and reserved at every prepare that encodes tiles or draws live parts. The compositor plans a
    // shortfall only when one reaches its own catch; the composer catches it as a budget refusal, so unreserved the tile was refused
    // every frame for good (kinds kit arrow-label, WebGL2 DPR 2 dark: 369 refused encodes, the label never shown, 470 textures in 6 s).
    let isolationNeed: IsolationReservation | null = null;
    /** Declares the learnt need for a frame that encodes tiles or draws live parts; a frame of composed tiles alone needs none. A frame
     * whose compositor refused its own prepare has no plan to declare into (invalid-input), and it encodes and draws nothing either. */
    const reserveIsolationNeed = (need: IsolationReservation): void => {
        let live = finished.length > 0;
        for (let i = 0; !live && i < drawCount; i++) if (draws[i].liveRoute) live = true;
        if (!live) return;
        try { host.reserveIsolation(need); auditCount(audit, 'isolation:reserved'); }
        catch (error) { if (!(error instanceof ArenaError)) throw error; auditCount(audit, 'isolation:unplanned'); }
    };
    const noteShortfall = (error: unknown): void => {
        if (!(error instanceof IsolationShortfall)) return;
        const { request } = error, bounds = isolationNeed?.bounds;
        isolationNeed = { depth: 0, maskDepth: Math.max(isolationNeed?.maskDepth ?? 0, error.simultaneous),
            bounds: { x: 0, y: 0, width: Math.max(bounds?.width ?? 0, request.width), height: Math.max(bounds?.height ?? 0, request.height) },
            format: request.format ?? 'rgba8', samples: request.samples, stencil: request.stencil };
        auditCount(audit, 'isolation:shortfall');
    };
    // The frame each tile entry was last encoded (its content's frame), read against heldNodes.
    const composedAt = new WeakMap<TileEntry, number>();
    let lastZoom: number | undefined;
    let pinsHeld = false;
    // The scale the last prepare composed and drew. Coverage describes this scale, not the exact demand: a zoom draws its
    // ladder scale, and coverage asked about the exact one, where nothing is composed, so every frame of a zoom read incomplete.
    let drawnTarget = 0;
    let drawnCamX = 0, drawnCamY = 0, drawnCamZ = 1;

    // The governor's wake for a refusal: the parked positions may be advanced again, and the board is asked for a frame.
    const wake = (): void => {
        for (const position of building.values()) position.parked = false;
        waiting = false; blockedOnGpu = false; roomForPosition = false;
        // The back-off is not reset here, only by a compose that lands: a wake comes for any release that fits the size waited for,
        // the refused position's own frees included, and reset by each, the retry ran every 250 ms for good.
        if (retryAt !== 0) { retryAt = 0; host.wakeAt(null); }
        host.invalidate('tile-composer-capacity');
    };
    // Arms the retry deadline for a visible GPU refusal, once: a deadline already armed for later stands.
    const armRetry = (): void => {
        const now = performance.now();
        // A wait already woken (the refused position's own frees can wake it inside the same drive) has nothing to retry: armed then,
        // the deadline outlived the wait and nothing cleared it.
        if (!waiting || retryAt > now) return;
        if (++retryMisses > GPU_RETRY_LIMIT) { auditCount(audit, 'compose:retry:stopped'); return; }
        retryAt = now + retryDelay;
        retryDelay = Math.min(retryDelay * 2, GPU_RETRY_MAX_MS);
        host.wakeAt(retryAt);
    };
    // The GPU bytes the visible work waiting on the governor needs: each parked visible position's tiles not yet acquired and the bytes
    // its admission was denied, and this frame's denied live parts. Reported with the composed visible tiles as the pane's pinned demand
    // (mandatoryBytes), which the governor grants before any share: counted from composed tiles alone, refused visible work was not
    // demand at all, so a pane's share stayed under it while the pool had room below its trim line, and the pane rested on a stand-in
    // for good (measured, three dense boards after divider drags on WebGL2: two panes waiting at their own grant for a 4 MB text page
    // and six 1 MB tiles, the pool at 74 of its 87 MB line). Read from what waits, not from what a frame refused: a frame skips its
    // parked positions, and counted from its refusals the demand vanished under the waits it was meant to grant.
    let visibleWait = 0, liveWait = 0, liveWaitFrame = -1;
    /** At the end of a frame (`span` its visible positions): the bytes visible work waits for; the governor re-plans on a change. */
    const settleVisibleWait = (span: Span): void => {
        let next = liveWaitFrame === frame ? liveWait : 0;
        if (waiting) for (const position of building.values()) {
            if (!position.parked || (!position.lowered && !inSpan(span, position.x, position.y))) continue;
            for (const slice of position.slices) if (!slice.entry) next += TARGET_BYTES;
            next += position.deniedGpu;
        }
        if (next === visibleWait) return;
        visibleWait = next; host.demandChanged?.();
    };
    const refuseTarget = (): void => { denied = true; waiting = true; blockedOnGpu = true; roomForPosition = true; auditCount(audit, 'tile:denied'); store.wait(TARGET_BYTES, wake); };
    const refuseAdmission = (pool: 'gpu' | 'cpu', bytes: number, live = false): void => {
        denied = true; waiting = true; blockedOnGpu = pool === 'gpu'; auditCount(audit, 'tile:denied');
        if (!live) roomForPosition = blockedOnGpu;
        if (live && pool === 'gpu') {
            if (liveWaitFrame !== frame) { liveWaitFrame = frame; liveWait = 0; }
            liveWait += bytes;
            // Its wake is the retry deadline too: the pane's own live draw can hold the room it waits for, and no release then comes from
            // the governor. The retried frame's compose frees it (freeOwn); waited on the wake alone, the board drew no frame again.
            armRetry();
        }
        auditCount(audit, `refusal:${pool}:bucket:${2 ** Math.ceil(Math.log2(Math.max(1, bytes)))}`);
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

    /** The surface pixels of a world rectangle, rounded as clipOnSurface rounds a position (so two pieces of one position share their
     * seam pixel by pixel), inside `within`; null when none of it is there. */
    const pieceOnSurface = (view: ViewState, world: Readonly<Rect>, within: Readonly<Rect>): Rect | null => {
        const cam = view.camera, scale = cam.z * view.viewport.dpr;
        const left = Math.max(within.x, Math.round((world.x - cam.x) * scale)), top = Math.max(within.y, Math.round((world.y - cam.y) * scale));
        const right = Math.min(within.x + within.width, Math.round((world.x + world.width - cam.x) * scale));
        const bottom = Math.min(within.y + within.height, Math.round((world.y + world.height - cam.y) * scale));
        return right <= left || bottom <= top ? null : { x: left, y: top, width: right - left, height: bottom - top };
    };
    /** What the other scales picture of a position with no tile of its own, into `standScratch` (paint order is the caller's sort): the
     * nearest scale's cells first, then each farther scale only where the nearer ones leave part of the position bare, each cell clipped
     * to the part it fills, until the position is covered. A cell counts only when every slice of it is composed; a cell composed empty
     * covers its part with nothing, truly. True when the whole position is pictured. Only the nearest scale was asked before, and a
     * nearest scale holding a few cells left the rest of the position blank: zooming out of a dense board, whole frames showed nothing
     * where the coarser tiles had the picture (measured, the 3 MB read-only board pinched out from 456%: 36 frames over 1.5 s with every
     * stroke missing). */
    // The world pieces of the position the last standInPicture left bare (the whole position when it found nothing).
    let pictureRemaining: Rect[] = [];
    const standInPicture = (view: ViewState, band: PaintBand, scale: number, x: number, y: number, clip: Readonly<Rect>): boolean => {
        standScratch.length = 0;
        const world = tileWorld(keyOf(band, scale, x, y, 0));
        const list = store.standIns(band, world, scale, true);
        if (!list.length) { pictureRemaining = [world]; return false; }
        // Pieces narrower than half a device pixel are float error at the seams, not bare picture.
        const sliver = 0.5 / (view.camera.z * view.viewport.dpr);
        pictureRemaining = [world];
        let remaining = pictureRemaining;
        for (let i = 0; i < list.length && remaining.length;) {
            const at = list[i].key.scale;
            let end = i;
            while (end < list.length && list[end].key.scale === at) end++;
            for (let k = i; k < end && remaining.length; k++) {
                const head = list[k];
                if (head.key.slice !== 0) continue;
                const slot = slots.get(head);
                // A cell composed empty that a change has since overtaken says nothing of what is there now (the paint it was composed
                // from may have held less of the board): it covers nothing. One with content shows the board as it was, still a picture.
                if (!slot || (slot.count === 0 && head.dirty)) continue;
                const { x: cx, y: cy } = head.key;
                let whole = true;
                for (let s = 1; s < slot.count && whole; s++) {
                    const entry = entryAt(band, at, cx, cy, s);
                    whole = !!entry && entry.composed && !!entry.target && slots.has(entry);
                }
                if (!whole) continue;
                const cell = tileWorld(head.key);
                let reached = false;
                const next: Rect[] = [];
                for (const piece of remaining) {
                    if (!overlapsRect(piece, cell)) { next.push(piece); continue; }
                    reached = true;
                    if (slot.count > 0) {
                        const x0 = Math.max(piece.x, cell.x), y0 = Math.max(piece.y, cell.y);
                        const x1 = Math.min(piece.x + piece.width, cell.x + cell.width), y1 = Math.min(piece.y + piece.height, cell.y + cell.height);
                        const pixels = pieceOnSurface(view, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, clip);
                        if (pixels) for (let s = 0; s < slot.count; s++) {
                            const entry = s === 0 ? head : entryAt(band, at, cx, cy, s)!;
                            standScratch.push({ order: slot.firstOrder[s] ?? Infinity, entry, slot: slots.get(entry)!, clip: pixels });
                        }
                    }
                    for (const rest of subtractRects(piece, [cell])) if (rest.width > sliver && rest.height > sliver) next.push(rest);
                }
                if (reached) remaining = next;
            }
            i = end;
        }
        pictureRemaining = remaining;
        return remaining.length === 0;
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
                if (entry.key.scale !== floorScale && slots.has(entry) && exactUnder(band, scale, entry, span)) { victim = entry; break; }
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
    /** False for a run a zoom-aware route marked inexact (a text stand-in, a path composed on its zoom route): its tile recomposes at rest. */
    const exactRun = (route: ItemRoute, run: PreparedRun): boolean =>
        route === routes.text ? routes.text.exact(run) : route === routes.path && routes.path.exact ? routes.path.exact(run)
            : route === routes.inkUnion && routes.inkUnion.exact ? routes.inkUnion.exact(run) : true;
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
    /** Whether a zoom can draw its visible parts live: few enough, and each a plain 'over' part on a GPU route (the same rule as a live-only
     * paint, counted over the visible parts only). Otherwise the zoom draws from its tiles, as before. */
    /** Whether a visible position of any band has no exact tile at `target` (the content a pan would show as a stand-in). */
    const anyVisibleMissing = (view: ViewState, target: number): boolean => {
        const span = spanAt(view, target);
        for (const band of BANDS) for (let y = span.y0; y < span.y1; y++) for (let x = span.x0; x < span.x1; x++) {
            if (statusAt(band, target, x, y) !== 'ok') return true;
        }
        return false;
    };
    const zoomDirectOk = (view: ViewState, target: number): boolean => {
        const cam = view.camera;
        const world: Rect = { x: cam.x, y: cam.y, width: view.viewport.width / cam.z, height: view.viewport.height / cam.z };
        let count = 0;
        for (const band of BANDS) {
            for (const part of parts.partsFor(band, world, omitIds ?? undefined)) {
                if (++count > ZOOM_DIRECT_MAX_PARTS) { auditCount(audit, 'zoom:direct:off:count'); return false; }
                if (isLivePart(part.item)) continue;
                if (blendOf(part.item) !== 'over') { auditCount(audit, 'zoom:direct:off:blend'); return false; }
                // The path route clips its own items, and a rectangle clip is its scissor: a notebook page's clip is one, so the paper
                // draws live. Any other clip is admitted by the composer per item, which the live draw does not do.
                const route = routeOf(part.item).route;
                if (part.item.clips.length && !(route === routes.path && everyClipIsRectangle(part.item.clips))) { auditCount(audit, 'zoom:direct:off:clips'); return false; }
                if (route === routes.cpu) { auditCount(audit, `zoom:direct:off:cpu:${part.item.kind}`); return false; }
            }
        }
        return target > 0;
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
            if (last && last.route === route && last.why === why && !last.clips && !clips &&
                (route === routes.cpu || last.items.length < RUN_MAX_ITEMS)) last.items.push(item);
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
        run.route.abandon?.(run.items);
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
        return { band, scale, x, y, slices, cursor: 0, parked: false, lowered: false, key: positionKey(band, scale, x, y), live, drivenFrame: -1, deniedGpu: 0 };
    };

    /** Admits and acquires a position's slices in order. 'wait' resumes next frame; 'denied' waits for memory. */
    const advance = (position: Position, budget: FrameBudget, gpu: GfxDevice, prefetch = false): 'done' | 'wait' | 'denied' | 'refused' => {
        position.deniedGpu = 0;
        // A ring position takes its targets first, as prefetch: one that does not fit admits nothing, so its route resources reclaim
        // nothing either. A ring compose that displaced undrawn tiles was recomposed the next frame, forever (memoryGovernor ReserveOptions).
        if (prefetch) {
            for (let i = position.cursor; i < position.slices.length; i++) {
                const slice = position.slices[i];
                if (slice.entry) continue;
                const entry = store.acquire(slice.key, slice.blend, gpu, true);
                if (!entry) return 'refused';
                slice.entry = entry;
            }
        }
        for (; position.cursor < position.slices.length; position.cursor++) {
            const slice = position.slices[position.cursor];
            if (slice.next < slice.runs.length) {
                const outcome = timedStage(audit, 'admit', () => admitSlice(slice, budget));
                if (outcome === 'deferred') return 'wait';
                if (outcome !== 'ok') { position.deniedGpu = outcome.pool === 'gpu' ? outcome.bytes : 0; refuseAdmission(outcome.pool, outcome.bytes); return 'denied'; }
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
            for (const run of slice.runs) { run.prepared?.retire(); run.prepared = null; run.route.abandon?.(run.items); }
            for (const { route, run, clips } of slice.admitted) { route.retire(run); clips?.retire(); }
            slice.admitted.length = 0;
            // Admission starts over from the slice's first run: kept, a position advanced after its cancel admitted only its later runs,
            // reported done and was encoded without the earlier ones, a tile with strokes missing that then stood in as a picture.
            slice.next = 0;
        }
        position.cursor = 0;
    };

    /** Frees this composer's own tiles for a refused position at rest, so it is admitted now instead of waiting on capacity that
     * nothing else releases (gpu, round 5: the paper froze with 31.9 MB held, its waiter armed and never woken). The free list and
     * the unprotected off-view tiles go first. When that frees nothing, the other scales go too, the stand-ins they were with them;
     * the exact scale stays. A lowered position still building is cancelled first: its entries are at another scale. Returns
     * whether any bytes were freed. */
    // The frame in which an own-store free found nothing: every later refusal this frame would scan and find nothing too.
    let freeOwnEmptyFrame = -1;
    const freeOwn = (view: ViewState, target: number, asking: Position): boolean => {
        if (freeOwnEmptyFrame === frame) return false;
        editEvent(EDIT_FREE);
        if (store.evict(FREE_FOR_REFUSAL, -1, view) > 0) return true;
        // Then what the routes keep from earlier frames: no governor reclaim asks the cache that is asking, and a pane's grant full of
        // its own idle ink edges refused its visible tiles for good (measured, the 5,642-stroke board after a zoom to 1745% and back
        // to fit on WebGL2: 27.6 MB of ink edges, one tile composed in 25 s). Edges used this frame or the last are kept: taken, a
        // deferred admission re-uploaded them every frame (measured: 254 edge buffers created per frame, 10 s of CPU per 10 s).
        if ((options.reclaimRoutes?.(FREE_FOR_REFUSAL, frame) ?? 0) > 0) { auditCount(audit, 'compose:free-own:routes'); return true; }
        // Then the live draw's runs, kept across settling frames: they hold every visible stroke's edges, the tiles that replace them
        // could not get a target from the grant they filled, and the board waited on itself (measured, the ten-tabs case: 11.8 MB of
        // ink edges in a 17.4 MB grant, one visible tile refused its 1 MB target for good). Retired, the edges the asking position does
        // not share are idle; the frame admits its live parts again into what is left, a hole held as one (holding).
        if (liveRuns.length) {
            retireLive();
            if ((options.reclaimRoutes?.(FREE_FOR_REFUSAL, frame) ?? 0) > 0) { auditCount(audit, 'compose:free-own:live'); return true; }
        }
        // The other lowered positions in progress go; never the one asking (driven past its own cancel, it finished as a partial tile).
        for (const position of building.values()) if (position.lowered && position !== asking) { cancel(position); building.delete(position.key); }
        // The other scales' tiles the last frame laid stay: they are the picture of positions not yet composed, and dropped, the screen
        // lost them before their own tiles existed (measured, the 3 MB board pinched out: a frame with 1,195 strokes shown, then one with
        // none, at the same camera).
        for (const band of BANDS) store.dropScalesExcept(target, band, floorScale, drawsFrame >= 0 ? drawsFrame : Infinity);
        const freed = store.evict(FREE_FOR_REFUSAL, -1, view) > 0;
        if (freed) auditCount(audit, 'compose:free-own:scales');
        else freeOwnEmptyFrame = frame;
        return freed;
    };

    /** Hands the runs of `position`'s current slice but its pictures to the CPU route for good, letting go of what the slice admitted
     * (see drive's memory fallback). False when none is left to move. */
    const rasterOnCpu = (position: Position): boolean => {
        const slice = position.slices[position.cursor];
        // Pictures stay on their route: it draws them from the texture it holds, and gives up their bitmaps once uploaded, so the CPU
        // raster has nothing to paint them from (measured, the 10,000-stroke old board: 'Released prepared image', the pane demoted).
        const moves = (run: Run): boolean => run.route !== routes.cpu && run.route !== routes.image;
        if (!slice || !slice.runs.some(moves)) return false;
        for (const { route, run, clips } of slice.admitted) { route.retire(run); clips?.retire(); }
        slice.admitted.length = 0;
        slice.next = 0;
        for (const run of slice.runs) if (moves(run)) toCpu(run, 'memory', null);
        // One raster for the slice, not one per GPU run (RUN_MAX_ITEMS): each CPU run is its own tile-sized scrap and texture.
        const merged: Run[] = [];
        for (const run of slice.runs) {
            const last = merged[merged.length - 1];
            if (last && last.route === routes.cpu && run.route === routes.cpu && last.why === run.why && !last.clips && !run.clips) last.items.push(...run.items);
            else merged.push(run);
        }
        slice.runs.length = 0; slice.runs.push(...merged);
        return true;
    };
    /** Whether a building or finished position is still wanted at `target`: a position at the target scale while its cell is in the
     * `ring`, a lowered one (half the scale) while one of the four target cells it covers is visible (`span`) and has no exact tile
     * yet. A lowered position is a stand-in for refused visible cells: once they are composed it covers nothing, and kept for any
     * ring cell it lingered in progress with no pass to finish it (counted 'building:orphan' at every frame after divider drags). */
    const stillWanted = (position: Position, target: number, ring: Span, span: Span): boolean => {
        if (!position.lowered && floorSpan && position.scale === floorScale && floorScale !== target) return inSpan(floorSpan, position.x, position.y);
        if (!position.lowered) return position.scale === target && inSpan(ring, position.x, position.y);
        if (position.scale * 2 !== target) return false;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const x = position.x * 2 + dx, y = position.y * 2 + dy;
            if (inSpan(span, x, y) && statusAt(position.band, target, x, y) !== 'ok' && !exactFinishedAt(position.band, target, x, y)) return true;
        }
        return false;
    };
    /** Whether a position of the target scale itself (not a lowered one) at a cell was composed this frame. */
    const exactFinishedAt = (band: PaintBand, target: number, x: number, y: number): boolean => {
        for (const position of finished) if (!position.lowered && position.band === band && position.scale === target && position.x === x && position.y === y) return true;
        return false;
    };
    // The lowered positions in progress, collected before they are driven (a drive edits the building map).
    const loweredScratch: Position[] = [];

    /** The compose pass of one frame, in priority order: dirty visible positions, then missing visible ones, then the
     * missing positions one ring outside the view. The frame's limit is the number of tiles it may compose. */
    // `only` is the part of the frame this call composes: 'foreground' the held, dirty and visible-missing-without-stand-in work (what
    // completeness needs), 'background' the rest (visible positions a stand-in shows, leftovers, the ring), 'all' both (single-phase).
    // Whether this frame's compose stopped before its passes were done (limit, budget, a wait): positions after the stop were not reached.
    let composeCut = false;
    const composePasses = (view: ViewState, budget: FrameBudget, gpu: GfxDevice, target: number, span: Span, only: 'foreground' | 'background' | 'all'): void => {
        let limit = view.moving ? 2 : 8;
        if (options.slowGpu?.()) limit = Math.max(1, limit >> 1);
        // Advances one position. False when this frame's compose is spent (limit, budget, a wait); true when the pass goes on.
        const drive = (position: Position, key: number, pass: 'held' | 'dirty' | 'missing' | 'ring' | 'floor'): boolean => {
            // The ring and the floor are prefetch: admitted only into free room, never lowered, never freeing what the view holds.
            const prefetch = pass === 'ring' || pass === 'floor';
            // A parked position waits for the governor's wake; the pass goes on past it. While that wait is for GPU room, work that
            // would take new room (a missing, ring or floor position) is passed over too, so it cannot take the room waited for; a dirty
            // or held position recomposes into the target it already has, so an erase or an undo still shows (ended at a parked lowered
            // position, every compose stopped before the dirty pass until the wake, the erased strokes on screen meanwhile).
            if (position.parked) { if (waiting) position.drivenFrame = frame; return true; }
            if (waiting && blockedOnGpu && roomForPosition && pass !== 'dirty' && pass !== 'held') { position.drivenFrame = frame; auditCount(audit, `compose:room-wait:${pass}`); return true; }
            position.drivenFrame = frame;
            // Why a frame composes nothing is the zoom question: each exit is counted (pass and cause).
            // The count limit is for background recomposes: a foreground compose (a visible tile with no valid cover) is bounded by the budget.
            if (only !== 'foreground' && frameComposed >= limit) { auditCount(audit, `compose:limit:${pass}`); return false; }
            if (budget.shouldYield()) { auditCount(audit, `compose:yield:${pass}`); return false; }
            let outcome = advance(position, budget, gpu, prefetch);
            // At rest a refused or denied position frees this composer's own tiles and is admitted in the same frame, instead of
            // waiting for the governor (see freeOwn). While zooming the stand-ins stay: they are what the zoom shows.
            // Only a GPU refusal frees this composer's own tiles: a CPU denial (path staging) is not a GPU shortage, and evicting
            // tiles for it recomposes what was just freed. A ring position frees nothing: what it would free is the ring itself.
            if ((outcome === 'refused' || (outcome === 'denied' && blockedOnGpu)) && !prefetch && !zoomingFrame) {
                // Refused room for its own picture, the board first gives up laying changed regions live: their covers (every part under
                // a region, drawn live each frame) are admitted before any compose and hold the room the dirty tiles under them need, so
                // those tiles never composed, the regions never cleared, and a refused cover left its cut-out tile blank (measured, the
                // 5,642-stroke board zoomed to 1745% and back to fit on WebGL2: 64 regions, 27.6 MB of ink edges, one tile in 25 s, most
                // of the picture blank for minutes). The dirty tiles draw their last picture, flagged stale, until they compose.
                if (pendingRegions.length) { auditCount(audit, 'live:region:dropped-memory', pendingRegions.length); pendingRegions.length = 0; }
                // And the other positions in progress: each held the runs it had admitted while this one waited, and none could finish
                // (measured, the same board: one position parked, another holding 15 MB of ink edges it would never be driven past). They
                // start over once this one is composed; what they held is idle, and freeOwn takes it.
                if (building.size > 1) {
                    staleScratch.length = 0;
                    for (const other of building.values()) if (other !== position) staleScratch.push(other);
                    for (const other of staleScratch) { cancel(other); building.delete(other.key); }
                    auditCount(audit, 'compose:cancel-others', staleScratch.length);
                    staleScratch.length = 0;
                }
                // Freed and still refused, it frees again until nothing of its own is left this frame: freed once per frame, the little a
                // free found each time was taken back by the retry, the CPU raster below never came, and the refused tile was retried at
                // every deadline for good (measured, three dense boards after divider drags: 40 free-and-retry rounds per 10 s at rest).
                for (let rounds = 0; (outcome === 'refused' || (outcome === 'denied' && blockedOnGpu)) && rounds < FREE_RETRY_ROUNDS && freeOwn(view, target, position); rounds++) {
                    auditCount(audit, `compose:free-retry:${pass}`);
                    outcome = advance(position, budget, gpu);
                }
                // Nothing of its own is left to free and its admission is still refused: the slice's content needs more than the pane
                // can hold at once (exact-area ink holds every stroke's edges until the tile encodes). The CPU route rasters it instead,
                // counted as a fallback, which needs the tile's target alone (measured, the 5,642-stroke board at fit after a zoom to
                // 1745% on WebGL2: one tile's ink edges 25-29 MB of a ~35 MB grant, refused at the last few KB, blank for minutes).
                if (outcome === 'denied' && blockedOnGpu && freeOwnEmptyFrame === frame && rasterOnCpu(position)) {
                    auditCount(audit, `compose:cpu-for-memory:${pass}`);
                    outcome = advance(position, budget, gpu);
                }
            }
            if (outcome === 'done') {
                editEvent(EDIT_DONE);
                retryDelay = GPU_RETRY_MS; retryMisses = 0;
                for (const slice of position.slices) if (slice.entry) entryGen.set(slice.entry, ++genCounter);
                auditCount(audit, `compose:done:${pass}`);
                building.delete(key);
                finished.push(position);
                if (only !== 'foreground') frameComposed += position.slices.length;
                return true;
            }
            if (outcome === 'refused' && !prefetch && !position.lowered) {
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
            // A refusal ends the frame's compose: the next position would admit and hold content of its own while this one waits, and
            // positions that each held part of the room waited on one another for good (measured: five visible positions of a narrow
            // dense pane parked holding 12.7 MB of ink edges, each refused the 1 MB tile it needed; the 5,642-stroke board after a zoom
            // to fit, three holding 27.6 MB). The one refused is reached first again when the governor wakes the composer.
            if (outcome === 'refused') { refuseTarget(); position.parked = true; if (!prefetch) armRetry(); auditCount(audit, `compose:refused:${pass}`); return false; }
            if (outcome === 'denied') { position.parked = true; if (!prefetch) armRetry(); auditCount(audit, `compose:denied:${pass}`); return false; }
            auditCount(audit, `compose:wait:${pass}`);
            return false;
        };
        // The positions under a held node come first: it stays live until they are composed, so they shorten every hold, and
        // a held node's content is composed before any other tile in the frame's budget (gpu).
        for (const id of only === 'background' ? NO_IDS : heldNodes.keys()) {
            for (const rect of parts.boundsOfNodes(new Set([id]))) {
                const x0 = Math.max(span.x0, Math.floor(rect.x * target / EDGE)), x1 = Math.min(span.x1, Math.ceil((rect.x + rect.width) * target / EDGE));
                const y0 = Math.max(span.y0, Math.floor(rect.y * target / EDGE)), y1 = Math.min(span.y1, Math.ceil((rect.y + rect.height) * target / EDGE));
                for (const band of BANDS) {
                    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                        const key = positionKey(band, target, x, y);
                        let position = building.get(key);
                        if (!position) {
                            const status = statusAt(band, target, x, y);
                            if (status !== 'dirty' && status !== 'missing' || finishedAt(band, target, x, y)) continue;
                            const started = begin(band, target, x, y, view);
                            if (!started) continue;
                            position = started;
                            building.set(key, position);
                        }
                        if (!drive(position, key, 'held')) { composeCut = true; return; }
                    }
                }
            }
        }
        // A lowered position sits at half the target scale, where no pass below looks: only a second refusal of the cell above it
        // reached it again, so one the governor had admitted part of stayed in progress for good, and needsFrame asked for a frame at
        // every vsync ('building'). It is driven here, as the visible work it stands in for.
        if (building.size) {
            for (const position of building.values()) if (position.lowered) loweredScratch.push(position);
            for (const position of loweredScratch) {
                if (building.get(position.key) !== position) continue;
                if (!drive(position, position.key, 'missing')) { loweredScratch.length = 0; composeCut = true; return; }
            }
            loweredScratch.length = 0;
        }
        // A visible position with no stand-in is foreground work: the foreground (and a single-phase compose) takes the missing pass
        // before the dirty one, so a budget that runs out on dirty positions cannot leave it missing (gpu's ruling).
        // At rest, after the ring's first tile each side, the floor (see FLOOR_VIEWS): the coarse picture every later zoom or pan stands
        // on. A few tiles picture seven viewports across, where the whole ring pictures one viewport each side at full scale: after the
        // whole ring, a ring that filled the room left no floor (measured, the 450-stroke board at 355%: 72 ring positions, the floor
        // refused, a zoom out then showed up to 75 strokes missing for 0.6 s); before all of it, a dense board's slow floor kept even the
        // ring's first tiles from a pan that followed.
        const composeFloor = (): boolean => {
            if (!floorSpan) return true;
            for (const band of BANDS) {
                for (let y = floorSpan.y0; y < floorSpan.y1; y++) {
                    for (let x = floorSpan.x0; x < floorSpan.x1; x++) {
                        const key = positionKey(band, floorScale, x, y);
                        let position = building.get(key);
                        if (!position) {
                            // A floor tile an edit overtook is composed again too: as a stand-in it would show the board before the edit.
                            if (statusAt(band, floorScale, x, y) === 'ok' || finishedAt(band, floorScale, x, y) || (waiting && blockedOnGpu && roomForPosition)) continue;
                            const started = begin(band, floorScale, x, y, view);
                            if (!started) continue;
                            position = started;
                            building.set(key, position);
                        }
                        if (!drive(position, key, 'floor')) return false;
                    }
                }
            }
            return true;
        };
        // One sweep of a pass over the span grown by `margin` (the visible positions, or the ring's outside them). False once cut.
        const sweep = (pass: 'dirty' | 'missing' | 'ring', margin: number): boolean => {
            for (const band of BANDS) {
                for (let y = span.y0 - margin; y < span.y1 + margin; y++) {
                    for (let x = span.x0 - margin; x < span.x1 + margin; x++) {
                        const visible = inSpan(span, x, y);
                        if (pass === 'ring' ? visible : !visible) continue;
                        const key = positionKey(band, target, x, y);
                        let position = building.get(key);
                        if (!position && pass === 'dirty' && statusAt(band, target, x, y) === 'dirty' && !frameDirtyCovered.has(key)
                            && !uncoveredPositions.has(key) && pendingRegionsIn(band, target, x, y).length) {
                            // Its changed pixels are laid live (the region cover), so its compose can wait: at most DIRTY_COVERED_PER_FRAME
                            // of these per frame. One the last draw could not cover shows stale, so it is not bounded: deferred on its
                            // region alone, a bookmark card's outline stayed missing at rest (gpu-f1, gpu-f2's media kit, WebGL2 DPR 2: 300
                            // deferrals). A region new this frame has not been tried yet and still defers: its commit frame composes one.
                            if (frameDirtyCovered.size >= DIRTY_COVERED_PER_FRAME) { auditCount(audit, 'compose:dirty-covered-deferred'); continue; }
                            frameDirtyCovered.add(key);
                        }
                        if (!position) {
                            const status = statusAt(band, target, x, y);
                            if (pass === 'dirty' ? status !== 'dirty' : status !== 'missing') continue;
                            // New room is not taken while a GPU wait stands (see drive): the position is not even begun.
                            if (pass !== 'dirty' && waiting && blockedOnGpu && roomForPosition) continue;
                            // Composed earlier this frame (the held pass takes the positions under a held node first) and still dirty until
                            // its encode: begun again it composed twice per frame (rotate, WebGL2 DPR 2 dark: every position under the
                            // rotated rectangle composed twice in the change frame and the next).
                            if (finishedAt(band, target, x, y)) { auditCount(audit, 'compose:finished-this-frame'); continue; }
                            // A visible position a stand-in already shows is not the foreground's: it waits for the background call.
                            if (only === 'foreground' && pass === 'missing' && standInsOf(band, target, x, y).length) continue;
                            // While zooming, content a stand-in can show is not composed again at this scale: its raster is scaled.
                            if (zoomingFrame && pass !== 'dirty' && heldByZoom(band, target, x, y)) { auditCount(audit, 'compose:zoom:held'); continue; }
                            const started = begin(band, target, x, y, view);
                            if (!started) continue;
                            position = started;
                            building.set(key, position);
                        }
                        if (!drive(position, key, pass)) return false;
                    }
                }
            }
            return true;
        };
        for (const pass of (only === 'background' ? DIRTY_FIRST : MISSING_FIRST)) {
            // While zooming only the visible positions are composed: the ring is the next view's, and the zoom's compose is its cost.
            if (pass === 'ring' && (zoomingFrame || only === 'foreground')) continue;
            if (pass !== 'ring') { if (!sweep(pass, 0)) { composeCut = true; return; } continue; }
            // At rest the ring is a viewport each side (bounded): a pan reveals composed tiles, not stand-ins (gpu's ruling). Its first tile
            // each side comes first, then the floor, then the rest of it.
            const margin = ringMargin(span, zoomingFrame);
            if (!sweep(pass, Math.min(1, margin)) || !composeFloor() || !sweep(pass, margin)) { composeCut = true; return; }
        }
    };
    const compose = (view: ViewState, budget: FrameBudget, gpu: GfxDevice, target: number, span: Span, only: 'foreground' | 'background' | 'all'): void => {
        composeCut = false;
        composePasses(view, budget, gpu, target, span, only);
        // A position in progress that a whole compose at rest neither advanced nor left parked on a governor wait has nothing driving
        // it, yet keeps needsFrame asking ('building') at every vsync. Counted, so such an orphan is named the moment it exists (the
        // foreground call and a zoom drive only part of the set, and a compose cut short never reached the rest).
        if (renderAuditEnabled() && !composeCut && only !== 'foreground' && !zoomingFrame) {
            let orphans = 0;
            for (const position of building.values()) if (position.drivenFrame !== frame) orphans++;
            if (orphans) auditCount(audit, 'building:orphan', orphans);
        }
    };

    // The run an encode draws, set by the encode loop: one object for the composer's life, so no closure is built per run.
    const encodeDraw: { pass: GpuPass | null; route: ItemRoute | null; run: PreparedRun | null } = { pass: null, route: null, run: null };
    /** A route whose draw the kit refused this frame, in encode or composite: the layer is incomplete (markIncomplete; the compositor
     * decides after the surface pass: critical refuses the frame, the rest present with layersComplete false) and the next frame is asked. */
    const reportRouteRefusals = (): void => {
        for (const route of routeList) if ((route as RouteWithRefusal).drawRefusedThisFrame?.()) {
            auditCount(audit, `route:${route.id}:refused-frame`); wantFrame = true; drawRefusedNow = true; host.markIncomplete(`route:${route.id}:refused`);
        }
    };
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
            draw = { band, texture: target.texture, mode: slot.mode, gen: 0, x: 0, y: 0, w: 0, h: 0, clipOn: false, cx: 0, cy: 0, cw: 0, ch: 0, ink: NO_IDS, live: null, liveRoute: null, liveItem: null, node: '', cover: false };
            draws.push(draw);
        }
        drawCount++;
        draw.band = band; draw.texture = target.texture; draw.mode = slot.mode; draw.gen = entryGen.get(entry) ?? 0;
        draw.x = world.x; draw.y = world.y; draw.w = world.width; draw.h = world.height;
        draw.clipOn = clip !== null;
        draw.ink = slot.inkNodes;
        draw.live = null; draw.liveRoute = null; draw.liveItem = null; draw.cover = false;
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
        liveAdmitted.clear(); liveDeferredBy.clear();
    };

    /** A live part's run for this frame, admitted once however many positions show it. Video parts take the image route; any other
     * part is admitted by the route that draws its kind (a held node's parts). A part no route draws this frame is counted
     * (live:dropped:<why>), never skipped silently. */
    const admitLive = (item: PaintItem, blend: Blend, view: ViewState, budget: FrameBudget): LiveAdmission | null => {
        const known = liveAdmitted.get(item);
        if (known !== undefined && (known !== null || budget.phase !== 'background' || liveDeferredBy.get(item) !== 'foreground')) return known;
        let admitted: LiveAdmission | null = null;
        const route = isLivePart(item) ? routes.image : routeOf(item).route;
        // The CPU route rasters a tile-sized scratch at the camera origin: it cannot draw a live part over the surface.
        if (!route || route === routes.cpu) { auditCount(audit, route ? 'live:dropped:cpu-route' : 'live:dropped:route-absent'); }
        else {
            let outcome = route.admit([item], view, blend, budget);
            // Admission is resumable: a deferral while the frame still has time is resumed now, not left for the next frame.
            for (let attempt = 1; outcome.status === 'deferred' && attempt < LIVE_ADMIT_ATTEMPTS && !budget.shouldYield(); attempt++) {
                auditCount(audit, 'live:resumed');
                outcome = route.admit([item], view, blend, budget);
            }
            if (outcome.status === 'ready') {
                admitted = { route, run: outcome.value }; liveRuns.push(admitted);
                if (!exactRun(route, outcome.value)) liveInexact = true;
                if (route === routes.image && routes.image.waits?.(outcome.value)) liveStale = true;
            }
            else if (outcome.status === 'unsupported') { auditCount(audit, `live:dropped:${outcome.why}`); }
            else if (outcome.status === 'deferred') {
                // A deferral is a frame wait: nothing else invalidates the board for it, so the next frame asks again (bounded, below).
                // Split by route: the admission reports no reason, so the route is the cause the counters can name.
                liveDeferredNow = true; liveDeferredBy.set(item, budget.phase); auditCount(audit, 'live:dropped:deferred'); auditCount(audit, `live:dropped:deferred:${route.id}`); auditCount(audit, `live:dropped:deferred:${budget.phase}`);
            } else if (outcome.status === 'denied') {
                // A denial waits on the governor like a tile's: the wake is the capacity change, not a timer, so a steady pool costs nothing.
                refuseAdmission(outcome.pool, outcome.bytes, true); auditCount(audit, 'live:dropped:denied');
            }
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

    /** True while a dirty tile under a pending region is in view at `target`: the region's live parts are still owed. */
    const regionStillDirty = (region: Readonly<Rect>, target: number, span: Span): boolean => {
        const x0 = Math.max(span.x0, Math.floor(region.x * target / EDGE)), x1 = Math.min(span.x1, Math.ceil((region.x + region.width) * target / EDGE));
        const y0 = Math.max(span.y0, Math.floor(region.y * target / EDGE)), y1 = Math.min(span.y1, Math.ceil((region.y + region.height) * target / EDGE));
        for (const band of BANDS) {
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (statusAt(band, target, x, y) === 'dirty') return true;
        }
        return false;
    };

    const NO_REGIONS: readonly Rect[] = Object.freeze([]);
    const NO_PIECES: readonly Rect[] = Object.freeze([]);
    /** The pending regions that reach one position's interior. */
    const pendingRegionsIn = (band: PaintBand, target: number, x: number, y: number): readonly Rect[] => {
        const interior = tileWorld(keyOf(band, target, x, y, 0));
        const found = pendingRegions.filter(region => overlapsRect(region, interior));
        return found.length ? found : NO_REGIONS;
    };
    /** The surface pixels of the regions under one position, as disjoint rectangles inside its clip: each pixel is cut out once. */
    const cutPieces = (view: ViewState, regions: readonly Rect[], clip: Rect): Rect[] => {
        const disjoint: Rect[] = [];
        for (const region of regions) disjoint.push(...subtractRects(surfacePixels(view, region), disjoint));
        const cut: Rect[] = [];
        for (const piece of disjoint) {
            const x0 = Math.max(piece.x, clip.x), y0 = Math.max(piece.y, clip.y);
            const x1 = Math.min(piece.x + piece.width, clip.x + clip.width), y1 = Math.min(piece.y + piece.height, clip.y + clip.height);
            if (x1 > x0 && y1 > y0) cut.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        }
        return cut;
    };
    /** Draws a dirty entry around its cut: one clipped draw per piece of its clip the cut leaves, so no pixel is drawn twice. */
    const addPieces = (band: PaintBand, entry: TileEntry, slot: Pick<Slot, 'mode' | 'inkNodes'>, clip: Rect | null,
        cut: readonly Rect[]): void => {
        if (!clip) return;
        for (const piece of subtractRects(clip, cut)) addDraw(band, entry, slot, piece);
        auditCount(audit, 'live:region:tile-cut');
    };
    /** Appends to `liveScratch` the live parts reaching a cut, each drawn only inside the cut pieces it reaches: all or none for the
     * position, so a part the frame cannot admit (deferred, denied, unsupported) leaves the cut stale and the position uncovered. */
    const appendRegionLive = (band: PaintBand, target: number, x: number, y: number, view: ViewState, budget: FrameBudget,
        regions: readonly Rect[], cut: readonly Rect[]): boolean => {
        const mark = liveScratch.length;
        const interior = tileWorld(keyOf(band, target, x, y, 0));
        const pad = GUTTER / target;
        const gutter: Rect = { x: interior.x - pad, y: interior.y - pad, width: interior.width + 2 * pad, height: interior.height + 2 * pad };
        const reaching: { part: TilePart; pieces: Rect[] }[] = [];
        for (const part of parts.partsFor(band, gutter, omitIds ?? undefined)) {
            if (isLivePart(part.item)) continue;
            const reach = surfacePixels(view, part.world);
            const pieces = cut.filter(piece => overlapsRect(piece, reach));
            if (!pieces.length) continue;
            // A cover is laid whole within a frame or not at all, so one larger than a frame can lay live (the zoom's bound) is never
            // laid: its regions are let go, and the dirty tile draws its last picture, flagged stale, until it composes. Kept, they were
            // laid again every frame, spent the frame and left nothing for the compose that clears them (measured, the 10,000-stroke
            // board zoomed in and back to fit on WebGL2: the paged-in scene's 64 regions over thousands of strokes, 9.7 ms of prepare
            // per call, the compose yielding at once in 5,483 frames, 'Updating…' for good).
            if (reaching.push({ part, pieces }) > ZOOM_DIRECT_MAX_PARTS) {
                for (const region of regions) { const at = pendingRegions.indexOf(region as Rect); if (at >= 0) pendingRegions.splice(at, 1); }
                auditCount(audit, 'live:region:dropped-dense');
                return false;
            }
        }
        for (const { part, pieces } of reaching) {
            const admitted = admitLive(part.item, part.blend, view, budget);
            if (!admitted) {
                liveScratch.length = mark;
                auditCount(audit, 'live:region:uncovered'); auditCount(audit, `live:region:uncovered:${budget.phase}`);
                return false;
            }
            liveScratch.push({ order: part.order, run: admitted.run, route: admitted.route, nodeId: part.nodeId, item: part.item, pieces });
        }
        auditCount(audit, 'live:region:covered');
        return true;
    };

    /** Admits, before this frame's tile composes, the live parts of the visible changed and held nodes: their uploads then take the
     * frame's allowance first. Admissions are cached per item, so buildDraws reads them back and counts nothing twice. */
    const admitVisibleFirst = (view: ViewState, target: number, span: Span, budget: FrameBudget): void => {
        if (pendingRegions.length) {
            for (const band of BANDS) {
                for (let y = span.y0; y < span.y1; y++) {
                    for (let x = span.x0; x < span.x1; x++) {
                        if (statusAt(band, target, x, y) !== 'dirty') continue;
                        const regions = pendingRegionsIn(band, target, x, y);
                        const position = regions.length ? clipOnSurface(view, target, x, y) : null;
                        if (!position) continue;
                        const cut = cutPieces(view, regions, position);
                        if (cut.length) appendRegionLive(band, target, x, y, view, budget, regions, cut);
                    }
                }
            }
            liveScratch.length = 0;
        }
        if (heldNodes.size) {
            const cam = view.camera;
            const viewWorld: Rect = { x: cam.x, y: cam.y, width: view.viewport.width / cam.z, height: view.viewport.height / cam.z };
            for (const id of heldNodes.keys()) {
                for (const rect of parts.boundsOfNodes(new Set([id]))) {
                    for (const band of BANDS) {
                        for (const part of parts.partsFor(band, rect, omitIds ?? undefined)) {
                            if (part.nodeId !== id || isLivePart(part.item) || !overlapsRect(part.world, viewWorld)) continue;
                            admitLive(part.item, part.blend, view, budget);
                        }
                    }
                }
            }
        }
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
            if (admitted) liveScratch.push({ order: part.order, run: admitted.run, route: admitted.route, nodeId: part.nodeId, item: part.item });
        }
    };

    /** A live draw: its run under `clip`, in the draw order of the position it shows. */
    const addLiveDraw = (band: PaintBand, run: PreparedRun, route: ItemRoute, clip: Rect, nodeId: string, item: object): void => {
        let draw = draws[drawCount];
        if (!draw) {
            draw = { band, texture: null, mode: 'over', gen: 0, x: 0, y: 0, w: 0, h: 0, clipOn: true, cx: 0, cy: 0, cw: 0, ch: 0, ink: NO_IDS, live: null, liveRoute: null, liveItem: null, node: '', cover: false };
            draws.push(draw);
        }
        drawCount++;
        draw.band = band; draw.texture = null; draw.mode = 'over'; draw.gen = 0; draw.clipOn = true;
        draw.cx = clip.x; draw.cy = clip.y; draw.cw = clip.width; draw.ch = clip.height;
        draw.ink = NO_IDS; draw.live = run; draw.liveRoute = route; draw.liveItem = item; draw.node = nodeId; draw.cover = false;
        plannedLive[band].add(nodeId);
        auditCount(audit, 'tile:live-part');
    };

    /** Draws the scratch live parts that paint before `order`, from index `from`, clipped to `clip`. Returns the next index. */
    const liveBefore = (band: PaintBand, order: number, from: number, clip: Rect | null): number => {
        let li = from;
        for (; li < liveScratch.length && liveScratch[li].order < order; li++) {
            const live = liveScratch[li];
            if (live.pieces) { for (const piece of live.pieces) addLiveDraw(band, live.run, live.route, piece, live.nodeId, live.item); }
            else if (clip) addLiveDraw(band, live.run, live.route, clip, live.nodeId, live.item);
        }
        return li;
    };

    /** Draws a position no tile pictures from its parts, live and clipped to it: all of them, or none (the frame's bound on live fill
     * parts, or a part not admitted). True when the position shows all its content (or has none). */
    // `partial`: with no picture of the position at all, the parts that were admitted are drawn even when some were not: a frame of the
    // board opening (no tile composed yet) that fell back from a live draw over a deferred part otherwise drew nothing at all there.
    const fillLive = (band: PaintBand, target: number, x: number, y: number, view: ViewState, budget: FrameBudget, clip: Rect, partial = false): boolean => {
        const interior = tileWorld(keyOf(band, target, x, y, 0));
        const pad = GUTTER / target;
        const gutter: Rect = { x: interior.x - pad, y: interior.y - pad, width: interior.width + 2 * pad, height: interior.height + 2 * pad };
        const found = parts.partsFor(band, gutter, omitIds ?? undefined);
        if (!found.length) return true;
        if (fillParts + found.length > LIVE_FILL_MAX_PARTS) { auditCount(audit, 'fill:live:over-bound'); return false; }
        liveScratch.length = 0;
        let whole = true;
        for (const part of found) {
            const admitted = admitLive(part.item, part.blend, view, budget);
            if (!admitted) {
                whole = false;
                if (partial) continue;
                liveScratch.length = 0; auditCount(audit, 'fill:live:not-admitted'); return false;
            }
            liveScratch.push({ order: part.order, run: admitted.run, route: admitted.route, nodeId: part.nodeId, item: part.item });
        }
        fillParts += found.length;
        liveBefore(band, Infinity, 0, clip);
        liveScratch.length = 0;
        auditCount(audit, whole ? 'fill:live' : 'fill:live:partial');
        return whole;
    };
    /** A visible position whose world the last drawn frame showed, drawn now with no picture of its content (or only part of one): a
     * regression, the frame would take items off the screen, so it is held (holding). */
    const noteHole = (band: PaintBand, target: number, x: number, y: number, cause: string): void => {
        frameHoles++; frameRegressions++; holeCause = cause;
        auditDrawn('hole', 1, 'geometry', `${audit}-tile-${band}-${cause}`);
        auditCount(audit, `hole:${cause}`);
    };

    /** The admissions of a live-drawn frame, made in the foreground call (buildLiveDraws reads them back from the per-item cache). */
    const admitLiveFirst = (view: ViewState, budget: FrameBudget): void => {
        setViewRects(view);
        for (const band of BANDS) collectLiveIn(band, viewWorld, view, budget);
        liveScratch.length = 0;
    };
    const setViewRects = (view: ViewState): void => {
        const cam = view.camera, scale = cam.z * view.viewport.dpr;
        viewWorld.x = cam.x - 1 / scale; viewWorld.y = cam.y - 1 / scale;
        viewWorld.width = view.viewport.width / cam.z + 2 / scale; viewWorld.height = view.viewport.height / cam.z + 2 / scale;
        viewClip.width = Math.round(view.viewport.width * view.viewport.dpr); viewClip.height = Math.round(view.viewport.height * view.viewport.dpr);
    };
    /** The view's world rectangle, grown by a device pixel each side: what a live frame's parts are queried over. One object, reused. */
    const viewWorld: Rect = { x: 0, y: 0, width: 0, height: 0 };
    const viewClip: Rect = { x: 0, y: 0, width: 0, height: 0 };
    /** Every part reaching `world`, in paint order, admitted for this frame into `liveScratch`. */
    const collectLiveIn = (band: PaintBand, world: Readonly<Rect>, view: ViewState, budget: FrameBudget): void => {
        liveScratch.length = 0;
        for (const part of parts.partsFor(band, world, omitIds ?? undefined)) {
            // Per-frame geometry size of the live draw: path commands (the triangles are the route's; no per-frame count exists there).
            if (part.item.kind === 'path') auditCount(audit, 'live:path-commands', part.item.d.length);
            auditCount(audit, 'live:items');
            const admitted = admitLive(part.item, part.blend, view, budget);
            if (admitted) liveScratch.push({ order: part.order, run: admitted.run, route: admitted.route, nodeId: part.nodeId, item: part.item });
            else liveMissed = true;
            if (part.item.kind === 'ink') {
                if (!admitted) { liveInkDropped.add(part.nodeId); drawnInk.delete(part.nodeId); }
                else if (!liveInkDropped.has(part.nodeId)) drawnInk.add(part.nodeId);
            }
        }
    };
    /** A live frame's draw list: every part reaching the view, once, in paint order, clipped to the surface. Every visible position
     * of a live frame is drawn live, and live parts are drawn in device space, so the per-position clips only partitioned one picture:
     * drawn per position, each coverage-kit part paid a pass and a resolve per position it crossed (measured, notebook saturated zoom:
     * 6.3 ink parts x 13.1 positions = 51 resolves and ~200 render-target switches per frame). */
    const buildLiveDraws = (view: ViewState, budget: FrameBudget): void => {
        setViewRects(view);
        if (viewClip.width <= 0 || viewClip.height <= 0) return;
        for (const band of BANDS) {
            collectLiveIn(band, viewWorld, view, budget);
            liveBefore(band, Infinity, 0, viewClip);
            auditCount(audit, 'tile:live-view');
        }
    };

    const buildDraws = (view: ViewState, target: number, zooming: boolean, budget: FrameBudget): void => {
        drawCount = 0;
        drawsEpoch = evictEpoch; drawsFrame = frame;
        drawsCam.x = view.camera.x; drawsCam.y = view.camera.y; drawsCam.z = view.camera.z;
        drawsCam.w = view.viewport.width; drawsCam.h = view.viewport.height; drawsCam.dpr = view.viewport.dpr;
        const swap = lastCovered; lastCovered = spareCovered; spareCovered = swap;
        const swapped = swappedTiles; swappedTiles = spareSwapped; spareSwapped = swapped; swappedTiles.clear();
        lastCovered.clear(); for (const key of coveredPositions) lastCovered.add(key);
        coveredPositions.clear(); uncoveredPositions.clear();
        coverSignature = 0;
        frameHoles = 0; frameRegressions = 0; holeCause = ''; fillParts = 0; liveMissed = false; curHoles.length = 0;
        if (liveNow) {
            buildLiveDraws(view, budget);
            if (!liveMissed) return;
            // A part of the view was not admitted (its upload deferred to a later frame, or denied): drawn live, the frame would show the
            // view without it, a blink of the item (measured, a 16-stroke board pinched at 120 Hz: 15 of 16 strokes gone for 2-3 frames;
            // 450 strokes: ~330 gone for 1-7 frames). It draws from tiles instead, as a zoom of a dense board does: each position's exact
            // tile, or the other scales' picture of it, or its parts live where it has neither.
            auditCount(audit, 'live:fallback:tiles');
            drawCount = 0; plannedLive.underlay.clear(); plannedLive.content.clear();
            zooming = true;
        }
        const span = spanAt(view, target);
        const clipAt = (x: number, y: number): Rect | null => clipOnSurface(view, target, x, y);
        for (const band of BANDS) {
            // `complete`: every visible position draws its exact tile this frame, a position composed this frame (finished, encoded
            // before the draw) included. Counting those as missing drew stand-ins over positions that had their exact tiles, and the
            // next frame swapped them in with the same pixels (measured: one redundant present every second zoom step on LARGE=11).
            // The other scales are dropped only once no position depends on this frame's encode.
            let complete = true, held = true;
            for (let y = span.y0; y < span.y1 && complete; y++) {
                for (let x = span.x0; x < span.x1 && complete; x++) {
                    if (statusAt(band, target, x, y) !== 'missing') continue;
                    held = false;
                    if (!finishedAt(band, target, x, y)) complete = false;
                }
            }
            if (!zooming && complete && held && store.dropScalesExcept(target, band, floorScale) > 0) editEvent(EDIT_SCALES);
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
                    const at = clipAt(x, y);
                    // A position with its own tile draws it, except at rest while the band still swaps: then the other scales' picture
                    // is drawn until every position of the band has its tile (one swap), when that picture is whole.
                    let pictured = false, exact = status !== 'missing' && (zooming || complete);
                    if (status !== 'missing' && !exact) exact = !at || !(pictured = standInPicture(view, band, target, x, y, at));
                    if (exact) {
                        const first = entryAt(band, target, x, y, 0);
                        const slot0 = first ? slots.get(first) : undefined;
                        const count = slot0?.count ?? 0;
                        const withLive = (slot0?.live ?? 0) > 0;
                        collectLive(band, target, x, y, view, budget, withLive, null);
                        // A dirty position under a pending change: its live parts replace the stale pixels there, cut out of its
                        // tiles, or the position draws as it did (stale, flagged by coverage). All or nothing per position.
                        const regions = status === 'dirty' ? pendingRegionsIn(band, target, x, y) : NO_REGIONS;
                        // A dirty position no pending region reaches is stale with no cover: named apart from an uncovered region.
                        if (status === 'dirty' && !regions.length) auditCount(audit, 'live:region:none');
                        const position = regions.length ? clipAt(x, y) : null;
                        const cut = position ? cutPieces(view, regions, position) : NO_PIECES;
                        const covered = cut.length > 0 && appendRegionLive(band, target, x, y, view, budget, regions, cut);
                        if (covered) {
                            liveScratch.sort((a, b) => a.order - b.order);
                            coveredPositions.add(positionKey(band, target, x, y));
                        } else if (regions.length) uncoveredPositions.add(positionKey(band, target, x, y));
                        const clip = withLive || covered ? clipAt(x, y) : null;
                        const coverKey = positionKey(band, target, x, y);
                        const coverFrom = drawCount;
                        let li = 0;
                        for (let s = 0; s < count; s++) {
                            const entry = entryAt(band, target, x, y, s);
                            const slot = entry && slots.get(entry);
                            if (entry && slot) {
                                li = liveBefore(band, slot.firstOrder[s], li, clip);
                                // Every slice is cut, not only the dirty ones: the live parts reaching the cut cover all of its slices' parts there.
                                if (covered) addPieces(band, entry, slot, clip, cut);
                                else addDraw(band, entry, slot, null);
                            }
                        }
                        liveBefore(band, Infinity, li, clip);
                        let tiles = 0;
                        if (!covered && status === 'ok') for (let d = coverFrom; d < drawCount; d++) tiles = hashMix(hashMix(tiles, idOfObject(draws[d].texture)), draws[d].gen);
                        const held = spareSwapped.get(coverKey);
                        const swappedNow = !covered && status === 'ok' && lastCovered.has(coverKey);
                        const signAsCover = covered || swappedNow || (status === 'ok' && held === tiles);
                        if (!covered && status === 'ok' && (swappedNow || held === tiles)) swappedTiles.set(coverKey, tiles);
                        if (signAsCover) {
                            auditCount(audit, covered ? 'cover:signed' : swappedNow ? 'cover:swapped' : 'cover:held');
                            for (let d = coverFrom; d < drawCount; d++) draws[d].cover = true;
                            const at = clipAt(x, y);
                            coverSignature = hashMix(coverSignature, coverKey);
                            if (at) { coverSignature = hashMix(coverSignature, Math.round(at.x) * 4 + Math.round(at.y) * 8 + Math.round(at.width) * 16 + Math.round(at.height) * 32); }
                        }
                        auditCount(audit, 'tile:hit');
                        if (zooming) auditCount(audit, 'zoom:draw:exact');
                        continue;
                    }
                    // The stand-in's clip is the part of its position on the surface: a scissor outside the surface, or with a
                    // negative origin, is refused by the device (measured: 'invalid-input' on open).
                    const clip = at;
                    if (!clip) continue;
                    if (!pictured) pictured = standInPicture(view, band, target, x, y, clip);
                    if (!pictured) {
                        // No tile of any scale pictures all of it. While the view moves, or where the last frame showed this world, its parts
                        // are drawn live (when few enough and admitted); otherwise it is a hole: held where the screen showed it (holding),
                        // presented as still loading elsewhere.
                        // Judged on the bare pieces alone: a position a zoom out grew past the last view keeps the part it showed, and its
                        // new part showed nothing before (taken whole, every edge position of a zoom out read as taking ink off the screen).
                        const bare = pictureRemaining;
                        const wasShown = shownValid && bare.some(piece => overlapsRect(piece, shownWorld) && !lastHoles.some(hole => covers(hole, piece)));
                        if ((wasShown || zooming || panned || liveNow) && fillLive(band, target, x, y, view, budget, clip)) continue;
                        // Nothing of any scale pictures it: what was admitted of its parts is drawn (a part picture is not worse than none).
                        if (!standScratch.length && (wasShown || zooming || panned || liveNow)) fillLive(band, target, x, y, view, budget, clip, true);
                        if (wasShown) noteHole(band, target, x, y, standScratch.length ? 'partial' : 'none');
                        else { frameHoles++; auditDrawn('hole', 1, 'geometry', `${audit}-tile-${band}-unshown`); auditCount(audit, zooming || panned || liveNow ? 'hole:revealed' : 'hole:loading'); }
                        for (const piece of bare) curHoles.push(piece);
                    }
                    // The stand-ins are drawn in paint order, so the position's live parts interleave as they do in an exact tile (the list
                    // is in scale and position order, which is not paint order).
                    standScratch.sort((a, b) => a.order - b.order);
                    collectLive(band, target, x, y, view, budget, paintHasLive, standScratch);
                    let li = 0;
                    for (const item of standScratch) {
                        li = liveBefore(band, item.order, li, clip);
                        addDraw(band, item.entry, item.slot, item.clip);
                    }
                    liveBefore(band, Infinity, li, clip);
                    // Its origin is geometry when any stand-in holds geometry, which a zoom must draw exact (the audit counts it apart).
                    if (standScratch.length) {
                        const geometry = standScratch.some(item => item.slot.geometry);
                        auditDrawn('stand-in', 1, geometry ? 'geometry' : 'raster', `${audit}-tile-${band}-${status}${zooming ? '-zoom' : panned ? '-pan' : ''}`);
                        if (zooming) auditCount(audit, geometry ? 'zoom:draw:standin:geometry' : 'zoom:draw:standin:raster');
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
                let refused = false;
                try {
                    for (const { route, run, clips } of slice.admitted) {
                        // Drawn through the shared `drawEncoded` with the run in `encodeDraw`: no closure is built per run.
                        const t0 = audited ? performance.now() : 0;
                        encodeDraw.pass = pass; encodeDraw.route = route; encodeDraw.run = run;
                        if (clips) withPreparedClips(pass, clips, drawEncoded);
                        else drawEncoded();
                        if (audited) auditStage(audit, 'draw', performance.now() - t0);
                        auditCount(audit, `route:${route.id}`);
                    }
                } catch (error) {
                    // A route's draw refused by the budget (its uniform ring, its vertex upload): this slice's tile is not composed. It is
                    // removed (its position reads missing, so the frame is incomplete there), and the frame asks for the next one.
                    if (!isBudgetRefusal(error)) throw error;
                    refused = true;
                    auditCount(audit, 'encode:refused');
                    noteShortfall(error);
                } finally {
                    encodeDraw.pass = null; encodeDraw.route = null; encodeDraw.run = null;
                }
                pass.end();
                if (refused) { store.remove(slice.key); wantFrame = true; drawRefusedNow = true; host.markIncomplete('encode-refused'); continue; }
                auditCount(audit, 'tile:compose', 1, { px: target.size * target.size });
                composedUnsettled.push(slice.key);
                entry.dirty = false; entry.composed = true; entry.revision = validRevision;
                slots.set(entry, { mode: slice.mode, count: position.slices.length, inkNodes: slice.inkNodes,
                    firstOrder: position.slices.map(part => part.firstOrder), live: position.live,
                    geometry: slice.admitted.some(admitted => isGeometryRoute(admitted.route)),
                    cpu: slice.admitted.some(admitted => admitted.route === routes.cpu) });
                if (slice.admitted.some(admitted => !exactRun(admitted.route, admitted.run))) { inexactPending.add(entry); auditCount(audit, 'zoom:inexact:composed'); }
                const image = routes.image;
                if (image?.waits) {
                    let keys: string[] | null = null;
                    for (const admitted of slice.admitted) {
                        const waits = admitted.route === image ? image.waits(admitted.run) : null;
                        if (waits) (keys ??= []).push(...waits);
                    }
                    if (keys) { awaitingDecode.set(entry, keys); auditCount(audit, 'image:await:composed'); }
                    else awaitingDecode.delete(entry);
                }
                store.touch(entry, frame);
            }
            for (const { route, run, clips } of slice.admitted) { route.retire(run); clips?.retire(); }
            slice.admitted.length = 0;
        }
    };

    const releaseAll = (): void => {
        if (pinsHeld) { pins?.releasePins(); pinsHeld = false; }
        for (const position of building.values()) cancel(position);
        building.clear();
        inexactPending.clear();
        awaitingDecode.clear();
        scaleIndexes.clear();
        for (const position of finished) cancel(position);
        finished = [];
        drawCount = 0;
        retireLive();
        store.releaseAll();
        for (const route of routeList) route.release();
        if (retryAt !== 0) host.wakeAt(null);
        denied = false; waiting = false; blockedOnGpu = false; roomForPosition = false; retryAt = 0; retryDelay = GPU_RETRY_MS; retryMisses = 0; settled = false; presenting = false; drawnInk.clear(); drawnInkFrame = -1;
        visibleWait = 0; liveWait = 0; liveWaitFrame = -1;
        heldNodes.clear();
        floorScale = 0; floorSpan = null; floorChecked.scale = 0; floorChecked.revision = -1; shownValid = false; holdSince = -1; frameHoles = 0; frameRegressions = 0;
        // The routes let go of the paint's resources at release; the next prepare scans its paint and hands them over again.
        resourcesSeen = null; paintScanned = null;
    };

    return {
        warm(prepared: PreparedPaint2d, maxMs: number): boolean {
            if (disposed) return false;
            const deadline = performance.now() + maxMs;
            // sync reads only shouldYield from its budget (contracts.ts types the whole FrameBudget; widening it is the contract owner's).
            const budget = { shouldYield: () => performance.now() >= deadline } as Pick<FrameBudget, 'shouldYield'> as FrameBudget;
            let done = false;
            while (!done && performance.now() < deadline) done = parts.sync(prepared, budget);
            return done;
        },
        prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): boolean {
            if (disposed) return true;
            evictEpoch++; wantFrame = false;
            // Two-phase (budget.phase): the foreground call runs this frame's intake and the foreground composes, then answers false (the
            // frame's answer is the background call's). The background call of the same frame finishes it. The scheduler never makes a
            // background call without its foreground; one that finds none answers true.
            const background = budget.phase === 'background';
            if (background && foregroundFrame !== budget.frameId) return true;
            let target = fTarget, zooming = fZooming, frameSpan = fSpan;
            if (!background) {
            editBits = 0; invalidatedNow = false;
            frame = budget.frameId;
            frameComposed = 0;
            frameDirtyCovered.clear();
            liveInkDropped.clear();
            plannedLive.underlay.clear(); plannedLive.content.clear();
            // The interned scales only name the positions in progress: with none in progress they are forgotten now, so a zoom's
            // scales are not kept after it ends (gpu: the churn cannot hold memory). The restart at 60 stays for a long zoom.
            if (!building.size) scaleIndexes.clear();
            else if (scaleIndexes.size >= 60) {
                // The keys' scale indexes are nearly spent: the positions in progress are restarted, which frees their indexes.
                for (const position of building.values()) cancel(position);
                building.clear(); scaleIndexes.clear();
            }
            denied = false; settled = false;
            refusedBefore = drawRefusedNow; drawRefusedNow = false;
            if (!liveDeferredNow) { liveDeferredFrames = 0; liveAdmittedBest = 0; }
            else if (liveAdmittedNow > liveAdmittedBest) { liveDeferredFrames = 0; liveAdmittedBest = liveAdmittedNow; }
            else liveDeferredFrames++;
            liveDeferredNow = false;
            const demand = view.camera.z * view.viewport.dpr;
            device = host.device();
            if (!prepared || !device || !(demand > 0) || !Number.isFinite(demand)) {
                for (const position of finished) cancel(position);
                finished = [];
                drawCount = 0; presenting = false; drawSignature = 0; contentVersion++; drawnInk.clear(); return true;
            }
            presenting = true;
            preparedSharp = prepared.sharp !== false;
            if (prepared !== paintScanned) { paintScanned = prepared; paintHasLive = windowsHaveLive(prepared); paintLiveOnly = liveOnlyPaint(prepared); }
            // A new resources object changes no tile already composed; a live draw that reads it moves contentVersion itself.
            if (prepared.resources !== resourcesSeen) {
                resourcesSeen = prepared.resources;
                for (const route of routeList) (route as ItemRoute & ResourcedRoute).useResources?.(prepared.resources);
            }
            // The scale moves only with the camera's zoom: a pan or a drag keeps the tiles' scale and their pixels.
            zooming = lastZoom !== undefined && view.camera.z !== lastZoom;
            lastZoom = view.camera.z;
            if (pins) {
                if (zooming) {
                    // The visible nodes of both bands, at the band this frame draws and the band before the last crossing.
                    const world: Rect = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
                    const ids = new Set<string>();
                    for (const band of BANDS) for (const part of parts.partsFor(band, world, omitIds ?? undefined)) ids.add(part.nodeId);
                    pins.pinVisible(ids);
                    pinsHeld = true;
                } else if (pinsHeld) { pins.releasePins(); pinsHeld = false; }
            }
            zoomingFrame = zooming;
            if (zooming) { auditCount(audit, 'zoom:prepare'); auditTape(`${audit}:zoom:prepare`); }
            // The text route draws a missing exact mask from its stand-in while the zoom is live; the flag is set before its admits.
            routes.text?.setZoom(zooming);
            // The path route composes a zoom's frames on its coverage route and its rest on exact area (routePath.ts, setZoom).
            routes.path.setZoom?.(zooming);
            // The image route takes a picture's byte share from the screen, whichever tile it composes (PictureRoute).
            screenScratch.x = view.camera.x; screenScratch.y = view.camera.y;
            screenScratch.width = view.viewport.width / view.camera.z; screenScratch.height = view.viewport.height / view.camera.z;
            routes.image?.setScreen?.(screenScratch);
            // Finer picture tiles the last admits left out while their textures were written are advanced first (PictureRoute.pump).
            routes.image?.pump?.(budget);
            // The inexact entries are kept through the whole zoom, not cleared each zoom frame: a zoom that returns to a scale reuses the
            // tiles it composed there earlier, and an entry dropped from the set then stayed inexact at rest (a saturated zoom alternates
            // between two scales). At rest only the entries of the resting scale are marked; the others go with their scale.
            const exact = exactScale(demand);
            // Compose targets the exact scale every frame, visible positions first (exact-first zoom, gpu).
            target = exact;
            zoomSpan = zooming ? spanAt(view, target) : null;
            // Panned: the camera moved since the last prepare at this zoom (the view's moving flag is not set by a pan's frames).
            panned = !zooming && (view.camera.x !== drawnCamX || view.camera.y !== drawnCamY);
            drawnCamX = view.camera.x; drawnCamY = view.camera.y; drawnCamZ = view.camera.z;

            indexing = !parts.sync(prepared, budget);
            // A pan with a visible position that has no exact tile draws its parts live, as a zoom does (gpu's ruling): the stand-in
            // it would show is replaced by its geometry. A pan whose tiles are all there composes as before.
            // A drag's omitted nodes are the preview's; its frames keep the path they had (the pan path is for the base's camera moves).
            // The drag preview's composer (a live overlay) has no tiles to miss: its parts are drawn live already.
            const panning = panned && options.liveOverlay !== true && !omitIds?.size && !indexing && anyVisibleMissing(view, target);
            // Settling lasts until the camera moves: the live and tiled pictures of a stroke can differ by a sample at its edge, so a switch
            // to the tiles at rest changed a pixel with no input (measured, gpu-f4: one tip pixel one frame after a doc12 pen-up, 2 of 3
            // runs, a second changed frame §8b refuses). A camera move redraws every pixel anyway.
            const exactBefore = exactAtX === view.camera.x && exactAtY === view.camera.y && exactAtZ === view.camera.z;
            // Content whose live and tiled pixels match leaves settling once its tiles are exact at this camera, quietly (no present).
            quietSwitch = options.liveMatchesTiles === true && directBefore && exactBefore && !zooming && !panned;
            // While a pointer is down the frame changes for its input anyway (the wet stroke grows, a marquee moves), so a board settled
            // live switches to its exact tiles there: settled live, every frame of a stroke redrew the whole visible board live (measured,
            // hz120 DPR 2: drawing saturated draw 42% of frames over 8.33 ms GPU, LARGE=11 73%). At rest the switch still waits for the
            // camera: alone in its frame, a stroke tip's edge sample changed with no input (gpu-f4, doc12 pen-up).
            const inputSwitch = !quietSwitch && directBefore && exactBefore && !zooming && !panned && options.inputActive?.() === true;
            if (inputSwitch) auditCount(audit, 'settle:switch:input');
            settling = !zooming && !panned && directBefore && !quietSwitch && !inputSwitch && options.liveOverlay !== true && !omitIds?.size && !indexing;
            liveNow = paintLiveOnly || (!indexing && (zooming || panning || settling) && zoomDirectOk(view, target));
            settling &&= liveNow;
            // The last direct frame (a zoom's, a pan's or a settling one) drew these parts at this camera: the same live picture.
            settleRepeat = settling && settleCamX === view.camera.x && settleCamY === view.camera.y && settleCamZ === view.camera.z;
            settleInexact = settleRepeat && liveInexact;
            if (settleInexact) { settleRepeat = false; auditCount(audit, 'settle:fresh:inexact'); }
            liveInexact = false;
            // Repeated, the live run of a picture that left its finer tiles out kept the stand-in for good once they landed (round 8:
            // a dropped 4000x3000 JPEG drawn live on a WebGL2 notebook, a 28 px soft edge at rest; one live plan in the whole case).
            if (settleRepeat && liveStale) { settleRepeat = false; auditCount(audit, 'settle:fresh:image-waits'); }
            liveStale = false;
            // A repeated settling frame draws the parts the last frame admitted, at the same camera: their runs are kept, not retired and
            // admitted again. Admitted afresh, every frame after a zoom re-tessellated and re-uploaded the whole visible board (measured,
            // gpu-f4: notebook paced drag 2.0 -> 13.0 ms GPU per frame). A deferred part (admitted as null) is asked again.
            if (settleRepeat && liveNow) {
                for (const [item, admitted] of liveAdmitted) if (admitted === null) liveAdmitted.delete(item);
                liveDeferredBy.clear();
                auditCount(audit, 'live:reused');
            } else retireLive();
            if (settling) auditCount(audit, 'settle:direct:frame');
            if (settling && !settleRepeat) auditCount(audit, Number.isNaN(settleCamX) ? 'settle:fresh:no-direct-before' : 'settle:fresh:camera');
            if (liveNow && !paintLiveOnly) { settleCamX = view.camera.x; settleCamY = view.camera.y; settleCamZ = view.camera.z; }
            else { settleCamX = Number.NaN; settleCamY = Number.NaN; settleCamZ = Number.NaN; }
            directBefore = liveNow && !paintLiveOnly;
            if (panning && liveNow) auditCount(audit, 'pan:direct:frame');
            // Why a moving view does not draw live (counters only): the index (indexing) gates the live draw, then the missing check.
            if (panned) auditCount(audit, indexing ? 'pan:skip:indexing' : !panning ? 'pan:skip:complete' : liveNow ? 'pan:live' : 'pan:skip:parts');
            if (liveNow && !paintLiveOnly) auditCount(audit, 'zoom:direct:frame');
            // A live-drawn frame draws in the background call, so its admissions are made here, in the foreground call: its live parts
            // are what the frame shows, and foreground is the budget they must not be starved from.
            if (liveNow && device) admitLiveFirst(view, budget);
            // A live draw holding an inexact run asks for the next frame itself: the frame after the zoom's last step draws it exact. Polled
            // needsFrame alone did not bring that frame (measured, notebook at 40%: the last zoom step's coverage paper stayed at rest).
            if (liveInexact) host.invalidate('live-inexact');
            if (zooming && !liveNow) auditCount(audit, indexing ? 'zoom:direct:skip:indexing' : 'zoom:direct:skip:parts');
            if (!indexing) {
                let invalidated = false;
                const changes = parts.takeChanges();
                if (changes === 'all') { store.markDirty('all'); invalidated = true; if (settleRepeat) auditCount(audit, 'settle:fresh:all'); settleRepeat = false; }
                else if (changes.length) {
                    for (const rect of changes) store.markDirty(rect);
                    invalidated = true;
                    // A settling frame's live picture holds the view's parts only: a change off the view (a wider paint window after a zoom
                    // step) leaves it the same (measured on LARGE=11: 30 of 36 redundant zoom presents named such a paint-ready frame).
                    if (settling) {
                        const world: Rect = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
                        for (const rect of changes) if (overlapsRect(rect, world)) {
                            if (settleRepeat) auditCount(audit, 'settle:fresh:visible-change');
                            settleRepeat = false; break;
                        }
                    }
                }
                // A whole-scene change is not laid live (every part would be): its tiles draw as before, flagged stale until composed.
                if (changes === 'all') pendingRegions.length = 0;
                else for (const rect of changes) pendingRegions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
                if (pendingRegions.length > PENDING_REGION_LIMIT) {
                    auditCount(audit, 'live:region:dropped');
                    pendingRegions.splice(0, pendingRegions.length - PENDING_REGION_LIMIT);
                }
                validRevision = prepared.root.sceneRevision;
                // A node a drag omits leaves the tiles it painted: its old bounds are recomposed once, when the set changes. The
                // tracker reports a change of members only, so a new Set of the same nodes costs nothing here.
                if (omitTracker.changed(omit)) {
                    settleRepeat = false;
                    const nextOmit = omit && omit.size ? omit : null;
                    const diff = new Set<string>();
                    for (const id of omitIds ?? []) if (!nextOmit?.has(id)) diff.add(id);
                    for (const id of nextOmit ?? []) if (!omitIds?.has(id)) diff.add(id);
                    for (const rect of parts.boundsOfNodes(diff)) {
                        store.markDirty(rect);
                        // A node that enters or leaves the omit set changes its own region: it is pending like a changed region, so
                        // its dirty positions are covered by live parts until they compose (a released node was not, before).
                        pendingRegions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
                    }
                    if (pendingRegions.length > PENDING_REGION_LIMIT) {
                        auditCount(audit, 'live:region:dropped');
                        pendingRegions.splice(0, pendingRegions.length - PENDING_REGION_LIMIT);
                    }
                    // A node that leaves the omit set is drawn live until the tiles under it are composed: its old tiles lack it.
                    for (const id of omitIds ?? []) if (!nextOmit?.has(id)) heldNodes.set(id, frame);
                    omitIds = nextOmit ? new Set(nextOmit) : null;
                    invalidated = true;
                }
                if (invalidated) { editEvent(EDIT_INVALID); invalidatedNow = true; }
                // A position admitted against the old content or omission would be encoded stale (it is not in the store
                // yet, so markDirty cannot reach it): every position in progress restarts when either changes.
                const span = spanAt(view, target);
                const margin = ringMargin(span, zooming);
                const ring: Span = { x0: span.x0 - margin, y0: span.y0 - margin, x1: span.x1 + margin, y1: span.y1 + margin };
                // The floor follows the view only at rest; a zoom or a pan stands on the one the last rest composed.
                if (!zooming && !panned && !liveNow) {
                    const cam = view.camera, w = view.viewport.width / cam.z, h = view.viewport.height / cam.z;
                    const region: Rect = { x: cam.x - FLOOR_VIEWS * w, y: cam.y - FLOOR_VIEWS * h, width: (2 * FLOOR_VIEWS + 1) * w, height: (2 * FLOOR_VIEWS + 1) * h };
                    const scale = 2 ** Math.floor(Math.log2(FLOOR_PIXELS / Math.max(region.width, region.height)));
                    // A view already that coarse needs no floor: its ring is the picture a zoom stands on.
                    if (Number.isFinite(scale) && scale > 0 && scale <= target / 4) {
                        const at = exactScale(scale);
                        const x0 = Math.floor(region.x * at / EDGE), y0 = Math.floor(region.y * at / EDGE);
                        const x1 = Math.ceil((region.x + region.width) * at / EDGE), y1 = Math.ceil((region.y + region.height) * at / EDGE);
                        const c = floorChecked;
                        if (at !== c.scale || x0 !== c.x0 || y0 !== c.y0 || x1 !== c.x1 || y1 !== c.y1 || validRevision !== c.revision) {
                            c.scale = at; c.x0 = x0; c.y0 = y0; c.x1 = x1; c.y1 = y1; c.revision = validRevision;
                            // A region holding more parts than FLOOR_MAX_PARTS has no floor: composing it costs every one of them again at
                            // the coarse scale, and a dense board's never finished, framing at rest (measured, the 3 MB board: the floor
                            // still admitting after 90 frames, its CPU prefetch refused 13,000 times in one gesture).
                            let count = 0;
                            const spanned: Rect = { x: x0 * EDGE / at, y: y0 * EDGE / at, width: (x1 - x0) * EDGE / at, height: (y1 - y0) * EDGE / at };
                            for (const band of BANDS) count += parts.partsFor(band, spanned, omitIds ?? undefined).length;
                            const fits = count <= FLOOR_MAX_PARTS && [x0, y0, x1, y1].every(Number.isSafeInteger);
                            floorScale = fits ? at : 0; floorSpan = fits ? { x0, y0, x1, y1 } : null;
                            if (!fits) auditCount(audit, 'floor:off:dense');
                        }
                    } else { floorScale = 0; floorSpan = null; }
                }
                staleScratch.length = 0;
                for (const position of building.values()) if (invalidated || !stillWanted(position, target, ring, span)) staleScratch.push(position);
                for (const position of staleScratch) { cancel(position); building.delete(position.key); }
                staleScratch.length = 0;
                // A finished position still valid for this content and scale waits for this frame's encode, so it is kept.
                const kept: Position[] = [];
                for (const position of finished) {
                    if (!invalidated && stillWanted(position, target, ring, span)) kept.push(position);
                    else cancel(position);
                }
                finished = kept;
                // At rest, the entries that drew a stand-in during the zoom recompose exact: marked dirty, they take the dirty pass.
                if (!zooming && inexactPending.size) {
                    for (const entry of inexactPending) {
                        if (entry.target && entry.key.scale === target) { entry.dirty = true; auditCount(audit, 'zoom:inexact:recompose'); }
                        else auditCount(audit, 'zoom:inexact:other-scale');
                    }
                    inexactPending.clear();
                }
                // At rest, an entry whose finer picture tiles have all settled (landed, or refused and replanned) recomposes, once.
                // Only the resting scale's entries are asked: asking starts the upload of each landed tile (PictureRoute.waiting), and
                // the entries a zoom composed on its way asked for textures no frame at this scale draws, filling the pool at rest
                // (measured, a 4000x3000 picture zoomed to 400% on a WebGL2 PDF at DPR 2, 4 runs: canvas2d bridges 4/1/3/3 and quality
                // down to 0.64 in 3; asked at the resting scale only, 2/2/2/2 and 0.64 in 1). Another scale's entry waits, asked
                // again once the view rests at its scale; one that left the store leaves the map.
                if (!zooming && awaitingDecode.size && routes.image?.waiting) {
                    for (const [entry, keys] of awaitingDecode) {
                        if (!entry.target) { awaitingDecode.delete(entry); continue; }
                        if (entry.key.scale !== target) continue;
                        if (routes.image.waiting(keys)) continue;
                        awaitingDecode.delete(entry);
                        entry.dirty = true; auditCount(audit, 'image:await:recompose');
                    }
                }
                // The armed retry is due and the refused position still waits on the GPU: it is advanced again this frame, after the
                // governor has been asked (the admission reserves). A refusal that persists arms the next retry.
                // A deadline that passes with no GPU wait left is cleared all the same: kept, the layer's shared wake slot sent it again with
                // every later store deadline, a frame each time (measured, the 5,642-stroke board after a zoom to fit, 1 run in 10: settled,
                // 600 frames per 10 s at rest, every one a 'wake').
                if (retryAt !== 0 && performance.now() >= retryAt) {
                    retryAt = 0; host.wakeAt(null);
                    if (waiting && blockedOnGpu) {
                        waiting = false; blockedOnGpu = false; roomForPosition = false;
                        for (const position of building.values()) position.parked = false;
                        auditCount(audit, 'compose:retry:deadline');
                    } else auditCount(audit, 'compose:retry:stale');
                }
                // The free list's idle trim: released once the store has been idle, and re-armed on the layer's wake while it is not due.
                store.trimIdle(performance.now());
                // What is on screen now is laid first: the live parts of changed and held nodes take the frame's upload allowance before
                // any tile compose, which is invisible while their live cover shows the node.
                if (!liveNow && device) admitVisibleFirst(view, target, span, budget);
                if (liveNow && !settling) {
                    // Drawn live at the view, so nothing is composed: any position in progress or finished is let go. A settling frame
                    // composes as at rest: its tiles are what the next frames draw.
                    for (const position of building.values()) cancel(position);
                    building.clear();
                    for (const position of finished) cancel(position);
                    finished = [];
                } else if (device) compose(view, budget, device, target, span, budget.phase === 'single' ? 'all' : 'foreground');
            } else {
                for (const position of finished) cancel(position);
                finished = [];
            }
            frameSpan = spanAt(view, target);
            fTarget = target; fZooming = zooming; fSpan = frameSpan;
            uploadPrepared();
            if (budget.phase === 'foreground') { foregroundFrame = budget.frameId; return false; }
            }
            // The background call (or the single-phase call) finishes the frame: the rest of the composes, the pending regions and held
            // nodes it no longer owes, then the draw list and the answer.
            if (!indexing) {
                if (background && (!liveNow || settling) && device) compose(view, budget, device, target, frameSpan, 'background');
                // A region is owed live parts while a dirty tile under it is in view: once those tiles are composed, it is let go.
                for (let r = pendingRegions.length - 1; r >= 0; r--) if (!regionStillDirty(pendingRegions[r], target, frameSpan)) pendingRegions.splice(r, 1);
                // A held node stays live while a tile under it is dirty, or a visible one under it has nothing yet.
                for (const id of heldNodes.keys()) if (!heldStillMissing(id, target, frameSpan)) heldNodes.delete(id);
            }
            // Each position draws its exact tile where it is there, and otherwise its nearest composed tiles, clipped to it. No frame
            // waits for the compose: a zoom shows what exists (gpu's ruling: geometry exact, raster scaled).
            drawnTarget = target;
            buildDraws(view, target, zooming, budget);
            liveAdmittedNow = liveRuns.length;
            // A held frame asks for the next one: the hole fills as its tiles compose and its parts are admitted, frame by frame.
            if (frameRegressions > 0) wantFrame = true;
            else if (!refusedBefore) holdSince = -1;
            // After the draw list: a live part it denied (a fill, a fallback, a cover) is visible work waiting too, counted this frame.
            settleVisibleWait(frameSpan);
            if (isolationNeed) reserveIsolationNeed(isolationNeed);
            // A settling frame is drawn live but owes its tiles: it is settled only once they are exact, so the composer keeps asking.
            const exact = allExact(view, target);
            // Settled with nothing in flight too: a visible position that composes nothing (empty) or waits on the governor must not keep
            // a settling composer asking for frames at rest; the governor's wake or the next change resumes it.
            settled = !indexing && ((liveNow && !settling) || exact || (settling && building.size === 0 && finished.length === 0 && inexactPending.size === 0));
            if (exact) { exactAtX = view.camera.x; exactAtY = view.camera.y; exactAtZ = view.camera.z; }
            else { exactAtX = Number.NaN; exactAtY = Number.NaN; exactAtZ = Number.NaN; }
            // Changed unless the frame drew what the last one drew: no edit, the same draw list, and a settled index.
            let signature = hashMix(liveNow ? 1 : 0, coverSignature);
            const afterRefusal = liveRefusedSigned !== liveRefusedSerial;
            liveRefusedSigned = liveRefusedSerial;
            for (let i = 0; i < drawCount; i++) {
                const draw = draws[i];
                // A cover's live parts change only with an edit, which presents through its scene revision: re-laid unchanged, they are the
                // same picture (counted, every staggered compose frame presented the cover again: gpu-f1's doc12 tape).
                // A path or ink part draws a pure function of its item and the view (the board compares the view, offset and draw version
                // itself): it is signed by its item, so the same item laid again is the same picture. Counted as a change on every live
                // frame, a drag preview at rest under the pointer presented its unchanged picture again (round 10 bar, 3c250bf5: large drag
                // 618, img8 585, doc12 521). Image and text parts keep the count: a tile or a glyph mask can land under the same item.
                const pure = draw.live && EXACT_LIVE_ROUTES.has(draw.liveRoute?.id ?? '');
                if (draw.live && !pure && !settleRepeat && !draw.cover) contentVersion++;
                // Sequential mixing keeps the order; a covered position's draws (which change in number when its tile replaces the cover)
                // are left out, so the draws after it sign the same.
                if (draw.cover) continue;
                signature = hashMix(signature, draw.band === 'underlay' ? 1 : 2);
                signature = hashMix(signature, hashText(String(draw.mode)));
                signature = hashMix(signature, Math.round(draw.x * 64)); signature = hashMix(signature, Math.round(draw.y * 64));
                signature = hashMix(signature, Math.round(draw.w * 64)); signature = hashMix(signature, Math.round(draw.h * 64));
                signature = hashMix(signature, draw.clipOn ? Math.round(draw.cx) * 4 + Math.round(draw.cy) * 8 + Math.round(draw.cw) * 16 + Math.round(draw.ch) * 32 : 0);
                signature = hashMix(signature, idOfObject(draw.texture));
                signature = hashMix(signature, draw.gen);
                signature = hashMix(signature, draw.live ? 1 + idOfObject(draw.liveRoute) : 0);
                if (pure) signature = hashMix(signature, idOfObject(draw.liveItem));
                if (draw.ink.length) signature = hashMix(signature, hashText(draw.ink.join('\u0001')));
            }
            const sigChanged = signature !== drawSignature;
            if (indexing) contentVersion++;
            // An edit the draw list does not show (a ring position composed, a cancelled build, a dropped scale) is not a visible change:
            // the signature holds every drawn entry's generation. Its offscreen encode runs in a frame that does not present.
            // A settling frame made fresh by the last live draw's inexact runs draws the same positions with the same routes, so its
            // signature is the last one's; it is still a new picture (the exact one), and a layer that reads only this answer (the
            // paper) would otherwise skip it (measured: present-skipped:unchanged, the zoom's coverage paper kept at rest).
            // A quiet switch with no change on the board draws the picture the settling frame drew: it answers unchanged.
            const quiet = quietSwitch && !invalidatedNow && !settleInexact;
            if (quiet && sigChanged) auditCount(audit, 'settle:switch:quiet');
            const changed = indexing || (sigChanged && !quiet) || settleInexact || afterRefusal;
            drawSignature = signature;
            // Why it answered changed, as audit counters (gh14): a prepare names every condition that held.
            if (changed && renderAuditEnabled()) {
                if (indexing) auditCount(audit, 'prepare:changed:indexing');
                if (afterRefusal) auditCount(audit, 'prepare:changed:after-refused-draw');
                if (settleInexact) auditCount(audit, 'prepare:changed:settle-inexact');
                if (editBits & EDIT_SUPERSEDED) auditCount(audit, 'prepare:changed:superseded');
                if (editBits & EDIT_EMPTY) auditCount(audit, 'prepare:changed:empty');
                if (editBits & EDIT_CANCEL) auditCount(audit, 'prepare:changed:cancelled');
                if (editBits & EDIT_FREE) auditCount(audit, 'prepare:changed:freed');
                if (editBits & EDIT_DONE) auditCount(audit, 'prepare:changed:composed');
                if (editBits & EDIT_SCALES) auditCount(audit, 'prepare:changed:scales-dropped');
                if (editBits & EDIT_INVALID) auditCount(audit, 'prepare:changed:invalidated');
                if (sigChanged) auditCount(audit, 'prepare:changed:draw-list');
            }
            uploadPrepared();
            return changed;
        },
        offscreenSettled(submitted: boolean): void {
            for (const route of routeList) route.offscreenSettled?.(submitted);
            const keys = composedUnsettled, encoded = routesEncodedFrame === frame;
            composedUnsettled = [];
            if (submitted || (!keys.length && !encoded)) return;
            // The routes' conversions run again in the next encode; the tiles' runs are retired, so their positions compose again.
            let dropped = 0;
            for (const key of keys) if (entryOfKey(key)) { store.remove(key); dropped++; }
            auditCount(audit, 'encode:discarded', dropped);
            wantFrame = true; host.invalidate('tile-encode-discarded');
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
            reportRouteRefusals();
        },
        drawGpu(pass: GpuPass, view: ViewState, band: PaintBand): void {
            if (drawnInkFrame !== frame) { drawnInkFrame = frame; drawnInk.clear(); }
            if (shownFrame !== frame && presenting && listUsable(view)) {
                // What this frame lays is what the screen shows next: its view's world, less its own holes (the next frame's regression test).
                shownFrame = frame;
                const cam = view.camera;
                shownWorld.x = cam.x; shownWorld.y = cam.y; shownWorld.width = view.viewport.width / cam.z; shownWorld.height = view.viewport.height / cam.z;
                shownValid = true;
                const swapHoles = lastHoles; lastHoles = curHoles; curHoles = swapHoles; curHoles.length = 0;
                // Every frame laid with an in-view item missing is counted by why: a regression laid past its hold, content revealed by the
                // move that no tile or live part could show yet, or content still loading at rest (the board then says it is working).
                if (frameHoles > 0 && missingCounted !== frame) {
                    missingCounted = frame;
                    auditCount(audit, frameRegressions > 0 ? 'present:missing:hold-expired' : zoomingFrame || panned || liveNow ? 'present:missing:revealed' : 'present:missing:loading', frameHoles);
                }
            }
            // Cleared where the set is filled, not at prepare: the base layer reads it between the overlay's prepare and its draw. Cleared
            // at prepare, the base read an empty set on every frame of a drag, so it never omitted the dragged node's original (measured:
            // the overlay planned the node, drawn=0 at each base read, base omission none; the original stayed on screen until release).
            drawnLive[band].clear();
            drewAny[band] = false;
            if (!drawCount) return;
            if (!listUsable(view)) { auditCount(audit, 'draw:stale-list'); wantFrame = true; return; }
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
                drewAny[band] = true;
                if (draw.live) {
                    // A live part: drawn through the image route under its position's clip, in paint order; never batched.
                    if (draw.clipOn) {
                        scissor.x = draw.cx; scissor.y = draw.cy; scissor.width = draw.cw; scissor.height = draw.ch;
                        const clip = pass.pushClip(scissor);
                        drawnLive[draw.band].add(draw.node);
                        // Ink laid live is drawn ink: the wet layer hands a stroke over on this report in the same frame. Reported for tiles
                        // only, a committed stroke laid live at pen-up (its positions still composing) was drawn by both for one frame:
                        // measured, every anti-aliased edge of the stroke 2,168 px darker for one frame, then back.
                        if ((draw.liveRoute?.id === 'ink-analytic' || draw.liveRoute?.id === 'ink-union') && !liveInkDropped.has(draw.node)) drawnInk.add(draw.node);
                        // The pop is in finally: a throw inside the draw must not leave the scope open (the encoder then refuses the frame).
                        try { draw.liveRoute?.draw(pass, draw.live); }
                        catch (error) {
                            // A budget refusal is counted and the frame asks again; any other error is reported and thrown.
                            if (!isBudgetRefusal(error)) { auditGpuError(audit, 'live-clip', error); throw error; }
                            auditCount(audit, 'draw:refused'); noteShortfall(error); wantFrame = true; drawRefusedNow = true; liveRefusedSerial++; host.markIncomplete('live-draw-refused');
                        }
                        finally { pass.popClip(clip); }
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
                // The group and the clip are closed in finally: a throw in between must not leave either open (the encoder refuses that).
                try {
                    if (draw.mode === 'isolated') {
                        // A group's bounds are on the surface too: a negative origin is refused like a negative scissor.
                        bounds.x = Math.max(0, Math.floor(dest.x)); bounds.y = Math.max(0, Math.floor(dest.y));
                        bounds.width = Math.min(surfaceW, Math.ceil(dest.x + dest.width)) - bounds.x;
                        bounds.height = Math.min(surfaceH, Math.ceil(dest.y + dest.height)) - bounds.y;
                        group = pass.beginGroup(bounds, GROUP);
                    }
                    lay(pass, texture, CROP, dest, draw.mode === 'modulate' ? 'modulate' : 'over');
                } finally {
                    if (group) pass.endGroup(group);
                    if (clip) pass.popClip(clip);
                }
                i++;
            }
            reportRouteRefusals();
        },
        coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean } {
            if (!presenting) return { complete: false, sharp: false };
            // A draw list that cannot be drawn for this view is a hole: the frame is incomplete (the board is critical while it is).
            if (drawCount && !listUsable(view)) { wantFrame = true; return { complete: false, sharp: false }; }
            const exact = exactScale(view.camera.z * view.viewport.dpr);
            // A live frame drew every part of the view, or fell back to tiles (liveMissed) and is judged as a tile frame below.
            if (liveNow && !indexing && !liveMissed) return { complete: true, sharp: preparedSharp && drawnTarget === exact };
            const target = drawnTarget;
            const span = spanAt(view, target);
            // A position with any picture (its tile at the drawn scale, a dirty one, or a stand-in of another scale) is
            // complete; only a position with nothing is not. Sharp needs the drawn scale to be the demanded one, and every
            // position exact and clean there.
            // While zooming, a position with nothing is a hole the compose pass is filling, and it does not hold the frame: the
            // compositor refused 58 of 141 zoom frames for holes waiting on upload allowance (the audit's board-underlay:incomplete,
            // equal to compositor:refuse:coverage). PLAN 3.1: a zoom presents what exists, scaled, every frame.
            // A position with no picture (frameHoles, from the draw list itself) or a draw refused this frame leaves the frame incomplete,
            // zooming or not: the hold (holding) decides whether it may still be presented.
            // A live frame that fell back to tiles is sharp where every position drew its exact tile: judged unsharp for the fallback alone, the
            // old Notes4 opened and rested on its exact tiles reported as a stand-in, never sharp (open-to-sharp unset, live frames at rest).
            let complete = frameHoles === 0 && !drawRefusedNow, sharp = !indexing && preparedSharp && target === exact, stale = indexing;
            for (const band of BANDS) {
                for (let y = span.y0; y < span.y1; y++) {
                    for (let x = span.x0; x < span.x1; x++) {
                        const status = statusAt(band, target, x, y);
                        if (status === 'ok') continue;
                        // Composed this frame: drawn fresh (buildDraws' pending path), so the frame is sharp here. The compositor reads
                        // coverage before the encode, and the entry it still finds is the old one; the draw is not.
                        if (status === 'missing' && finishedAt(band, target, x, y)) continue;
                        // A dirty position whose changed pixels this frame's live parts lay is current: complete and sharp (gpu-h11's
                        // trace: 112 of 113 draw and 29 of 32 drag incomplete presents were covered dirty positions counted as stand-ins).
                        if (status === 'dirty' && coveredPositions.has(positionKey(band, target, x, y))) continue;
                        sharp = false;
                        if (status === 'dirty') { stale = true; continue; }
                        if (!zoomingFrame && !liveNow && !standInsOf(band, target, x, y).length) complete = false;
                    }
                }
            }
            return { complete, sharp: complete && sharp, ...(stale ? { staleVersion: true } : {}) };
        },
        drawnInkNodeIds(): ReadonlySet<string> { return drawnInk; },
        drawnLiveNodeIds(band: PaintBand): ReadonlySet<string> { return drawnLive[band]; },
        drewNothing(band: PaintBand): boolean { return !drewAny[band]; },
        plannedLiveNodeIds(band: PaintBand): ReadonlySet<string> { return plannedLive[band]; },
        mandatoryBytes(width: number, height: number): number {
            if (disposed || !presenting) return 0;
            const target = drawnTarget;
            // The span spanAt computes for the drawn camera, counted by the store per band: composed slices only.
            const index = store.scaleIndexOf(target);
            if (index < 0) return visibleWait;
            const x0 = Math.floor(drawnCamX * target / EDGE), y0 = Math.floor(drawnCamY * target / EDGE);
            const x1 = Math.ceil((drawnCamX + width / drawnCamZ) * target / EDGE), y1 = Math.ceil((drawnCamY + height / drawnCamZ) * target / EDGE);
            let bytes = 0;
            for (const band of BANDS) bytes += store.countComposed(band, index, x0, y0, x1 - 1, y1 - 1) * TARGET_BYTES;
            return bytes + visibleWait;
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
        incomplete(): boolean { return !disposed && presenting && (frameHoles > 0 || drawRefusedNow); },
        holding(): boolean {
            if (disposed || !presenting || (frameRegressions === 0 && !drawRefusedNow)) return false;
            // Judged once per frame (the compositor reads critical more than once): the first held frame starts the hold's clock.
            if (holdFrame !== frame || holdRefused !== drawRefusedNow) {
                holdFrame = frame; holdRefused = drawRefusedNow;
                const now = performance.now();
                if (holdSince < 0) holdSince = now;
                holdNow = now - holdSince <= HOLE_HOLD_MS;
                auditCount(audit, holdNow ? `hold:${drawRefusedNow ? 'draw-refused' : holeCause}` : 'hold:expired');
                // A refused draw past its hold is presented without what it planned: counted as a frame laid with an item missing.
                if (!holdNow && drawRefusedNow) auditCount(audit, 'present:missing:draw-refused');
            }
            return holdNow;
        },
        needsFrame(): boolean {
            if (disposed || !presenting) return false;
            if (wantFrame) return true;
            // The last live draw held an inexact run (a zoom's coverage-route area, a text stand-in): the frame after it is owed.
            if (liveInexact) return true;
            // A pinned zoom is released by the frame that finds the zoom over: that frame is asked for, so the pins do not outlive the zoom.
            if (pinsHeld) return true;
            if (denied) return false;
            if (liveDeferredNow) {
                if (liveDeferredFrames < GPU_RETRY_LIMIT) return true;
                auditCount(audit, 'live:deferred:stopped');
            }
            if (waiting) return indexing || finished.length > 0;
            const wants = indexing || !settled || building.size > 0 || finished.length > 0 || inexactPending.size > 0;
            // Which outstanding work keeps the board asking for frames: at rest none may (0 frames), and a count here names it.
            if (wants && renderAuditEnabled()) auditCount(audit, `needs-frame:${indexing ? 'indexing' : building.size ? 'building' : finished.length ? 'finished'
                : inexactPending.size ? 'inexact-pending' : 'unsettled'}`);
            return wants;
        },
        memory(): { gpuBytes: number; cpuBytes: number } {
            const own = store.memory();
            let gpuBytes = own.gpuBytes, cpuBytes = own.cpuBytes;
            for (const route of routeList) { const m = route.memory(); gpuBytes += m.gpuBytes; cpuBytes += m.cpuBytes; }
            return { gpuBytes, cpuBytes };
        },
        release(_reason: GpuReleaseReason): void { releaseAll(); },
        // The epoch alone: an evicted entry that was drawn leaves the next draw list (listUsable fails until it is rebuilt), so the
        // signature moves; one that was not drawn changes nothing on screen (measured: 9 of 17 redundant zoom presents on LARGE=11).
        noteEvicted(): void { evictEpoch++; },
        liveEviction(): LiveEviction { return !liveNow || paintLiveOnly ? false : settling ? 'settling' : 'moving'; },
        contentKey(): number { return hashMix(drawSignature, contentVersion); },
        listInvalid(view: ViewState): boolean { return drawCount > 0 && !listUsable(view); },
        dispose(): void {
            if (disposed) return;
            releaseAll();
            disposed = true;
        },
    };
}
