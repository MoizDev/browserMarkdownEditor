import type { Rect, ViewState } from '../../../platform/types';
import type { LayerHost } from '../../../platform/render/compositor.types';
import type { GfxDevice, GpuPass } from '../../../platform/render/gfx/api';
import type { FrameBudget, OffscreenPasses } from '../../../platform/render/types';
import type { TileTarget } from '../../../platform/render/tileTarget';
import type { PaintBand } from '../material';
import type { PaintClip, PaintInkItem, PaintItem } from '../paintStream';
import type { PreparedPaint2d } from '../reference/canvasPaintAdapter';
import type { InkCoverage } from '../../ink/outline';

export type Blend = 'over' | 'modulate';
export type RouteId = 'path' | 'ink-analytic' | 'ink-union' | 'image' | 'text' | 'cpu';

export type Admission<T> =
    | { readonly status: 'ready'; readonly value: T }
    | { readonly status: 'empty' }
    | { readonly status: 'deferred' }
    | { readonly status: 'denied'; readonly pool: 'gpu' | 'cpu'; readonly bytes: number }
    | { readonly status: 'unsupported'; readonly why: string };

export interface PreparedRun {
    readonly route: RouteId;
    readonly blend: Blend;
}

export interface ItemRoute<I extends PaintItem = PaintItem> {
    readonly id: RouteId;
    accepts(item: PaintItem): item is I;
    admit(items: readonly I[], view: ViewState, blend: Blend, budget: FrameBudget): Admission<PreparedRun>;
    draw(pass: GpuPass, run: PreparedRun): void;
    encodeOffscreen?(passes: OffscreenPasses): void;
    offscreenSettled?(submitted: boolean): void;
    /** Uploads what this frame's admits staged for encodeOffscreen. The composer calls it at the end of each prepare (its foreground and
     *  background calls alike), because every upload belongs to prepare: a device refuses one once a pass is recorded in the frame, and a
     *  composer's encodeOffscreen runs after the passes of the layers encoded before it. */
    uploadPrepared?(): void;
    retire(run: PreparedRun): void;
    abandon?(items: readonly I[]): void;
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
    sync(prepared: PreparedPaint2d, budget: FrameBudget): boolean;
    partsFor(band: PaintBand, world: Readonly<Rect>, omit?: ReadonlySet<string>): readonly TilePart[];
    takeChanges(): readonly Rect[] | 'all';
    boundsOfNodes(ids: ReadonlySet<string>): readonly Rect[];
    release(): void;
}

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

export type LiveEviction = false | 'moving' | 'settling';

export interface TileStore {
    get(id: string): TileEntry | undefined;
    acquire(key: TileKey, blend: Blend, device: GfxDevice, prefetch?: boolean): TileEntry | null;
    putEmpty(key: TileKey): TileEntry;
    markDirty(world: Readonly<Rect> | 'all', band?: PaintBand): number;
    standIns(band: PaintBand, world: Readonly<Rect>, scale: number, empty?: boolean): readonly TileEntry[];
    touch(entry: TileEntry, frameId: number): void;
    evict(bytes: number, frameId: number, view: ViewState, live?: LiveEviction): number;
    touchVisible(view: ViewState, frameId: number): void;
    dropScalesExcept(scale: number, band: PaintBand, keep?: number, usedSince?: number): number;
    wait(bytes: number, wake: () => void): void;
    releaseAll(): void;
    memory(): { gpuBytes: number; cpuBytes: number };
}

export type WithClips = (pass: GpuPass, clips: readonly PaintClip[], view: ViewState, draw: () => void) => Admission<void>;

export type TileIdFn = (key: TileKey) => string;
export type TileWorldFn = (key: TileKey) => Rect;
export type InkRouteFor = (item: PaintInkItem) => 'ink-analytic' | 'ink-union';

export type RouteFactory<R> = (host: LayerHost, audit: string) => R;
export type CreateTileStore = RouteFactory<TileStore>;
export type CreateTileParts = RouteFactory<TileParts>;
export type CreatePathRoute = RouteFactory<ItemRoute>;
export type CreateInkRoutes = RouteFactory<{ readonly analytic: ItemRoute<PaintInkItem>; readonly union: ItemRoute<PaintInkItem>;
    readonly evictCpu: (bytes: number, keep: ReadonlySet<InkCoverage>) => number;
    readonly beginFrame: (frame: number) => void;
    readonly evictGpu: (bytes: number, keepRecent?: boolean) => number }>;
export type CreateImageRoute = RouteFactory<ItemRoute>;
export type CreateTextRoute = RouteFactory<ItemRoute>;
