// The board's GPU tile composer, as one data flow: parts (index) → routes (admit/draw) → store (tiles) → composer.
// Each stage is a separate file with one owner, because the single adapter file they replace had four concurrent
// editors and two lanes that still conflict in it. Only this file is shared; it holds types, never behaviour.
// Design: planning/60-implementation/gpu-handoff/PLAN.md §3.
import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice, GpuPass } from '../../../platform/render/gfx/api';
import type { FrameBudget, OffscreenPasses } from '../../../platform/render/types';
import type { TileTarget } from '../../../platform/render/tileTarget';
import type { PaintBand } from '../material';
import type { PaintClip, PaintInkItem, PaintItem } from '../paintStream';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';
import type { InkCoverage } from '../../ink/outline';

/** 'modulate' lays a multiply slice by fixed-function blending: dst · src (rgb ZERO, SRC_COLOR; alpha ZERO, ONE). */
export type Blend = 'over' | 'modulate';
export type RouteId = 'path' | 'ink-analytic' | 'ink-union' | 'image' | 'text' | 'cpu';

export type Admission<T> =
    | { readonly status: 'ready'; readonly value: T }
    | { readonly status: 'empty' }
    | { readonly status: 'deferred' }
    | { readonly status: 'denied'; readonly pool: 'gpu' | 'cpu'; readonly bytes: number }
    | { readonly status: 'unsupported'; readonly why: string };

/** A run of consecutive parts with one route and one blend, prepared for one view. Routes extend it privately. */
export interface PreparedRun {
    readonly route: RouteId;
    readonly blend: Blend;
}

export interface ItemRoute<I extends PaintItem = PaintItem> {
    readonly id: RouteId;
    accepts(item: PaintItem): item is I;
    /** CPU work and uploads only, resumable. `view` is a tileView or the pane view. Content-keyed: the same item
     *  in the same tolerance band costs no tessellation and no upload a second time. */
    admit(items: readonly I[], view: ViewState, blend: Blend, budget: FrameBudget): Admission<PreparedRun>;
    /** Draws only: no allocation, no upload, no readback. */
    draw(pass: GpuPass, run: PreparedRun): void;
    /** GPU-side preparation that needs its own pass (e.g. converting an uploaded text bitmap into an R8 atlas page),
     *  so nothing is read back to the CPU. The composer calls it once per frame at the start of its encodeOffscreen,
     *  before any tile pass, for every route that has it. */
    encodeOffscreen?(passes: OffscreenPasses): void;
    /** Whether the frame of the last encodeOffscreen reached the device (Layer.offscreenSettled). Work it did is undone on `false`. */
    offscreenSettled?(submitted: boolean): void;
    /** Uploads what this frame's admits staged for encodeOffscreen. The composer calls it at the end of each prepare (its foreground and
     *  background calls alike), because every upload belongs to prepare: a device refuses one once a pass is recorded in the frame, and a
     *  composer's encodeOffscreen runs after the passes of the layers encoded before it. */
    uploadPrepared?(): void;
    retire(run: PreparedRun): void;
    /** Every GPU resource; idempotent. */
    release(): void;
    memory(): { gpuBytes: number; cpuBytes: number };
}

export interface TilePart {
    readonly band: PaintBand;
    readonly order: number;
    readonly nodeId: string;
    readonly item: PaintItem;
    readonly world: Readonly<Rect>;
    readonly blend: Blend;
}

export interface TileParts {
    /** Index `prepared` (resumable under `budget`); false while still indexing. Same revision: a no-op. */
    sync(prepared: PreparedPaint2d, budget: FrameBudget): boolean;
    partsFor(band: PaintBand, world: Readonly<Rect>, omit?: ReadonlySet<string>): readonly TilePart[];
    /** World rects changed since the previously synced revision; 'all' when unknown. Read once per sync. */
    takeChanges(): readonly Rect[] | 'all';
    boundsOfNodes(ids: ReadonlySet<string>): readonly Rect[];
    /** Drops the index and any build in progress (a hidden pane): the next sync indexes its paint from scratch. */
    release(): void;
}

/** `scale` is device pixels per world unit; interior covers world [x·512/scale, (x+1)·512/scale) on each axis. */
export interface TileKey {
    readonly band: PaintBand;
    readonly scale: number;
    readonly x: number;
    readonly y: number;
    readonly slice: number;
}

export interface TileEntry {
    readonly key: TileKey;
    readonly id: string;
    readonly blend: Blend;
    readonly target: TileTarget | null;
    revision: number;
    dirty: boolean;
    composed: boolean;
    usedFrame: number;
}

/** How the composer draws the view, for an eviction: not live (its tiles are drawn), live while the view moves (a zoom or a pan
 * drawn direct: no tile at the view is what it draws next), or live while it settles (the view rests: it draws live until the tiles
 * at the view are composed, and those tiles are what it then draws). */
export type LiveEviction = false | 'moving' | 'settling';

export interface TileStore {
    get(id: string): TileEntry | undefined;
    /** A target from the free list or a new lease. null = refused: keep the stand-in and call `wait(bytes)`. A `prefetch` target (the
     * rest ring) takes a new lease only if it fits without the governor reclaiming anything. */
    acquire(key: TileKey, blend: Blend, device: GfxDevice, prefetch?: boolean): TileEntry | null;
    putEmpty(key: TileKey): TileEntry;
    markDirty(world: Readonly<Rect> | 'all', band?: PaintBand): number;
    /** Composed entries of other scales covering `world`, nearest scale first. */
    standIns(band: PaintBand, world: Readonly<Rect>, scale: number): readonly TileEntry[];
    touch(entry: TileEntry, frameId: number): void;
    /** Never an on-view entry touched in `frameId`, unless the composer draws the view live (`live`: no tile is drawn). Order:
     *  free list, other scales off view (live: every other scale), same scale off view (farthest first), then, live while the view
     *  moves, the same scale on view, else other scales on view that a composed tile covers. Returns the bytes actually freed. */
    evict(bytes: number, frameId: number, view: ViewState, live?: LiveEviction): number;
    /** Stamps every held entry the view shows, at any scale, as used in `frameId` (see Layer.protectFrame). */
    touchVisible(view: ViewState, frameId: number): void;
    dropScalesExcept(scale: number, band: PaintBand): number;
    wait(bytes: number, wake: () => void): void;
    releaseAll(): void;
    memory(): { gpuBytes: number; cpuBytes: number };
}

/** Rect clips as scissor, others as a coverage mask; every route draws under an item's clips only through this. */
export type WithClips = (pass: GpuPass, clips: readonly PaintClip[], view: ViewState, draw: () => void) => Admission<void>;

/** Implemented in tileStore.ts (h1). */
export type TileIdFn = (key: TileKey) => string;
/** Interior world rect, without the gutter. Implemented in tileStore.ts (h1). */
export type TileWorldFn = (key: TileKey) => Rect;
/** The only place an ink route is chosen; wet and committed ink both call it. Implemented in routeInk.ts (h5). */
export type InkRouteFor = (item: PaintInkItem) => 'ink-analytic' | 'ink-union';

/** Every factory takes the pane's stable host and the adapter's audit surface name. */
export type RouteFactory<R> = (host: LayerHost, audit: string) => R;
export type CreateTileStore = RouteFactory<TileStore>;
export type CreateTileParts = RouteFactory<TileParts>;
export type CreatePathRoute = RouteFactory<ItemRoute>;
export type CreateInkRoutes = RouteFactory<{ readonly analytic: ItemRoute<PaintInkItem>; readonly union: ItemRoute<PaintInkItem>;
    /** Frees up to `bytes` of the union route's idle chunk geometry, never a chunk in `keep`; returns the bytes freed. */
    readonly evictCpu: (bytes: number, keep: ReadonlySet<InkCoverage>) => number;
    /** Marks the frame the calls that follow belong to (the union route's kits: a refused draw is reported for its own frame only). */
    readonly beginFrame: (frame: number) => void;
    /** The GPU reclaim for the union route's idle buffers (its grid kit's triangles, its exact-area kit's edge sets), none used in the
     * frame `beginFrame` named (`keepRecent`: nor the route's previous one); returns the bytes freed. */
    readonly evictGpu: (bytes: number, keepRecent?: boolean) => number }>;
export type CreateImageRoute = RouteFactory<ItemRoute>;
export type CreateTextRoute = RouteFactory<ItemRoute>;
