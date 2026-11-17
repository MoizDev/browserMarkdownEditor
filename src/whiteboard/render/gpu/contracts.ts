// The board's GPU tile composer, as one data flow: parts (index) → routes (admit/draw) → store (tiles) → composer.
// Each stage is a separate file with one owner, because the single adapter file they replace had four concurrent
// editors and two lanes that still conflict in it. Only this file is shared; it holds types, never behaviour.
// Design: planning/60-implementation/gpu-handoff/PLAN.md §3.
import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice, GpuPass } from '../../../platform/render/gfx/api';
import type { FrameBudget } from '../../../platform/render/types';
import type { TileTarget } from '../../../platform/render/tileTarget';
import type { PaintBand } from '../material';
import type { PaintClip, PaintInkItem, PaintItem } from '../paintStream';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';

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

export interface TileStore {
    get(id: string): TileEntry | undefined;
    /** A target from the free list or a new lease. null = refused: keep the stand-in and call `wait(bytes)`. */
    acquire(key: TileKey, blend: Blend, device: GfxDevice): TileEntry | null;
    putEmpty(key: TileKey): TileEntry;
    markDirty(world: Readonly<Rect> | 'all', band?: PaintBand): number;
    /** Composed entries of other scales covering `world`, nearest scale first. */
    standIns(band: PaintBand, world: Readonly<Rect>, scale: number): readonly TileEntry[];
    touch(entry: TileEntry, frameId: number): void;
    /** Never an entry touched in `frameId`. Order: free list, other scales off view, same scale off view (farthest
     *  first), other scales on view that a composed tile covers. Returns the bytes actually freed. */
    evict(bytes: number, frameId: number, view: ViewState): number;
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
export type CreateInkRoutes = RouteFactory<{ readonly analytic: ItemRoute<PaintInkItem>; readonly union: ItemRoute<PaintInkItem> }>;
export type CreateImageRoute = RouteFactory<ItemRoute>;
export type CreateTextRoute = RouteFactory<ItemRoute>;
