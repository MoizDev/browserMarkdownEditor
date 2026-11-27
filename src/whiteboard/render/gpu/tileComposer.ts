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
const FREE_FOR_REFUSAL = 8 * TARGET_BYTES;
const GPU_RETRY_MS = 250;
const GPU_RETRY_MAX_MS = 4000;
const GPU_RETRY_LIMIT = 12;
const FREE_RETRY_ROUNDS = 8;
const LIVE_ADMIT_ATTEMPTS = 4;
const CLEAR: RgbaP = [0, 0, 0, 0], WHITE: RgbaP = [1, 1, 1, 1];
const CROP: Readonly<Rect> = Object.freeze({ x: GUTTER, y: GUTTER, width: EDGE, height: EDGE });
const GROUP = Object.freeze({ opacity: 1, blend: 'multiply', colourEffect: 'none' } as const);
const QUAD_BATCH = 4096;
const NO_IDS: readonly string[] = Object.freeze([]);
const NO_ORDERS: readonly number[] = Object.freeze([]);
const NO_OPAQUE: readonly Rect[] = Object.freeze([]);

export type WithPreparedClips = (pass: GpuPass, prepared: PreparedClips, draw: () => void) => void;
function kindOf(items: readonly PaintItem[]): string {
    const kind = items[0].kind;
    return items.every(item => item.kind === kind) ? kind : 'mixed';
}
function timedStage<T>(surface: string, stage: AuditStage, fn: () => T): T {
    if (!renderAuditEnabled()) return fn();
    const t0 = performance.now();
    try { return fn(); } finally { auditStage(surface, stage, performance.now() - t0); }
}

type Mode = 'over' | 'modulate' | 'isolated';

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const idOfObject = (object: object | null): number => {
    if (!object) return 0;
    let id = objectIds.get(object);
    if (id === undefined) { id = nextObjectId++; objectIds.set(object, id); }
    return id;
};
const hashMix = (hash: number, value: number): number => Math.imul(hash ^ value, 16777619);
const EXACT_LIVE_ROUTES: ReadonlySet<string> = new Set(['path', 'ink-analytic', 'ink-union']);
type RouteWithRefusal = { drawRefusedThisFrame?(): boolean };
const DIRTY_FIRST = ['dirty', 'missing', 'ring'] as const;
const DIRTY_COVERED_PER_FRAME = 1;
const MISSING_FIRST = ['missing', 'dirty', 'ring'] as const;
const hashText = (text: string): number => { let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = hashMix(hash, text.charCodeAt(i)); return hash; };
type Status = 'missing' | 'dirty' | 'ok';
interface Slot {
    readonly mode: Mode; readonly count: number; readonly inkNodes: readonly string[];
    readonly firstOrder: readonly number[];
    readonly live: number;
    readonly geometry: boolean;
    readonly cpu: boolean;
}
interface Run {
    readonly items: PaintItem[]; route: ItemRoute;
    clips: readonly PaintClip[] | null;
    prepared: PreparedClips | null;
    why: string | null; label: string | null; counted: boolean;
}
interface Admitted { readonly route: ItemRoute; readonly run: PreparedRun; readonly clips: PreparedClips | null }
interface Slice {
    readonly key: TileKey;
    readonly mode: Mode;
    readonly blend: Blend;
    readonly view: ViewState;
    readonly runs: Run[];
    readonly inkNodes: readonly string[];
    readonly firstOrder: number;
    next: number;
    readonly admitted: Admitted[];
    entry: TileEntry | null;
}
interface Position {
    readonly band: PaintBand;
    readonly scale: number;
    readonly x: number;
    readonly y: number;
    readonly slices: Slice[];
    cursor: number;
    parked: boolean;
    lowered: boolean;
    readonly key: number;
    readonly live: number;
    drivenFrame: number;
    deniedGpu: number;
}
interface Span { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
interface Draw {
    band: PaintBand; texture: TextureHandle | null; mode: Mode;
    gen: number;
    x: number; y: number; w: number; h: number;
    clipOn: boolean; cx: number; cy: number; cw: number; ch: number;
    ink: readonly string[];
    live: PreparedRun | null;
    liveRoute: ItemRoute | null;
    liveItem: object | null;
    node: string;
    cover: boolean;
}

interface LiveAdmission { readonly route: ItemRoute; readonly run: PreparedRun }

export interface TileRoutes {
    readonly path: ItemRoute & Partial<ZoomRoute>;
    readonly inkAnalytic: ItemRoute<PaintInkItem>;
    readonly inkUnion: ItemRoute<PaintInkItem> & Partial<Pick<ZoomRoute, 'exact'>>;
    readonly image?: ItemRoute & Partial<PictureRoute>;
    readonly text?: ItemRoute & ZoomRoute;
    readonly cpu: ItemRoute;
}
export interface ZoomRoute { setZoom(zooming: boolean): void; exact(run: PreparedRun): boolean }
export interface PictureRoute {
    setScreen(world: Rect | null): void;
    pump(budget: FrameBudget): void;
    waits(run: PreparedRun): readonly string[] | null;
    waiting(keys: readonly string[]): boolean;
}
export interface ResourcedRoute { useResources?(resources: PaintResources2d): void }
export type TileLay = (pass: GpuPass, texture: TextureHandle, source: Readonly<Rect>, dest: Readonly<Rect>, blend: Blend) => void;
export type TileLayQuads = (pass: GpuPass, texture: TextureHandle, quads: readonly TexturedQuadSpec[]) => void;

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
    readonly admitClips: AdmitClips;
    readonly withPreparedClips: WithPreparedClips;
    readonly opaqueWorld?: () => readonly Rect[];
    readonly pins?: GeometryPins;
    readonly slowGpu?: () => boolean;
    readonly reclaimRoutes?: (bytes: number, frame: number) => number;
    readonly liveOverlay?: boolean;
    readonly liveMatchesTiles?: boolean;
    readonly inputActive?: () => boolean;
}

export interface TileComposer {
    prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): boolean;
    warm(prepared: PreparedPaint2d, maxMs: number): boolean;
    encodeOffscreen(passes: OffscreenPasses, view: ViewState, band: PaintBand): void;
    offscreenSettled(submitted: boolean): void;
    drawGpu(pass: GpuPass, view: ViewState, band: PaintBand): void;
    coverage(view: ViewState): { complete: boolean; sharp: boolean; staleVersion?: boolean };
    inkComposed(view: ViewState, ids: ReadonlySet<string>): Set<string>;
    drawnInkNodeIds(): ReadonlySet<string>;
    drawnLiveNodeIds(band: PaintBand): ReadonlySet<string>;
    drewNothing(band: PaintBand): boolean;
    plannedLiveNodeIds(band: PaintBand): ReadonlySet<string>;
    mandatoryBytes(width: number, height: number): number;
    holding(): boolean;
    incomplete(): boolean;
    needsFrame(): boolean;
    memoryBlocked(): boolean;
    memory(): { gpuBytes: number; cpuBytes: number };
    release(reason: GpuReleaseReason): void;
    noteEvicted(): void;
    liveEviction(): LiveEviction;
    contentKey(): number;
    listInvalid(view: ViewState): boolean;
    dispose(): void;
}

const LIVE_OVERLAY_MAX_PARTS = 256;
const ZOOM_DIRECT_MAX_PARTS = 512;
/** The most items one GPU route run holds. A route admits a run whole or defers it, and a deferred run starts again from its first item
 * the next frame; a slice resumes run by run (admitSlice). Unbounded, one tile of the 10,000-stroke old board at its whole-board view
 * was a single union-ink run of ~5,000 strokes whose admission never fit one frame: it deferred at every vsync for good (measured,
 * WebGL2 with the CPU throttled 3x: 5,036 stroke admissions and one deferral per frame). The CPU route rasters a run as one scrap, so
 * its runs are not split. */
const RUN_MAX_ITEMS = 256;
const LIVE_FILL_MAX_PARTS = 512;
const HOLE_HOLD_MS = 250;
const FLOOR_VIEWS = 3;
const FLOOR_MAX_PARTS = 2048;
const FLOOR_PIXELS = 2 * EDGE;
const RING_MAX_TILES = 8;
/** The tiles each side of the view the ring holds: one while zooming, at rest a viewport each side (bounded). The compose pass and the
 * still-wanted test use the same margin: the test kept one tile, so every ring position past it was cancelled each frame and begun
 * again (measured, dark notebook at 332%, DPR 2: 64 positions cancelled, begun and refused per frame at rest, 60 frames a second). */
function ringMargin(span: Span, zooming: boolean): number {
    return zooming ? 1 : Math.min(RING_MAX_TILES, Math.max(1, span.x1 - span.x0, span.y1 - span.y0));
}
function isLivePart(item: PaintItem): boolean {
    return item.kind === 'image' && item.blend !== 'multiply' && item.imageKey.startsWith(VIDEO_FRAME_PREFIX);
}
function windowsHaveLive(prepared: PreparedPaint2d): boolean {
    for (const win of prepared.windows) for (const item of win.items) if (isLivePart(item)) return true;
    return false;
}
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
const PENDING_REGION_LIMIT = 64;
function overlapsRect(a: Readonly<Rect>, b: Readonly<Rect>): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function surfacePixels(view: ViewState, world: Readonly<Rect>): Rect {
    const cam = view.camera, scale = cam.z * view.viewport.dpr;
    const left = Math.floor((world.x - cam.x) * scale), top = Math.floor((world.y - cam.y) * scale);
    const right = Math.ceil((world.x + world.width - cam.x) * scale), bottom = Math.ceil((world.y + world.height - cam.y) * scale);
    return { x: left, y: top, width: right - left, height: bottom - top };
}
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
    const slots = new WeakMap<TileEntry, Slot>();
    const inexactPending = new Set<TileEntry>();
    const awaitingDecode = new Map<TileEntry, readonly string[]>();
    const screenScratch: Rect = { x: 0, y: 0, width: 0, height: 0 };
    const building = new TileKeyMap<Position>();
    const staleScratch: Position[] = [];
    const scaleIndexes = new Map<number, number>();
    const scaleIndexOf = (scale: number): number => {
        let index = scaleIndexes.get(scale);
        if (index === undefined) { index = scaleIndexes.size; scaleIndexes.set(scale, index); }
        return index;
    };
    let finished: Position[] = [];
    const draws: Draw[] = [];
    const drawnInk = new Set<string>();
    let drawnInkFrame = -1;
    const liveInkDropped = new Set<string>();
    const drawnLive: Record<PaintBand, Set<string>> = { underlay: new Set<string>(), content: new Set<string>() };
    const plannedLive: Record<PaintBand, Set<string>> = { underlay: new Set<string>(), content: new Set<string>() };
    const drewAny: Record<PaintBand, boolean> = { underlay: false, content: false };
    const liveRuns: LiveAdmission[] = [];
    const liveAdmitted = new Map<PaintItem, LiveAdmission | null>();
    const liveDeferredBy = new Map<PaintItem, string>();
    let liveDeferredNow = false, liveDeferredFrames = 0;
    let liveAdmittedNow = 0, liveAdmittedBest = 0;
    let liveMissed = false;
    let frameHoles = 0, frameRegressions = 0, holeCause = '';
    let drawRefusedNow = false;
    let holdSince = -1, holdFrame = -1, holdNow = false, holdRefused = false;
    let refusedBefore = false;
    const shownWorld: Rect = { x: 0, y: 0, width: 0, height: 0 };
    let shownValid = false, shownFrame = -1, fillParts = 0, missingCounted = -1;
    let floorScale = 0, floorSpan: Span | null = null;
    const floorChecked = { scale: 0, x0: 0, y0: 0, x1: 0, y1: 0, revision: -1 };
    let curHoles: Rect[] = [], lastHoles: Rect[] = [];
    const liveScratch: { order: number; run: PreparedRun; route: ItemRoute; nodeId: string; item: object; pieces?: readonly Rect[] }[] = [];
    const standScratch: { order: number; entry: TileEntry; slot: Slot; clip: Rect }[] = [];
    const quadPool: { sourceRect: Rect; destRect: Rect }[] = [];
    const quadList: TexturedQuadSpec[] = [];
    let drawCount = 0;
    let drawsEpoch = -1, evictEpoch = 0, drawsFrame = -1;
    const drawsCam = { x: NaN, y: NaN, z: NaN, w: NaN, h: NaN, dpr: NaN };
    let wantFrame = false;
    // The store keys of the tiles this frame's encode composed, until the frame is settled (offscreenSettled). A tile is marked
    // composed when its pass is recorded; a frame discarded after that (its uniform ring refused a critical draw, another layer threw)
    // never wrote the target, and the position would draw that target's old or uncleared pixels for good.
    let composedUnsettled: TileKey[] = [];
    const listUsable = (view: ViewState): boolean => drawsFrame === frame || (drawsEpoch === evictEpoch && drawsCam.x === view.camera.x &&
        drawsCam.y === view.camera.y && drawsCam.z === view.camera.z && drawsCam.w === view.viewport.width &&
        drawsCam.h === view.viewport.height && drawsCam.dpr === view.viewport.dpr);

    let disposed = false, presenting = false, indexing = false;
    let zoomingFrame = false, panned = false;
    let editBits = 0;
    const EDIT_SUPERSEDED = 1, EDIT_EMPTY = 2, EDIT_CANCEL = 4, EDIT_FREE = 8, EDIT_DONE = 16, EDIT_SCALES = 32, EDIT_INVALID = 64;
    let contentVersion = 0;
    const editEvent = (bit: number): void => { editBits |= bit; };
    const entryGen = new WeakMap<TileEntry, number>();
    let genCounter = 0;
    let drawSignature = 0;
    let zoomSpan: Span | null = null;
    let routesEncodedFrame = -1;
    const omitTracker = new OmitTracker();
    let denied = false, settled = false, preparedSharp = true;
    let waiting = false;
    let blockedOnGpu = false;
    let roomForPosition = false;
    let retryAt = 0;
    let retryDelay = GPU_RETRY_MS, retryMisses = 0;
    let paintScanned: PreparedPaint2d | null = null, paintHasLive = false, paintLiveOnly = false;
    let liveNow = false;
    let directBefore = false, settling = false, settleRepeat = false;
    let exactAtX = Number.NaN, exactAtY = Number.NaN, exactAtZ = Number.NaN, quietSwitch = false, invalidatedNow = false;
    let liveInexact = false, settleInexact = false;
    let liveStale = false;
    let settleCamX = Number.NaN, settleCamY = Number.NaN, settleCamZ = Number.NaN;
    let device: GfxDevice | null = null;
    let frame = 0, validRevision = 0;
    let omitIds: ReadonlySet<string> | null = null;
    const heldNodes = new Map<string, number>();
    const pendingRegions: Rect[] = [];
    const coveredPositions = new Set<number>();
    const uncoveredPositions = new Set<number>();
    let lastCovered = new Set<number>(), spareCovered = new Set<number>();
    let coverSignature = 0;
    let swappedTiles = new Map<number, number>(), spareSwapped = new Map<number, number>();
    let liveRefusedSerial = 0, liveRefusedSigned = 0;
    let foregroundFrame = -1;
    let fTarget = 0, fZooming = false;
    let fSpan: Span = { x0: 0, y0: 0, x1: 0, y1: 0 };
    let frameComposed = 0;
    const frameDirtyCovered = new Set<number>();
    let isolationNeed: IsolationReservation | null = null;
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
    const composedAt = new WeakMap<TileEntry, number>();
    let lastZoom: number | undefined;
    let pinsHeld = false;
    let drawnTarget = 0;
    let drawnCamX = 0, drawnCamY = 0, drawnCamZ = 1;

    const wake = (): void => {
        for (const position of building.values()) position.parked = false;
        waiting = false; blockedOnGpu = false; roomForPosition = false;
        if (retryAt !== 0) { retryAt = 0; host.wakeAt(null); }
        host.invalidate('tile-composer-capacity');
    };
    const releaseOrphanWait = (): void => {
        if (!waiting || !roomForPosition) return;
        for (const position of building.values()) if (position.parked) return;
        waiting = false; blockedOnGpu = false; roomForPosition = false;
        auditCount(audit, 'compose:wait:orphaned');
    };
    const armRetry = (): void => {
        const now = performance.now();
        if (!waiting || retryAt > now) return;
        if (++retryMisses > GPU_RETRY_LIMIT) { auditCount(audit, 'compose:retry:stopped'); return; }
        retryAt = now + retryDelay;
        retryDelay = Math.min(retryDelay * 2, GPU_RETRY_MAX_MS);
        host.wakeAt(retryAt);
    };
    let visibleWait = 0, liveWait = 0, liveWaitFrame = -1;
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

    const pieceOnSurface = (view: ViewState, world: Readonly<Rect>, within: Readonly<Rect>): Rect | null => {
        const cam = view.camera, scale = cam.z * view.viewport.dpr;
        const left = Math.max(within.x, Math.round((world.x - cam.x) * scale)), top = Math.max(within.y, Math.round((world.y - cam.y) * scale));
        const right = Math.min(within.x + within.width, Math.round((world.x + world.width - cam.x) * scale));
        const bottom = Math.min(within.y + within.height, Math.round((world.y + world.height - cam.y) * scale));
        return right <= left || bottom <= top ? null : { x: left, y: top, width: right - left, height: bottom - top };
    };
    let pictureRemaining: Rect[] = [];
    const standInPicture = (view: ViewState, band: PaintBand, scale: number, x: number, y: number, clip: Readonly<Rect>): boolean => {
        standScratch.length = 0;
        const world = tileWorld(keyOf(band, scale, x, y, 0));
        const list = store.standIns(band, world, scale, true);
        if (!list.length) { pictureRemaining = [world]; return false; }
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

    const exactUnder = (band: PaintBand, scale: number, entry: TileEntry, span: Span): boolean => {
        const world = tileWorld(entry.key);
        const x0 = Math.max(span.x0, Math.floor(world.x * scale / EDGE)), x1 = Math.min(span.x1, Math.ceil((world.x + world.width) * scale / EDGE));
        const y0 = Math.max(span.y0, Math.floor(world.y * scale / EDGE)), y1 = Math.min(span.y1, Math.ceil((world.y + world.height) * scale / EDGE));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            if (statusAt(band, scale, x, y) !== 'ok' && !finishedAt(band, scale, x, y)) return false;
        }
        return true;
    };
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

    const exactRun = (route: ItemRoute, run: PreparedRun): boolean =>
        route === routes.text ? routes.text.exact(run) : route === routes.path && routes.path.exact ? routes.path.exact(run)
            : route === routes.inkUnion && routes.inkUnion.exact ? routes.inkUnion.exact(run) : true;
    const isGeometryRoute = (route: ItemRoute): boolean => route === routes.path || route === routes.inkAnalytic || route === routes.inkUnion;
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
            const clips = item.clips.length && route !== routes.path && route !== routes.cpu ? item.clips : null;
            const last = runs[runs.length - 1];
            if (last && last.route === route && last.why === why && !last.clips && !clips &&
                (route === routes.cpu || last.items.length < RUN_MAX_ITEMS)) last.items.push(item);
            else runs.push({ items: [item], route, clips, prepared: null, why, label: null, counted: false });
        }
        return runs;
    };
    const countFallback = (run: Run): void => {
        if (run.counted || run.why === null) return;
        run.counted = true;
        auditCount(audit, `fallback:item-cpu:${run.label ?? kindOf(run.items)}:${run.why}`, 1, { px: SIZE * SIZE });
    };
    const toCpu = (run: Run, why: string, label: string | null): void => {
        run.prepared?.retire();
        run.route.abandon?.(run.items);
        run.prepared = null; run.clips = null;
        run.route = routes.cpu; run.why = why; run.label = label;
    };

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
                toCpu(run, outcome.why, null);
                outcome = run.route.admit(run.items, slice.view, slice.blend, budget);
            }
            switch (outcome.status) {
                case 'ready':
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
            const existing = entryOfKey(key);
            return {
                key, mode, blend: mode === 'modulate' ? 'modulate' : 'over', view: tile, runs: runsOf(group.parts),
                next: 0, admitted: [], entry: existing && existing.target ? existing : null, inkNodes: inkNodesOf(group.parts),
                firstOrder: group.parts[0].order,
            };
        });
        return { band, scale, x, y, slices, cursor: 0, parked: false, lowered: false, key: positionKey(band, scale, x, y), live, drivenFrame: -1, deniedGpu: 0 };
    };

    const advance = (position: Position, budget: FrameBudget, gpu: GfxDevice, prefetch = false): 'done' | 'wait' | 'denied' | 'refused' => {
        position.deniedGpu = 0;
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

    let freeOwnEmptyFrame = -1;
    const freeOwn = (view: ViewState, target: number, asking: Position): boolean => {
        if (freeOwnEmptyFrame === frame) return false;
        editEvent(EDIT_FREE);
        if (store.evict(FREE_FOR_REFUSAL, -1, view) > 0) return true;
        if ((options.reclaimRoutes?.(FREE_FOR_REFUSAL, frame) ?? 0) > 0) { auditCount(audit, 'compose:free-own:routes'); return true; }
        if (liveRuns.length) {
            retireLive();
            if ((options.reclaimRoutes?.(FREE_FOR_REFUSAL, frame) ?? 0) > 0) { auditCount(audit, 'compose:free-own:live'); return true; }
        }
        for (const position of building.values()) if (position.lowered && position !== asking) { cancel(position); building.delete(position.key); }
        for (const band of BANDS) store.dropScalesExcept(target, band, floorScale, drawsFrame >= 0 ? drawsFrame : Infinity);
        const freed = store.evict(FREE_FOR_REFUSAL, -1, view) > 0;
        if (freed) auditCount(audit, 'compose:free-own:scales');
        else freeOwnEmptyFrame = frame;
        return freed;
    };

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
        const merged: Run[] = [];
        for (const run of slice.runs) {
            const last = merged[merged.length - 1];
            if (last && last.route === routes.cpu && run.route === routes.cpu && last.why === run.why && !last.clips && !run.clips) last.items.push(...run.items);
            else merged.push(run);
        }
        slice.runs.length = 0; slice.runs.push(...merged);
        return true;
    };
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
    const exactFinishedAt = (band: PaintBand, target: number, x: number, y: number): boolean => {
        for (const position of finished) if (!position.lowered && position.band === band && position.scale === target && position.x === x && position.y === y) return true;
        return false;
    };
    const loweredScratch: Position[] = [];

    let composeCut = false;
    const composePasses = (view: ViewState, budget: FrameBudget, gpu: GfxDevice, target: number, span: Span, only: 'foreground' | 'background' | 'all'): void => {
        let limit = view.moving ? 2 : 8;
        if (options.slowGpu?.()) limit = Math.max(1, limit >> 1);
        const drive = (position: Position, key: number, pass: 'held' | 'dirty' | 'missing' | 'ring' | 'floor'): boolean => {
            const prefetch = pass === 'ring' || pass === 'floor';
            if (position.parked) { if (waiting) position.drivenFrame = frame; return true; }
            if (waiting && blockedOnGpu && roomForPosition && pass !== 'dirty' && pass !== 'held') { position.drivenFrame = frame; auditCount(audit, `compose:room-wait:${pass}`); return true; }
            position.drivenFrame = frame;
            if (only !== 'foreground' && frameComposed >= limit) { auditCount(audit, `compose:limit:${pass}`); return false; }
            if (budget.shouldYield()) { auditCount(audit, `compose:yield:${pass}`); return false; }
            let outcome = advance(position, budget, gpu, prefetch);
            if ((outcome === 'refused' || (outcome === 'denied' && blockedOnGpu)) && !prefetch && !zoomingFrame) {
                if (pendingRegions.length) { auditCount(audit, 'live:region:dropped-memory', pendingRegions.length); pendingRegions.length = 0; }
                if (building.size > 1) {
                    staleScratch.length = 0;
                    for (const other of building.values()) if (other !== position) staleScratch.push(other);
                    for (const other of staleScratch) { cancel(other); building.delete(other.key); }
                    auditCount(audit, 'compose:cancel-others', staleScratch.length);
                    staleScratch.length = 0;
                }
                for (let rounds = 0; (outcome === 'refused' || (outcome === 'denied' && blockedOnGpu)) && rounds < FREE_RETRY_ROUNDS && freeOwn(view, target, position); rounds++) {
                    auditCount(audit, `compose:free-retry:${pass}`);
                    outcome = advance(position, budget, gpu);
                }
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
                const low = lowerTileKey(keyOf(position.band, position.scale, position.x, position.y, 0));
                const lowKey = positionKey(low.band, low.scale, low.x, low.y);
                if (!building.has(lowKey) && statusAt(low.band, low.scale, low.x, low.y) === 'ok') {
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
            if (outcome === 'refused') { refuseTarget(); position.parked = true; if (!prefetch) armRetry(); auditCount(audit, `compose:refused:${pass}`); return false; }
            if (outcome === 'denied') { position.parked = true; if (!prefetch) armRetry(); auditCount(audit, `compose:denied:${pass}`); return false; }
            auditCount(audit, `compose:wait:${pass}`);
            return false;
        };
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
        if (building.size) {
            for (const position of building.values()) if (position.lowered) loweredScratch.push(position);
            for (const position of loweredScratch) {
                if (building.get(position.key) !== position) continue;
                if (!drive(position, position.key, 'missing')) { loweredScratch.length = 0; composeCut = true; return; }
            }
            loweredScratch.length = 0;
        }
        const composeFloor = (): boolean => {
            if (!floorSpan) return true;
            for (const band of BANDS) {
                for (let y = floorSpan.y0; y < floorSpan.y1; y++) {
                    for (let x = floorSpan.x0; x < floorSpan.x1; x++) {
                        const key = positionKey(band, floorScale, x, y);
                        let position = building.get(key);
                        if (!position) {
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
                            if (frameDirtyCovered.size >= DIRTY_COVERED_PER_FRAME) { auditCount(audit, 'compose:dirty-covered-deferred'); continue; }
                            frameDirtyCovered.add(key);
                        }
                        if (!position) {
                            const status = statusAt(band, target, x, y);
                            if (pass === 'dirty' ? status !== 'dirty' : status !== 'missing') continue;
                            if (pass !== 'dirty' && waiting && blockedOnGpu && roomForPosition) continue;
                            if (finishedAt(band, target, x, y)) { auditCount(audit, 'compose:finished-this-frame'); continue; }
                            if (only === 'foreground' && pass === 'missing' && standInsOf(band, target, x, y).length) continue;
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
            if (pass === 'ring' && (zoomingFrame || only === 'foreground')) continue;
            if (pass !== 'ring') { if (!sweep(pass, 0)) { composeCut = true; return; } continue; }
            const margin = ringMargin(span, zoomingFrame);
            if (!sweep(pass, Math.min(1, margin)) || !composeFloor() || !sweep(pass, margin)) { composeCut = true; return; }
        }
    };
    const compose = (view: ViewState, budget: FrameBudget, gpu: GfxDevice, target: number, span: Span, only: 'foreground' | 'background' | 'all'): void => {
        composeCut = false;
        releaseOrphanWait();
        composePasses(view, budget, gpu, target, span, only);
        if (renderAuditEnabled() && !composeCut && only !== 'foreground' && !zoomingFrame) {
            let orphans = 0;
            for (const position of building.values()) if (position.drivenFrame !== frame) orphans++;
            if (orphans) auditCount(audit, 'building:orphan', orphans);
        }
    };

    const encodeDraw: { pass: GpuPass | null; route: ItemRoute | null; run: PreparedRun | null } = { pass: null, route: null, run: null };
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
        const tx = EDGE / w, ty = EDGE / h;
        spec.destRect.x = dx0; spec.destRect.y = dy0; spec.destRect.width = dx1 - dx0; spec.destRect.height = dy1 - dy0;
        spec.sourceRect.x = GUTTER + (dx0 - x0) * tx; spec.sourceRect.y = GUTTER + (dy0 - y0) * ty;
        spec.sourceRect.width = (dx1 - dx0) * tx; spec.sourceRect.height = (dy1 - dy0) * ty;
        return true;
    };
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

    const retireLive = (): void => {
        for (const live of liveRuns) live.route.retire(live.run);
        liveRuns.length = 0;
        liveAdmitted.clear(); liveDeferredBy.clear();
    };

    const admitLive = (item: PaintItem, blend: Blend, view: ViewState, budget: FrameBudget): LiveAdmission | null => {
        const known = liveAdmitted.get(item);
        if (known !== undefined && (known !== null || budget.phase !== 'background' || liveDeferredBy.get(item) !== 'foreground')) return known;
        let admitted: LiveAdmission | null = null;
        const route = isLivePart(item) ? routes.image : routeOf(item).route;
        // The CPU route rasters a tile-sized scratch at the camera origin: it cannot draw a live part over the surface.
        if (!route || route === routes.cpu) { auditCount(audit, route ? 'live:dropped:cpu-route' : 'live:dropped:route-absent'); }
        else {
            let outcome = route.admit([item], view, blend, budget);
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
                liveDeferredNow = true; liveDeferredBy.set(item, budget.phase); auditCount(audit, 'live:dropped:deferred'); auditCount(audit, `live:dropped:deferred:${route.id}`); auditCount(audit, `live:dropped:deferred:${budget.phase}`);
            } else if (outcome.status === 'denied') {
                refuseAdmission(outcome.pool, outcome.bytes, true); auditCount(audit, 'live:dropped:denied');
            }
        }
        liveAdmitted.set(item, admitted);
        return admitted;
    };

    const heldLive = (nodeId: string, stand: readonly { readonly entry: TileEntry }[]): boolean => {
        const since = heldNodes.get(nodeId);
        if (since === undefined) return false;
        for (const { entry } of stand) if ((composedAt.get(entry) ?? -1) >= since) return false;
        return true;
    };

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
    const pendingRegionsIn = (band: PaintBand, target: number, x: number, y: number): readonly Rect[] => {
        const interior = tileWorld(keyOf(band, target, x, y, 0));
        const found = pendingRegions.filter(region => overlapsRect(region, interior));
        return found.length ? found : NO_REGIONS;
    };
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
    const addPieces = (band: PaintBand, entry: TileEntry, slot: Pick<Slot, 'mode' | 'inkNodes'>, clip: Rect | null,
        cut: readonly Rect[]): void => {
        if (!clip) return;
        for (const piece of subtractRects(clip, cut)) addDraw(band, entry, slot, piece);
        auditCount(audit, 'live:region:tile-cut');
    };
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
    const collectLive = (band: PaintBand, target: number, x: number, y: number, view: ViewState, budget: FrameBudget,
        wanted: boolean, stand: readonly { readonly entry: TileEntry }[] | null): void => {
        liveScratch.length = 0;
        if (!wanted && !(stand && heldNodes.size)) return;
        const interior = tileWorld(keyOf(band, target, x, y, 0));
        const pad = GUTTER / target;
        const gutter: Rect = { x: interior.x - pad, y: interior.y - pad, width: interior.width + 2 * pad, height: interior.height + 2 * pad };
        for (const part of parts.partsFor(band, gutter, omitIds ?? undefined)) {
            const video = isLivePart(part.item);
            if (video ? !wanted : !(stand && heldLive(part.nodeId, stand))) continue;
            const admitted = admitLive(part.item, part.blend, view, budget);
            if (admitted) liveScratch.push({ order: part.order, run: admitted.run, route: admitted.route, nodeId: part.nodeId, item: part.item });
        }
    };

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

    const liveBefore = (band: PaintBand, order: number, from: number, clip: Rect | null): number => {
        let li = from;
        for (; li < liveScratch.length && liveScratch[li].order < order; li++) {
            const live = liveScratch[li];
            if (live.pieces) { for (const piece of live.pieces) addLiveDraw(band, live.run, live.route, piece, live.nodeId, live.item); }
            else if (clip) addLiveDraw(band, live.run, live.route, clip, live.nodeId, live.item);
        }
        return li;
    };

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
    const noteHole = (band: PaintBand, target: number, x: number, y: number, cause: string): void => {
        frameHoles++; frameRegressions++; holeCause = cause;
        auditDrawn('hole', 1, 'geometry', `${audit}-tile-${band}-${cause}`);
        auditCount(audit, `hole:${cause}`);
    };

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
    const viewWorld: Rect = { x: 0, y: 0, width: 0, height: 0 };
    const viewClip: Rect = { x: 0, y: 0, width: 0, height: 0 };
    const collectLiveIn = (band: PaintBand, world: Readonly<Rect>, view: ViewState, budget: FrameBudget): void => {
        liveScratch.length = 0;
        for (const part of parts.partsFor(band, world, omitIds ?? undefined)) {
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
            auditCount(audit, 'live:fallback:tiles');
            drawCount = 0; plannedLive.underlay.clear(); plannedLive.content.clear();
            zooming = true;
        }
        const span = spanAt(view, target);
        const clipAt = (x: number, y: number): Rect | null => clipOnSurface(view, target, x, y);
        for (const band of BANDS) {
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
                    const pending = status === 'missing' ? finishedAt(band, target, x, y) : null;
                    if (pending) {
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
                    let pictured = false, exact = status !== 'missing' && (zooming || complete);
                    if (status !== 'missing' && !exact) exact = !at || !(pictured = standInPicture(view, band, target, x, y, at));
                    if (exact) {
                        const first = entryAt(band, target, x, y, 0);
                        const slot0 = first ? slots.get(first) : undefined;
                        const count = slot0?.count ?? 0;
                        const withLive = (slot0?.live ?? 0) > 0;
                        collectLive(band, target, x, y, view, budget, withLive, null);
                        const regions = status === 'dirty' ? pendingRegionsIn(band, target, x, y) : NO_REGIONS;
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
                        const bare = pictureRemaining;
                        const wasShown = shownValid && bare.some(piece => overlapsRect(piece, shownWorld) && !lastHoles.some(hole => covers(hole, piece)));
                        if ((wasShown || zooming || panned || liveNow) && fillLive(band, target, x, y, view, budget, clip)) continue;
                        if (!standScratch.length && (wasShown || zooming || panned || liveNow)) fillLive(band, target, x, y, view, budget, clip, true);
                        if (wasShown) noteHole(band, target, x, y, standScratch.length ? 'partial' : 'none');
                        else { frameHoles++; auditDrawn('hole', 1, 'geometry', `${audit}-tile-${band}-unshown`); auditCount(audit, zooming || panned || liveNow ? 'hole:revealed' : 'hole:loading'); }
                        for (const piece of bare) curHoles.push(piece);
                    }
                    standScratch.sort((a, b) => a.order - b.order);
                    collectLive(band, target, x, y, view, budget, paintHasLive, standScratch);
                    let li = 0;
                    for (const item of standScratch) {
                        li = liveBefore(band, item.order, li, clip);
                        addDraw(band, item.entry, item.slot, item.clip);
                    }
                    liveBefore(band, Infinity, li, clip);
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

    const allExact = (view: ViewState, exact: number): boolean => {
        const span = spanAt(view, exact);
        for (const band of BANDS) {
            for (let y = span.y0; y < span.y1; y++) {
                for (let x = span.x0; x < span.x1; x++) if (statusAt(band, exact, x, y) !== 'ok') return false;
            }
        }
        return true;
    };

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
                        const t0 = audited ? performance.now() : 0;
                        encodeDraw.pass = pass; encodeDraw.route = route; encodeDraw.run = run;
                        if (clips) withPreparedClips(pass, clips, drawEncoded);
                        else drawEncoded();
                        if (audited) auditStage(audit, 'draw', performance.now() - t0);
                        auditCount(audit, `route:${route.id}`);
                    }
                } catch (error) {
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
        resourcesSeen = null; paintScanned = null;
    };

    return {
        warm(prepared: PreparedPaint2d, maxMs: number): boolean {
            if (disposed) return false;
            const deadline = performance.now() + maxMs;
            const budget = { shouldYield: () => performance.now() >= deadline } as Pick<FrameBudget, 'shouldYield'> as FrameBudget;
            let done = false;
            while (!done && performance.now() < deadline) done = parts.sync(prepared, budget);
            return done;
        },
        prepare(view: ViewState, budget: FrameBudget, prepared: PreparedPaint2d | null, omit?: ReadonlySet<string>): boolean {
            if (disposed) return true;
            evictEpoch++; wantFrame = false;
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
            if (!building.size) scaleIndexes.clear();
            else if (scaleIndexes.size >= 60) {
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
            if (prepared.resources !== resourcesSeen) {
                resourcesSeen = prepared.resources;
                for (const route of routeList) (route as ItemRoute & ResourcedRoute).useResources?.(prepared.resources);
            }
            zooming = lastZoom !== undefined && view.camera.z !== lastZoom;
            lastZoom = view.camera.z;
            if (pins) {
                if (zooming) {
                    const world: Rect = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
                    const ids = new Set<string>();
                    for (const band of BANDS) for (const part of parts.partsFor(band, world, omitIds ?? undefined)) ids.add(part.nodeId);
                    pins.pinVisible(ids);
                    pinsHeld = true;
                } else if (pinsHeld) { pins.releasePins(); pinsHeld = false; }
            }
            zoomingFrame = zooming;
            if (zooming) { auditCount(audit, 'zoom:prepare'); auditTape(`${audit}:zoom:prepare`); }
            routes.text?.setZoom(zooming);
            routes.path.setZoom?.(zooming);
            screenScratch.x = view.camera.x; screenScratch.y = view.camera.y;
            screenScratch.width = view.viewport.width / view.camera.z; screenScratch.height = view.viewport.height / view.camera.z;
            routes.image?.setScreen?.(screenScratch);
            routes.image?.pump?.(budget);
            const exact = exactScale(demand);
            target = exact;
            zoomSpan = zooming ? spanAt(view, target) : null;
            panned = !zooming && (view.camera.x !== drawnCamX || view.camera.y !== drawnCamY);
            drawnCamX = view.camera.x; drawnCamY = view.camera.y; drawnCamZ = view.camera.z;

            indexing = !parts.sync(prepared, budget);
            const panning = panned && options.liveOverlay !== true && !omitIds?.size && !indexing && anyVisibleMissing(view, target);
            const exactBefore = exactAtX === view.camera.x && exactAtY === view.camera.y && exactAtZ === view.camera.z;
            quietSwitch = options.liveMatchesTiles === true && directBefore && exactBefore && !zooming && !panned;
            const inputSwitch = !quietSwitch && directBefore && exactBefore && !zooming && !panned && options.inputActive?.() === true;
            if (inputSwitch) auditCount(audit, 'settle:switch:input');
            settling = !zooming && !panned && directBefore && !quietSwitch && !inputSwitch && options.liveOverlay !== true && !omitIds?.size && !indexing;
            liveNow = paintLiveOnly || (!indexing && (zooming || panning || settling) && zoomDirectOk(view, target));
            settling &&= liveNow;
            settleRepeat = settling && settleCamX === view.camera.x && settleCamY === view.camera.y && settleCamZ === view.camera.z;
            settleInexact = settleRepeat && liveInexact;
            if (settleInexact) { settleRepeat = false; auditCount(audit, 'settle:fresh:inexact'); }
            liveInexact = false;
            if (settleRepeat && liveStale) { settleRepeat = false; auditCount(audit, 'settle:fresh:image-waits'); }
            liveStale = false;
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
            if (panned) auditCount(audit, indexing ? 'pan:skip:indexing' : !panning ? 'pan:skip:complete' : liveNow ? 'pan:live' : 'pan:skip:parts');
            if (liveNow && !paintLiveOnly) auditCount(audit, 'zoom:direct:frame');
            if (liveNow && device) admitLiveFirst(view, budget);
            if (liveInexact) host.invalidate('live-inexact');
            if (zooming && !liveNow) auditCount(audit, indexing ? 'zoom:direct:skip:indexing' : 'zoom:direct:skip:parts');
            if (!indexing) {
                let invalidated = false;
                const changes = parts.takeChanges();
                if (changes === 'all') { store.markDirty('all'); invalidated = true; if (settleRepeat) auditCount(audit, 'settle:fresh:all'); settleRepeat = false; }
                else if (changes.length) {
                    for (const rect of changes) store.markDirty(rect);
                    invalidated = true;
                    if (settling) {
                        const world: Rect = { x: view.camera.x, y: view.camera.y, width: view.viewport.width / view.camera.z, height: view.viewport.height / view.camera.z };
                        for (const rect of changes) if (overlapsRect(rect, world)) {
                            if (settleRepeat) auditCount(audit, 'settle:fresh:visible-change');
                            settleRepeat = false; break;
                        }
                    }
                }
                if (changes === 'all') pendingRegions.length = 0;
                else for (const rect of changes) pendingRegions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
                if (pendingRegions.length > PENDING_REGION_LIMIT) {
                    auditCount(audit, 'live:region:dropped');
                    pendingRegions.splice(0, pendingRegions.length - PENDING_REGION_LIMIT);
                }
                validRevision = prepared.root.sceneRevision;
                if (omitTracker.changed(omit)) {
                    settleRepeat = false;
                    const nextOmit = omit && omit.size ? omit : null;
                    const diff = new Set<string>();
                    for (const id of omitIds ?? []) if (!nextOmit?.has(id)) diff.add(id);
                    for (const id of nextOmit ?? []) if (!omitIds?.has(id)) diff.add(id);
                    for (const rect of parts.boundsOfNodes(diff)) {
                        store.markDirty(rect);
                        pendingRegions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
                    }
                    if (pendingRegions.length > PENDING_REGION_LIMIT) {
                        auditCount(audit, 'live:region:dropped');
                        pendingRegions.splice(0, pendingRegions.length - PENDING_REGION_LIMIT);
                    }
                    for (const id of omitIds ?? []) if (!nextOmit?.has(id)) heldNodes.set(id, frame);
                    omitIds = nextOmit ? new Set(nextOmit) : null;
                    invalidated = true;
                }
                if (invalidated) { editEvent(EDIT_INVALID); invalidatedNow = true; }
                const span = spanAt(view, target);
                const margin = ringMargin(span, zooming);
                const ring: Span = { x0: span.x0 - margin, y0: span.y0 - margin, x1: span.x1 + margin, y1: span.y1 + margin };
                if (!zooming && !panned && !liveNow) {
                    const cam = view.camera, w = view.viewport.width / cam.z, h = view.viewport.height / cam.z;
                    const region: Rect = { x: cam.x - FLOOR_VIEWS * w, y: cam.y - FLOOR_VIEWS * h, width: (2 * FLOOR_VIEWS + 1) * w, height: (2 * FLOOR_VIEWS + 1) * h };
                    const scale = 2 ** Math.floor(Math.log2(FLOOR_PIXELS / Math.max(region.width, region.height)));
                    if (Number.isFinite(scale) && scale > 0 && scale <= target / 4) {
                        const at = exactScale(scale);
                        const x0 = Math.floor(region.x * at / EDGE), y0 = Math.floor(region.y * at / EDGE);
                        const x1 = Math.ceil((region.x + region.width) * at / EDGE), y1 = Math.ceil((region.y + region.height) * at / EDGE);
                        const c = floorChecked;
                        if (at !== c.scale || x0 !== c.x0 || y0 !== c.y0 || x1 !== c.x1 || y1 !== c.y1 || validRevision !== c.revision) {
                            c.scale = at; c.x0 = x0; c.y0 = y0; c.x1 = x1; c.y1 = y1; c.revision = validRevision;
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
                const kept: Position[] = [];
                for (const position of finished) {
                    if (!invalidated && stillWanted(position, target, ring, span)) kept.push(position);
                    else cancel(position);
                }
                finished = kept;
                if (!zooming && inexactPending.size) {
                    for (const entry of inexactPending) {
                        if (entry.target && entry.key.scale === target) { entry.dirty = true; auditCount(audit, 'zoom:inexact:recompose'); }
                        else auditCount(audit, 'zoom:inexact:other-scale');
                    }
                    inexactPending.clear();
                }
                if (!zooming && awaitingDecode.size && routes.image?.waiting) {
                    for (const [entry, keys] of awaitingDecode) {
                        if (!entry.target) { awaitingDecode.delete(entry); continue; }
                        if (entry.key.scale !== target) continue;
                        if (routes.image.waiting(keys)) continue;
                        awaitingDecode.delete(entry);
                        entry.dirty = true; auditCount(audit, 'image:await:recompose');
                    }
                }
                if (retryAt !== 0 && performance.now() >= retryAt) {
                    retryAt = 0; host.wakeAt(null);
                    if (waiting && blockedOnGpu) {
                        waiting = false; blockedOnGpu = false; roomForPosition = false;
                        for (const position of building.values()) position.parked = false;
                        auditCount(audit, 'compose:retry:deadline');
                    } else auditCount(audit, 'compose:retry:stale');
                }
                store.trimIdle(performance.now());
                if (!liveNow && device) admitVisibleFirst(view, target, span, budget);
                if (liveNow && !settling) {
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
            if (!indexing) {
                if (background && (!liveNow || settling) && device) compose(view, budget, device, target, frameSpan, 'background');
                for (let r = pendingRegions.length - 1; r >= 0; r--) if (!regionStillDirty(pendingRegions[r], target, frameSpan)) pendingRegions.splice(r, 1);
                for (const id of heldNodes.keys()) if (!heldStillMissing(id, target, frameSpan)) heldNodes.delete(id);
            }
            drawnTarget = target;
            buildDraws(view, target, zooming, budget);
            liveAdmittedNow = liveRuns.length;
            if (frameRegressions > 0) wantFrame = true;
            else if (!refusedBefore) holdSince = -1;
            settleVisibleWait(frameSpan);
            if (isolationNeed) reserveIsolationNeed(isolationNeed);
            const exact = allExact(view, target);
            settled = !indexing && ((liveNow && !settling) || exact || (settling && building.size === 0 && finished.length === 0 && inexactPending.size === 0));
            if (exact) { exactAtX = view.camera.x; exactAtY = view.camera.y; exactAtZ = view.camera.z; }
            else { exactAtX = Number.NaN; exactAtY = Number.NaN; exactAtZ = Number.NaN; }
            let signature = hashMix(liveNow ? 1 : 0, coverSignature);
            const afterRefusal = liveRefusedSigned !== liveRefusedSerial;
            liveRefusedSigned = liveRefusedSerial;
            for (let i = 0; i < drawCount; i++) {
                const draw = draws[i];
                const pure = draw.live && EXACT_LIVE_ROUTES.has(draw.liveRoute?.id ?? '');
                if (draw.live && !pure && !settleRepeat && !draw.cover) contentVersion++;
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
            const quiet = quietSwitch && !invalidatedNow && !settleInexact;
            if (quiet && sigChanged) auditCount(audit, 'settle:switch:quiet');
            const changed = indexing || (sigChanged && !quiet) || settleInexact || afterRefusal;
            drawSignature = signature;
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
            let dropped = 0;
            for (const key of keys) if (entryOfKey(key)) { store.remove(key); dropped++; }
            auditCount(audit, 'encode:discarded', dropped);
            wantFrame = true; host.invalidate('tile-encode-discarded');
        },
        encodeOffscreen(passes: OffscreenPasses, _view: ViewState, band: PaintBand): void {
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
                shownFrame = frame;
                const cam = view.camera;
                shownWorld.x = cam.x; shownWorld.y = cam.y; shownWorld.width = view.viewport.width / cam.z; shownWorld.height = view.viewport.height / cam.z;
                shownValid = true;
                const swapHoles = lastHoles; lastHoles = curHoles; curHoles = swapHoles; curHoles.length = 0;
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
            const dest: Rect = { x: 0, y: 0, width: 0, height: 0 };
            const scissor: RectI = { x: 0, y: 0, width: 0, height: 0 };
            const bounds: RectI = { x: 0, y: 0, width: 0, height: 0 };
            let i = 0;
            while (i < drawCount) {
                const draw = draws[i];
                if (draw.band !== band) { i++; continue; }
                drewAny[band] = true;
                if (draw.live) {
                    if (draw.clipOn) {
                        scissor.x = draw.cx; scissor.y = draw.cy; scissor.width = draw.cw; scissor.height = draw.ch;
                        const clip = pass.pushClip(scissor);
                        drawnLive[draw.band].add(draw.node);
                        if ((draw.liveRoute?.id === 'ink-analytic' || draw.liveRoute?.id === 'ink-union') && !liveInkDropped.has(draw.node)) drawnInk.add(draw.node);
                        try { draw.liveRoute?.draw(pass, draw.live); }
                        catch (error) {
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
                dest.x = (draw.x - cam.x) * scale; dest.y = (draw.y - cam.y) * scale;
                dest.width = draw.w * scale; dest.height = draw.h * scale;
                if (dest.x + dest.width <= 0 || dest.y + dest.height <= 0 || dest.x >= surfaceW || dest.y >= surfaceH) { i++; continue; }
                for (const id of draw.ink) drawnInk.add(id);
                let clip: ReturnType<GpuPass['pushClip']> | null = null;
                if (draw.clipOn) {
                    scissor.x = draw.cx; scissor.y = draw.cy; scissor.width = draw.cw; scissor.height = draw.ch;
                    clip = pass.pushClip(scissor);
                }
                let group: GroupToken | null = null;
                try {
                    if (draw.mode === 'isolated') {
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
            if (drawCount && !listUsable(view)) { wantFrame = true; return { complete: false, sharp: false }; }
            const exact = exactScale(view.camera.z * view.viewport.dpr);
            if (liveNow && !indexing && !liveMissed) return { complete: true, sharp: preparedSharp && drawnTarget === exact };
            const target = drawnTarget;
            const span = spanAt(view, target);
            let complete = frameHoles === 0 && !drawRefusedNow, sharp = !indexing && preparedSharp && target === exact, stale = indexing;
            for (const band of BANDS) {
                for (let y = span.y0; y < span.y1; y++) {
                    for (let x = span.x0; x < span.x1; x++) {
                        const status = statusAt(band, target, x, y);
                        if (status === 'ok') continue;
                        if (status === 'missing' && finishedAt(band, target, x, y)) continue;
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
            if (holdFrame !== frame || holdRefused !== drawRefusedNow) {
                holdFrame = frame; holdRefused = drawRefusedNow;
                const now = performance.now();
                if (holdSince < 0) holdSince = now;
                holdNow = now - holdSince <= HOLE_HOLD_MS;
                auditCount(audit, holdNow ? `hold:${drawRefusedNow ? 'draw-refused' : holeCause}` : 'hold:expired');
                if (!holdNow && drawRefusedNow) auditCount(audit, 'present:missing:draw-refused');
            }
            return holdNow;
        },
        needsFrame(): boolean {
            if (disposed || !presenting) return false;
            if (wantFrame) return true;
            if (liveInexact) return true;
            if (pinsHeld) return true;
            if (denied) return false;
            if (liveDeferredNow) {
                if (liveDeferredFrames < GPU_RETRY_LIMIT) return true;
                auditCount(audit, 'live:deferred:stopped');
            }
            releaseOrphanWait();
            if (waiting) return indexing || finished.length > 0;
            const wants = indexing || !settled || building.size > 0 || finished.length > 0 || inexactPending.size > 0;
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
