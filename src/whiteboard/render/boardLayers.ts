import type { Affine, Rect, ViewState } from '../../platform/types';
import type { HostBlock } from '../model/doc';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import { awaitCapacity, isBudgetRefusal } from './budgetRefusal';
import type { CompositorBackend, LayerCoverage, LayerHost } from '../../platform/render/compositor.types';
import type { ScheduledFrame } from '../../platform/render/scheduler';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer, OffscreenPasses, RenderToken } from '../../platform/render/types';
import type { PaintFrameAssembler } from './frameTypes';
import type { PaintBand } from './material';
import { inkCoverageChunks, type PaintItem, type PaintSource } from './paintStream';
import { paintItemsOf } from './paintWindows';
import type { PaintImageProvider } from './resources';
import { createCanvasPaintAdapter, type CanvasPaintAdapter, type PreparedRetain } from './reference/canvasPaintAdapter';
import { createGpuPaintAdapter } from './gpuPaintAdapter';
import { auditCount } from '../../platform/render/renderAudit';
import { createDensePaintAdapter } from './densePlan';
import { MEMORY_RETRY_MIN_MS, MemoryRetryGate } from './memoryRetryGate';
import { DensityController, type DensityMode } from './density';
import { FilteredInk, LiveNodeUnion } from './nodeSets';
import type { PresentedImage, PresentedImageLease, ViewerPaintPresentation } from './paintPresentation';

/** Both paths execute the same prepared paint; the platform alone selects/recovers the device. */
export const BOARD_BACKEND_PREFERENCE = 'auto' as const;
/** What the renderer holds for the current revision. `pending` keeps the last coherent presented pixels on screen;
 * `current` needs a presented frame of the requested revision with nothing outstanding; `failed` is a real error. */
export type PaintProgress = { readonly kind: 'current' } | { readonly kind: 'pending'; readonly reason: 'building' | 'waiting-memory'; readonly drawn: boolean }
    | { readonly kind: 'failed'; readonly message: string };
function sameProgress(a: PaintProgress, b: PaintProgress): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** The budget one layer prepares under: the frame's own budget with one unit of work always admitted. A frame's prepare
 * slice can be zero (input and presentation take the whole target), and then no layer advances: nothing wakes a stalled
 * build but the next frame, which has no time either. One unit is one bounded step, so a frame costs one step more. */
function withFirstUnit(budget: FrameBudget): FrameBudget {
    let admitted = false;
    // A plain copy, never a prototype wrapper: a nested `{ ...budget }` keeps only own fields, and an inherited frameId
    // spread away as undefined left each dense tile's item adapter stepping once and never again (frameId guard).
    return { ...budget, shouldYield: (): boolean => {
        if (!admitted) { admitted = true; return false; }
        return budget.shouldYield();
    } };
}
export interface BoardLayersOptions {
    readonly frames: PaintFrameAssembler;
    readonly images: PaintImageProvider;
    readonly onError: (error: unknown) => void;
    /** Fired once per actual change of the renderer's progress; never for a repeated value. */
    readonly onPaintProgress?: () => void;
    readonly requestedRevision: () => number;
    /** The theme the view asks for: a frame painted for the other theme is never current, whatever its revision. */
    readonly requestedTheme: () => 'light' | 'dark';
    /** View-only suppression, evaluated against the actual ready preview frame. */
    readonly omitNodes?: (frame: PaintSource) => ReadonlySet<string> | null;
    readonly liveNodeIds?: () => ReadonlySet<string> | undefined;
    readonly beforePrepare?: (view: ViewState, budget: FrameBudget) => void;
    readonly onPresented?: (revision: number, token: RenderToken, frame: PaintSource, context?: ViewerPaintPresentation) => void;
    /** Called after every prepare that reached the adapter, before a compositor frame draws what it built; a caller checks what is built. */
    readonly onPrepared?: () => void;
    /** A world offset the frame is drawn at, on top of where it was built (a translation preview's move). */
    readonly drawOffset?: (frame: PaintSource) => Readonly<{ x: number; y: number }>;
    /** Changes whenever `drawOffset` does, so the pane repaints the layer at an unchanged revision. */
    readonly drawVersion?: () => number;
    /** A draw that needs an offset the layer cannot give (a dense frame): the owner rebuilds instead. */
    readonly onOffsetUnsupported?: () => void;
    readonly onDrawn?: (revision: number, frame: PaintSource, context: ViewerPaintPresentation) => void;
    /** Upper bound on the nodes this view meets, from the sheet index; null while that index builds. */
    readonly candidates?: () => number | null;
    /** The density mode changed: the owner requests the matching kind of frame (live-only for dense). */
    readonly onDensityMode?: (mode: DensityMode) => void;
    /** A live item the current dense frame does not hold: the owner requests a frame that does. */
    readonly requestFrame?: () => void;
    /** The render audit's surface name for these layers (`<surface>-underlay`, `<surface>-content`); a preview names its own. */
    readonly auditSurface?: string;
    /** An overlay whose absence is not a view failure (a preview). Until its current frame is ready it reports complete
     * and draws nothing, and it never draws a superseded frame, so it cannot hold back the pane's other layers. */
    readonly optional?: boolean;
    /** The world rects under which the surface beneath board content is opaque (PLAN §3.3). Absent or empty: no claim,
     * so a multiply keeps today's isolation composite. Supplied per host by `opaqueWorldOf`. */
    readonly opaqueWorld?: () => readonly Rect[];
}
/** The whole plane, in world units: board coordinates are bounded by the 1e12 world limit (services.ts inverse). */
const WHOLE_PLANE: readonly Rect[] = Object.freeze([Object.freeze({ x: -1e12, y: -1e12, width: 2e12, height: 2e12 })]);
/** The opaque world of a host's board content (C1, c1-opaque.md). A whiteboard's surface beneath its content is the
 * appearance clear, opaque everywhere unless the view is inverted (the document group then starts transparent). A page
 * host's surface is opaque only where its pages are drawn: `drawnPages` is the paper's claim, readiness-gated by it. */
export function opaqueWorldOf(host: HostBlock, inverted: boolean, drawnPages?: readonly Rect[]): readonly Rect[] {
    if (host.kind === 'whiteboard') return inverted ? [] : WHOLE_PLANE;
    return drawnPages ?? [];
}
interface Estimate {
    readonly frame: PaintSource;
    // A resumable walk of the source's items in draw order: no copy of the item list is made for the estimate.
    readonly walk: Generator<PaintItem>;
    current: PaintItem | null;
    clip: number;
    chunk: number;
    arc: number;
    bytes: number;
    itemBytes: number;
    maxItemBytes: number;
    segments: number;
    items: number;
    demandPublished: boolean;
    done: boolean;
}
function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
        && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function copyView(view: ViewState): ViewState {
    return Object.freeze({ ...view, camera: Object.freeze({ ...view.camera }), viewport: Object.freeze({ ...view.viewport }) });
}
/** The view that paints a frame moved by `offset` in world units: device = (world − camera) × scale, so the world moves by
 * `offset` when the camera moves by `−offset`. Every backend paints through the camera, so no backend needs its own offset. */
function shiftedView(view: ViewState, offset: Readonly<{ x: number; y: number }>): ViewState {
    return Object.freeze({ ...view, camera: Object.freeze({ ...view.camera, x: view.camera.x - offset.x, y: view.camera.y - offset.y }) });
}
function sameView(a: ViewState | null | undefined, b: ViewState): boolean {
    return !!a && a.epoch === b.epoch && a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
        && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.viewport.dpr === b.viewport.dpr;
}
class OmittedSnapshot implements ReadonlySet<string> {
    readonly [Symbol.toStringTag] = 'OmittedSnapshot';
    private readonly valuesSet: Set<string>;
    constructor(source: ReadonlySet<string>) { this.valuesSet = new Set(source); }
    get size(): number { return this.valuesSet.size; }
    has(id: string): boolean { return this.valuesSet.has(id); }
    values(): SetIterator<string> { return this.valuesSet.values(); }
    keys(): SetIterator<string> { return this.values(); }
    entries(): SetIterator<[string, string]> { return this.valuesSet.entries(); }
    [Symbol.iterator](): SetIterator<string> { return this.values(); }
    forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
        for (const value of this.valuesSet) callback.call(thisArg, value, value, this);
    }
}
function sameTransform(a: Affine | null | undefined, b: Affine | null): boolean {
    return a === b || !!a && !!b && a.every((value, index) => value === b[index]);
}
function sameOmission(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
}
function addBytes(state: Estimate, bytes: number): void {
    const next = state.bytes + bytes;
    if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Board paint working set exceeds safe accounting');
    state.bytes = next; state.itemBytes += bytes;
}
/** One estimate unit visits one item, clip, or ink chunk; no whole-frame scan in demand(). */
function estimateStep(state: Estimate): void {
    if (!state.current) {
        const next = state.walk.next();
        if (next.done) { state.done = true; return; }
        state.current = next.value;
    }
    const item: PaintItem = state.current;
    if (state.clip < item.clips.length) {
        addBytes(state, item.clips[state.clip++].d.length * 80);
        return;
    }
    if (item.kind === 'ink') {
        const chunks = inkCoverageChunks(item.coverage);
        if (state.chunk < chunks.length) {
            const coverage = chunks[state.chunk], g = coverage.geometry;
            if (state.arc < 0) {
                const primitives = coverage.segments.length / 6 + coverage.discs.length / 3;
                state.segments += primitives;
                // Conservative provisional path estimate; exact native Path2D allocation is opaque.
                addBytes(state, coverage.segments.byteLength + coverage.discs.byteLength + coverage.centreline.byteLength
                    + coverage.radii.byteLength + g.cubics.byteLength + g.flags.byteLength + primitives * 40 * 80);
                state.arc = 0; return;
            }
            if (state.arc < coverage.arcMaps.length) {
                const map = coverage.arcMaps[state.arc++];
                addBytes(state, map.cubic.byteLength + map.pieces.byteLength); return;
            }
            state.chunk++; state.arc = -1; return;
        }
    } else if (item.kind === 'path') { addBytes(state, item.d.length * 80); state.segments += item.d.length; }
    state.items++; state.maxItemBytes = Math.max(state.maxItemBytes, state.itemBytes); state.itemBytes = 0;
    state.current = null; state.clip = 0; state.chunk = 0; state.arc = -1;
}

/** Each invocation belongs to one view; the paired layer definitions share one adapter. */
export interface BoardLayerPair extends Readonly<[PlatformLayerDefinition, PlatformLayerDefinition]> {
    invalidate(reason?: string): void;
    /** Each band's LayerHost deadline; the scheduler's coalesced wake only invalidates, it never draws. */
    wakeAt(deadlineMs: number | null): void;
    readyFrame(): PaintSource | null;
    /** The renderer's progress for the requested revision, read live. */
    paintProgress(): PaintProgress;
    /** The canonical CPU allocator of the bound layer host, or null before the first host has drawn. */
    memory(): MemoryAllocator | null;
}
/** The composer's offscreen encode (PLAN §3.3, wave 2). Today's adapter has none, so the layer's call is guarded: a no-op. */
type OffscreenEncoder = { encodeOffscreen?(passes: OffscreenPasses, view: ViewState, band: PaintBand): void };
/** The layer's GPU eviction hook (`Layer.evictGpu` on impl/gpu) and the adapter's method behind it (h2). Typeof-guarded
 * until impl/gpu merges: an absent method frees nothing. */
type GpuEvicting = { evictGpu?(bytes: number, frameId: number): number };
type LayerEvicting = { evictGpu?(bytes: number, frameId: number): number };
/** The grain of a device's direct-frame charge (see chargeDirect): densePlan's DIRECT_CHUNK, the dense direct phase's own grain. */
const DIRECT_CHUNK = 64 * 1024;
/** The composer's prepare takes the drag's omitted set (PLAN §3.3, wave 2). Today's adapter ignores the third argument. */
type OmitAwarePrepare = { prepare(view: ViewState, budget: FrameBudget, omit?: ReadonlySet<string>): void };
export function createBoardLayers(options: BoardLayersOptions): BoardLayerPair {
    const hosts = new Map<PaintBand, LayerHost>();
    let adapter: CanvasPaintAdapter | null = null, allocatorHost: LayerHost | null = null;
    let gpu: ReturnType<typeof createGpuPaintAdapter> | null = null;
    let direct: CanvasPaintAdapter | null = null, dense: ReturnType<typeof createDensePaintAdapter> | null = null;
    const retiringDense = new Set<ReturnType<typeof createDensePaintAdapter>>();
    const density = new DensityController();
    let useDense = false, deferredClear = false;
    // The route the last prepare took: true while the pane has a device (the GPU composer draws the direct paint).
    let onDeviceRoute = false;
    // The composer's adapter options (PLAN §3.3). Built as a value, not a literal: the adapter's option type gains
    // `opaqueWorld` in wave 2, and until then today's adapter ignores it.
    const gpuOptions = () => ({ audit: options.auditSurface ?? 'board',
        ...(typeof options.opaqueWorld === 'function' ? { opaqueWorld: options.opaqueWorld } : {}) });
    // The drag's omitted set reaches the tiles the adapter builds. The draw still takes it too (drawGpu's omit argument) until
    // the composer owns omission; the two must agree, and they do while both read the same omitNodes(frame).
    const prepareGpu = (view: ViewState, budget: FrameBudget, frame: PaintSource): void =>
        (gpu as OmitAwarePrepare | null)?.prepare(view, withFirstUnit(budget), options.omitNodes?.(frame) ?? undefined);
    const liveSets = new WeakMap<PaintSource, { omit: ReadonlySet<string> | null | undefined; wet: ReadonlySet<string> | undefined; live: ReadonlySet<string> }>();
    const liveFor = (frame: PaintSource): ReadonlySet<string> | undefined => {
        const omit = options.omitNodes?.(frame), wet = options.liveNodeIds?.();
        if (!omit?.size && !wet?.size) return frame.sensitiveNodes;
        const old = liveSets.get(frame); if (old && old.omit === omit && old.wet === wet) return old.live;
        const live = new LiveNodeUnion(frame.sensitiveNodes, omit, wet);
        liveSets.set(frame, { omit, wet, live }); return live;
    };
    /** Segment count at which a direct cache was refused; null while direct drawing fits. */
    let deniedDirectSegments: number | null = null;
    let estimate: Estimate | null = null, denied = false, disposed = false, lastPrepareFrame: number | null = null;
    // One back-off for every refused reservation of this layer pair; the dense plan and the direct estimate both consult it.
    const memoryGate = new MemoryRetryGate();
    let memoryRetry: ReturnType<typeof setTimeout> | null = null;
    // The first prepare after a hide drops the session bitmaps the returned view cannot draw, before it plans.
    let returnedFromHide = false;
    const replacementAsked = new WeakSet<PaintSource>();
    let presented: PaintSource | null = null, presentedOmit: ReadonlySet<string> | null = null, presentedInk: ReadonlySet<string> | null = null;
    let ackFrame: PaintSource | null = null, ackOmit: ReadonlySet<string> | null = null, ackInk: ReadonlySet<string> | null = null, ackMask = 0;
    let ackToken: RenderToken | null = null, ackContext: ViewerPaintPresentation | null = null;
    let presentedContext: ViewerPaintPresentation | null = null;
    // The view the layer was last asked to paint. A picture drawn for an earlier view (a zoom, before its replacement
    // is staged) is still current by revision, so progress compares views too; otherwise a fitted board reads
    // "settled" over a picture of the previous zoom.
    let preparedView: ViewState | null = null;
    type Drawn = { frame: PaintSource; omit: ReadonlySet<string> | null; ink: ReadonlySet<string>; context: ViewerPaintPresentation; hold: DrawHold | null };
    const drawn = new Map<PaintBand, Drawn>();
    let drawSource: PaintSource | null = null, prepareToken: FrameToken | null = null, prepareFrameId = -1;
    let drawTokens = new WeakMap<RenderToken, Map<PaintBand, Drawn>>();
    let announced = new WeakMap<RenderToken, { underlay: Drawn; content: Drawn }>();
    const recordDraw = (band: PaintBand, value: Drawn) => {
        // Accepted acknowledgements retain this exact frozen budget token. Revision alone cannot
        // distinguish a coarse summary from its fine replacement of the SAME immutable source.
        if (drawSource !== value.frame) { discardPending(); drawTokens = new WeakMap(); drawSource = value.frame; }
        drawn.set(band, value);
        if (!prepareToken) { if (value.hold) releaseHold(value.hold); return; }
        if (value.hold) pushPending(value.hold);
        let bands = drawTokens.get(prepareToken);
        if (!bands) { bands = new Map(); drawTokens.set(prepareToken, bands); }
        bands.set(band, value);
        const underlay = bands.get('underlay'), content = bands.get('content');
        if (!underlay || !content || underlay.frame !== content.frame || underlay.omit !== content.omit || underlay.ink !== content.ink
            || underlay.context.frameId !== content.context.frameId || !sameView(underlay.context.view, content.context.view)
            || !sameTransform(underlay.context.paneTransform, content.context.paneTransform) || !sameOmission(underlay.context.omittedNodeIds, content.context.omittedNodeIds)) return;
        const old = announced.get(prepareToken);
        if (old?.underlay === underlay && old.content === content) return;
        announced.set(prepareToken, { underlay, content });
        options.onDrawn?.(value.frame.sceneRevision, value.frame, value.context);
    };
    const inkFrames = new WeakMap<PaintSource, WeakMap<ReadonlySet<string>, PaintSource>>();
    const inkFrame = (frame: PaintSource, ink: ReadonlySet<string>): PaintSource => {
        if (frame.inkNodeIds === ink) return frame;
        let versions = inkFrames.get(frame); if (!versions) { versions = new WeakMap(); inkFrames.set(frame, versions); }
        let result = versions.get(ink);
        if (!result) { result = { ...frame, inkNodeIds: ink }; versions.set(ink, result); }
        return result;
    };
    const filtered = new WeakMap<PaintSource, WeakMap<ReadonlySet<string>, PaintSource>>();
    const presentedFrame = (frame: PaintSource, omit: ReadonlySet<string> | null): PaintSource => {
        if (!omit?.size) return frame;
        let versions = filtered.get(frame); if (!versions) { versions = new WeakMap(); filtered.set(frame, versions); }
        let result = versions.get(omit);
        if (!result) { result = { ...frame, inkNodeIds: new FilteredInk(frame.inkNodeIds, omit) }; versions.set(omit, result); }
        return result;
    };
    const reservations = new Map<PaintSource, ByteLease[]>(), known = new Set<PaintSource>();
    let reserved = 0;
    const activeHost = () => hosts.get('underlay') ?? hosts.get('content');
    let lastError: string | null = null, lastProgress: PaintProgress | null = null;
    const report = (error: unknown) => {
        if (isBudgetRefusal(error)) { awaitCapacity(activeHost(), () => { for (const host of hosts.values()) host.invalidate('board-capacity'); }); return; }
        lastError = messageOf(error); refreshProgress();
        try { options.onError(error); } catch { /* reporting cannot reject a worker callback */ }
    };
    // Pending while work or memory is outstanding; current only for the presented requested revision with nothing
    // outstanding. Memory denial is waiting for capacity, never a failure. A real error stands until a current
    // presentation actually completes.
    const progressNow = (): PaintProgress => {
        if (lastError !== null) return { kind: 'failed', message: lastError };
        const blocked = !!options.frames.blocked?.() || denied || !!dense?.memoryBlocked();
        // An idle ancestor pass runs while the view is already sharp: it is not work the board is waiting on.
        const idleOnly = useDense && !!dense?.idleOnly();
        const working = !!options.frames.needsFrame() || (!!estimate && !estimate.done) || (!idleOnly && !!adapter?.needsFrame())
            || (!!activeHost()?.device() && !!gpu?.needsFrame()) || !!dense?.pending();
        // The frame still drawn may be the previous zoom's, re-drawn at the new view, while its replacement is staged.
        const showsView = !!presentedContext && !!preparedView && sameView(presentedContext.view, preparedView) && !options.frames.replacing?.();
        if (!blocked && !working && presented && presented.sceneRevision === options.requestedRevision() && options.frames.isCurrent(presented) && showsView) return { kind: 'current' };
        const drawn = !!presented && presented.sceneRevision === options.requestedRevision() && options.frames.isCurrent(presented);
        return { kind: 'pending', reason: blocked ? 'waiting-memory' : 'building', drawn };
    };
    // A refused reservation is retried on a bounded cadence while it is outstanding. A capacity wake alone can wait
    // forever: the governor notifies only on a release or a plan, and a stale grant is refreshed only by a prepare.
    const armMemoryRetry = (waiting: boolean) => {
        if (!waiting || disposed) {
            if (memoryRetry !== null) { clearTimeout(memoryRetry); memoryRetry = null; }
            // Nothing is waiting for memory any more, so the next refusal starts a fresh back-off.
            if (!waiting) memoryGate.admitted();
            return;
        }
        if (memoryRetry !== null) return;
        // The retry lands when the refusal's window ends; before any refusal it re-checks at the minimum cadence.
        const delay = memoryGate.closed() ? Math.max(1, memoryGate.remaining()) : MEMORY_RETRY_MIN_MS;
        memoryRetry = setTimeout(() => { memoryRetry = null; allocatorHost?.invalidate('board-memory-retry'); }, delay);
    };
    const refreshProgress = () => {
        const next = progressNow();
        armMemoryRetry(next.kind === 'pending' && next.reason === 'waiting-memory');
        if (lastProgress && sameProgress(lastProgress, next)) return;
        lastProgress = next; options.onPaintProgress?.();
    };
    const releaseFrame = (frame: PaintSource) => {
        const leases = reservations.get(frame);
        if (!leases) return;
        reservations.delete(frame);
        for (const lease of leases) { allocatorHost!.allocator.cpu.release(lease); reserved -= lease.bytes; }
    };
    // A draw's exact image backings, borrowed AT the draw: no later prepare, ack or retirement can free the
    // snapshot this draw read. A hold is released when an accepted presentation supersedes it, when its draw is
    // discarded (new source, clearResources, dispose), or when the bounded pending queue drops it.
    interface DrawHold { readonly frame: PaintSource; readonly images: readonly PresentedImage[]; borrow: PreparedRetain | null }
    let pendingHolds: DrawHold[] = [], presentedHolds: DrawHold[] = [];
    // Two frames of two bands. Acknowledgements arrive in draw order, so an older unacknowledged draw is dead
    // anyway; a host that never acknowledges therefore cannot pin backings. The dropped draw's facts stay unknown.
    const MAX_PENDING_HOLDS = 4;
    const releaseHold = (hold: DrawHold) => { const borrow = hold.borrow; if (!borrow) return; hold.borrow = null; borrow.release(); };
    const pushPending = (hold: DrawHold) => {
        pendingHolds.push(hold);
        while (pendingHolds.length > MAX_PENDING_HOLDS) releaseHold(pendingHolds.shift()!);
    };
    const discardPending = () => { const old = pendingHolds; pendingHolds = []; for (const hold of old) releaseHold(hold); };
    const discardHolds = () => {
        discardPending();
        const old = presentedHolds; presentedHolds = [];
        for (const hold of old) releaseHold(hold);
    };
    // The accepted draw's holds become the presented backings. Earlier pending draws can no longer be accepted.
    const acceptHolds = (accepted: readonly (DrawHold | null)[]) => {
        const kept = accepted.filter((hold): hold is DrawHold => hold !== null);
        const last = Math.max(-1, ...kept.map(hold => pendingHolds.indexOf(hold)));
        const pending = pendingHolds;
        pendingHolds = pending.filter((_, index) => index > last);
        for (const hold of pending.slice(0, last + 1)) if (!kept.includes(hold)) releaseHold(hold);
        const old = presentedHolds; presentedHolds = kept;
        for (const hold of old) if (!kept.includes(hold)) releaseHold(hold);
    };
    // Takes the draw's borrow right after the draw read its snapshot. A draw whose images cannot be proven (the
    // frame has moved on, or a drawn image is not a live ImageBitmap) has no hold, so its facts stay unknown.
    const captureDraw = (frame: PaintSource, omit: ReadonlySet<string> | null): DrawHold | null => {
        const borrow = adapter?.retainPrepared() ?? null;
        if (!borrow) return null;
        const { prepared } = borrow;
        const source = prepared.sourceFrame;
        let usable = source.sceneRevision === frame.sceneRevision && sameToken(source.token, frame.token);
        const images: PresentedImage[] = [];
        if (usable) {
            try {
                // Windows are walked in canonical order, one bounded window at a time.
                windows: for (const window of prepared.windows) {
                    for (const item of window.items) {
                        if (item.kind !== 'image' || omit?.has(item.nodeId)) continue;
                        // A standin draws a crop with no quad to classify: it gets no facts, so the embed keeps its poster.
                        if (prepared.resources.imageCrop?.(item.imageKey)) continue;
                        const bitmap = prepared.resources.image(item.imageKey);
                        if (!(bitmap instanceof ImageBitmap)) { usable = false; break windows; }
                        images.push({ nodeId: item.nodeId, item, source: bitmap });
                    }
                }
            } catch { usable = false; }
        }
        if (!usable) { borrow.release(); return null; }
        return { frame: source, images: Object.freeze(images), borrow };
    };
    // Each consumer lease is its own borrow of the same snapshot, so releasing it cannot free the draw's backing.
    const leaseOf = (hold: DrawHold | null): PresentedImageLease | null => {
        const borrow = hold?.borrow?.retain() ?? null;
        if (!hold || !borrow) return null;
        const { frame, images } = hold;
        let released = false;
        return Object.freeze({ frame, images, release() { if (!released) { released = true; borrow.release(); } } });
    };
    const retainedByDense = (): ReadonlySet<PaintSource> => {
        const retained = new Set(dense?.retainedFrames());
        for (const old of retiringDense) {
            const frames = old.retainedFrames();
            if (!frames.size) { retiringDense.delete(old); continue; }
            for (const frame of frames) retained.add(frame);
        }
        return retained;
    };
    const collectRetired = () => {
        if (deferredClear && !retainedByDense().size) {
            deferredClear = false; options.frames.clear(); known.clear();
        }
    };
    const clearResources = (reason: GpuReleaseReason) => {
        discardHolds();
        // The reference adapter keeps CPU paths on context loss; this owner must
        // explicitly evict them before returning its CPU leases for any release.
        gpu?.release(reason);
        direct?.release(reason === 'context-lost' ? 'pressure' : reason);
        dense?.release(reason);
        for (const frame of [...reservations.keys()]) releaseFrame(frame);
        estimate = null; denied = false; deniedDirectSegments = null; lastPrepareFrame = null; drawn.clear(); drawTokens = new WeakMap(); announced = new WeakMap(); drawSource = null; prepareToken = null; prepareFrameId = -1;
        ackFrame = null; ackOmit = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; presentedInk = null;
        if (reason === 'hidden') {
            deferredClear = true; collectRetired(); presented = null; presentedContext = null; refreshProgress();
            density.reset(); useDense = false; returnedFromHide = true;
        }
    };
    const ensureAdapter = (host: LayerHost): CanvasPaintAdapter => {
        if (!adapter) {
            allocatorHost = host;
            options.frames.bindMemory?.(host.allocator.cpu);
            const resources = { frames: options.frames, images: options.images,
                invalidate: () => { collectRetired(); activeHost()?.invalidate('board-resource'); } };
            direct = createCanvasPaintAdapter(resources,
                (ctx, view, paint) => { const owner = activeHost(); if (!owner) throw new Error('Board layer is detached'); owner.paintWorld(ctx, view, paint); }, report);
            dense = createDensePaintAdapter(resources, host, report, memoryGate);
            const current = () => useDense ? dense! : direct!;
            adapter = {
                prepare: (view, budget) => {
                    const source = options.frames.readFrame(), work = withFirstUnit(budget);
                    if (useDense) dense!.prepare(view, work, source ? liveFor(source) : undefined);
                    else direct!.prepare(view, work);
                },
                readyFrame: () => current().readyFrame(), borrowPrepared: () => current().borrowPrepared(),
                retainPrepared: () => current().retainPrepared(),
                draw2d: (ctx, view, band, omit) => current().draw2d(ctx, view, band, omit),
                release: reason => { direct!.release(reason); dense!.release(reason); },
                needsFrame: () => current().needsFrame(), memory: () => current().memory(),
                dispose: () => { direct!.dispose(); dense!.dispose(); },
            };
            gpu = createGpuPaintAdapter(adapter, host, report, gpuOptions());
        }
        return adapter;
    };
    const startEstimate = (frame: PaintSource) => {
        if (estimate?.frame === frame) return;
        known.add(frame);
        estimate = { frame, walk: paintItemsOf(frame), current: null, clip: 0, chunk: 0, arc: -1, bytes: 0, itemBytes: 0, maxItemBytes: 0, segments: 0, items: 0, demandPublished: false, done: false };
        denied = false;
    };
    const prune = (requested: PaintSource, ready: PaintSource | null) => {
        const retained = retainedByDense();
        for (const frame of known) {
            if (!retained.has(frame) && frame !== requested && frame !== ready && frame !== gpu?.readyFrame() && frame !== presented && frame !== drawn.get('underlay')?.frame && frame !== drawn.get('content')?.frame) {
                options.frames.retire(frame); releaseFrame(frame); known.delete(frame);
            }
        }
    };
    /** On a device the direct frame's CPU bytes are charged as they are built: measured by `direct.memory()`, grown in
     * DIRECT_CHUNK leases through the canonical allocator, so the governor sees what the GPU route really holds. The
     * granularity is the dense direct phase's (densePlan DIRECT_CHUNK): the charge never grows per item. False when the
     * grant refuses; the layer then builds nothing more and waits for capacity. */
    const chargeDirect = (frame: PaintSource): boolean => {
        const want = direct!.memory().cpuBytes;
        let leases = reservations.get(frame);
        if (!leases) { leases = []; reservations.set(frame, leases); }
        let held = 0;
        for (const lease of leases) held += lease.bytes;
        if (held >= want) { denied = false; return true; }
        if (memoryGate.closed()) { denied = true; return false; }
        while (held < want) {
            const lease = allocatorHost!.allocator.cpu.reserve(DIRECT_CHUNK);
            if (!lease) {
                memoryGate.refused(); denied = true;
                allocatorHost!.demandChanged?.();
                allocatorHost!.allocator.cpu.whenAvailable?.(() => allocatorHost?.invalidate('board-memory'));
                return false;
            }
            memoryGate.admitted();
            leases.push(lease); reserved += lease.bytes; held += lease.bytes;
        }
        denied = false; return true;
    };
    const prepare = (view: ViewState, budget: FrameBudget) => {
        if (!adapter || disposed || lastPrepareFrame === budget.frameId) return;
        lastPrepareFrame = budget.frameId; prepareToken = budget.token; prepareFrameId = budget.frameId;
        preparedView = view;
        deferredClear = false;
        try {
            options.beforePrepare?.(view, budget);
            if (returnedFromHide && dense?.dropUnused(view)) { returnedFromHide = false; deniedDirectSegments = null; }
            options.frames.prepare(withFirstUnit(budget));
            const frame = options.frames.readFrame();
            // The two returns below leave this layer reporting needsFrame() over a frame that cannot draw, and nothing
            // else asks for its replacement. Each asks ONCE per frame object, as the missing-live-node case does, so a
            // frame that never changes cannot keep the pump running with no progress.
            if (!frame || !options.frames.isCurrent(frame) || !sameToken(frame.token, budget.token)) {
                if (frame && !replacementAsked.has(frame)) { replacementAsked.add(frame); options.requestFrame?.(); }
                return;
            }
            // On a device the GPU composer draws the direct paint alone: no density latch, no estimate walk, no reservation
            // before the build. Dense mode is the canvas2d route's; a route change resets what the other route left behind.
            const gpuRoute = !!allocatorHost?.device();
            if (gpuRoute !== onDeviceRoute) {
                onDeviceRoute = gpuRoute; estimate = null; denied = false; deniedDirectSegments = null; density.reset();
                if (gpuRoute) for (const old of [...reservations.keys()]) releaseFrame(old);
            }
            if (gpuRoute) {
                if (useDense) {
                    // Emitting 'direct' makes the owner request a full frame; the live-only frame in hand is not drawable here.
                    useDense = false; denied = false;
                    allocatorHost?.demandChanged?.();
                    dense!.release('pressure');
                    allocatorHost!.invalidate('board-density-demand-ready');
                    options.onDensityMode?.('direct');
                    return;
                }
                if (frame.liveOnly) {
                    if (!replacementAsked.has(frame)) { replacementAsked.add(frame); options.requestFrame?.(); }
                    return;
                }
                known.add(frame);
                // Charged before the build (the grant may already refuse) and after it (what this step built is held).
                if (!chargeDirect(frame)) return;
                adapter.prepare(view, budget);
                prepareGpu(view, budget, frame);
                chargeDirect(frame);
                prune(frame, adapter.readyFrame());
                options.onPrepared?.();
                return;
            }
            // A live-only frame holds no other items, so it can never serve direct drawing; a direct frame
            // cannot serve dense drawing either. The owner's request for the other kind is already in flight.
            if (!!frame.liveOnly !== useDense && frame.openTile) {
                if (!replacementAsked.has(frame)) { replacementAsked.add(frame); options.requestFrame?.(); }
                return;
            }
            if (useDense && frame.liveOnly) {
                const live = liveFor(frame);
                let missing = false;
                if (live) for (const id of live) if (!frame.sensitiveNodes?.has(id)) { missing = true; break; }
                // A frame missing live nodes asks for its replacement ONCE per frame and still draws: returning
                // here and re-asking on every changed missing set restarted the build each frame and froze a
                // 3,500-item board on its last picture. The missing nodes appear with the replacement frame.
                if (missing && !replacementAsked.has(frame)) { replacementAsked.add(frame); options.requestFrame?.(); }
            }
            startEstimate(frame);
            while (!estimate!.done && !budget.shouldYield()) estimateStep(estimate!);
            // An estimate split across frames must ask for the next one: nothing else wakes a still view
            // (seen: a 3,500-item board froze in 'building' after switching to dense).
            if (!estimate!.done) { allocatorHost!.invalidate('board-estimate-continue'); return; }
            // Initial operation-count defaults; the owner defers binding calibration, not the hierarchy.
            // Dense tiles are streamed from the frame's own pin; a frame that cannot reopen its stream stays direct.
            // The index count is the same for a dense and a direct frame, so the mode cannot oscillate
            // with the frame kind it selects; the frame's own estimate stands in only before the index is built.
            const candidates = options.candidates?.() ?? null;
            const segments = candidates ?? estimate!.segments, items = candidates ?? estimate!.items;
            const observed = density.observe({ frameId: budget.frameId, now: performance.now(),
                candidateSegments: segments, coveredDevicePixels: view.viewport.width * view.viewport.height * view.viewport.dpr ** 2,
                estimatedGpuMs: segments * .00004 + items * .0001 });
            // A direct cache the memory grant refused cannot draw at all: the dense path streams bounded tiles
            // instead (seen: 160+ strokes stayed 'waiting for memory' forever, frozen picture, no redraw).
            // It returns to direct once the scene's estimate is well under what was refused.
            // Measured on the index count, which a live-only dense frame shares with a direct one (its own estimate is tiny).
            // The view's own count (candidates) is valid for a live-only dense frame too, so a dense latch can release.
            // Without it, only a whole-scene estimate can judge, which a live-only frame never is.
            if (deniedDirectSegments !== null && (candidates !== null || !frame.liveOnly) && segments < deniedDirectSegments * 0.5) deniedDirectSegments = null;
            // A live-only frame is the kind dense mode itself requests; it carries no tile stream of its own.
            // A frame whose dense tile jobs failed their bounded retries is drawn direct; the next frame starts over.
            const mode = dense!.gaveUp(frame) ? 'direct' : useDense && frame.liveOnly && deniedDirectSegments !== null ? 'dense'
                : frame.openTile ? (deniedDirectSegments !== null ? 'dense' : observed) : 'direct';
            if ((mode === 'dense') !== useDense) {
                useDense = mode === 'dense';
                denied = false;
                // The dense working set (kept bitmaps, tile runs) is declared only in dense mode: the pane re-collects its demand.
                allocatorHost?.demandChanged?.();
                if (useDense) {
                    direct!.release('pressure');
                    for (const old of [...reservations.keys()]) releaseFrame(old);
                } else dense!.release('pressure');
                allocatorHost!.invalidate('board-density-demand-ready');
                options.onDensityMode?.(mode);
                return;
            }
            // Three actual decision frames avoid allocating a whole-scene Path2D cache just
            // before dense mode would throw it away. No timer or stationary RAF is introduced.
            if (!useDense && density.pending()) { denied = false; return; }
            // A live overlay frame is replaced by the next pointer move, so the demand round trip (one whole frame that
            // builds nothing) would be paid for every move and the overlay would never build: it reserves at once, and a
            // refused reservation still re-collects the demand below before it latches.
            if (!useDense && !options.optional && !reservations.has(frame) && !estimate!.demandPublished && estimate!.bytes) {
                estimate!.demandPublished = true;
                allocatorHost!.invalidate('board-native-demand-ready'); return;
            }
            if (!useDense && !reservations.has(frame)) {
                const bytes = estimate!.bytes;
                if (bytes) {
                    // Inside a refusal's back-off the whole-frame estimate is not asked again.
                    if (memoryGate.closed()) { denied = true; return; }
                    // The pane's grant may still be the floor from before this estimate was known (the demand is collected
                    // on refresh). Re-collect it now and retry once; only a refusal against the refreshed grant latches.
                    let lease = allocatorHost!.allocator.cpu.reserve(bytes);
                    if (!lease) { allocatorHost!.refreshDemandNow?.(); lease = allocatorHost!.allocator.cpu.reserve(bytes); }
                    if (!lease) {
                        memoryGate.refused();
                        allocatorHost!.demandChanged?.();
                        denied = true;
                        if (frame.openTile && deniedDirectSegments === null) { deniedDirectSegments = segments; allocatorHost!.invalidate('board-density-demand-ready'); }
                        allocatorHost!.allocator.cpu.whenAvailable?.(() => allocatorHost?.invalidate('board-memory'));
                        return;
                    }
                    memoryGate.admitted();
                    reservations.set(frame, [lease]); reserved += lease.bytes;
                } else reservations.set(frame, []);
            }
            denied = false;
            adapter.prepare(view, budget);
            prepareGpu(view, budget, frame);
            prune(frame, adapter.readyFrame());
            options.onPrepared?.();
        } catch (error) { report(error); }
        finally { refreshProgress(); }
    };
    const acknowledge = (band: PaintBand, revision: number, token: RenderToken) => {
        const drawnBand = drawTokens.get(token)?.get(band), frame = drawnBand?.frame, omit = drawnBand?.omit ?? null, ink = drawnBand?.ink;
        if (!drawnBand || !frame || !ink || frame.sceneRevision !== revision || !sameToken(frame.token, token)) return;
        const context = drawnBand.context;
        if (ackFrame !== frame || ackOmit !== omit || ackInk !== ink || ackToken !== token || ackContext?.frameId !== context.frameId
            || !sameView(ackContext?.view, context.view) || !sameTransform(ackContext?.paneTransform, context.paneTransform)
            || !sameOmission(ackContext?.omittedNodeIds ?? null, context.omittedNodeIds)) {
            ackFrame = frame; ackOmit = omit; ackInk = ink; ackToken = token; ackContext = context; ackMask = 0;
        }
        ackMask |= band === 'underlay' ? 1 : 2;
        if (ackMask !== 3) return;
        if (presented === frame && presentedOmit === omit && presentedInk === ink && presentedContext?.frameId === context.frameId
            && sameView(presentedContext?.view, context.view) && sameTransform(presentedContext?.paneTransform, context.paneTransform)
            && sameOmission(presentedContext?.omittedNodeIds ?? null, context.omittedNodeIds)) {
            ackFrame = null; ackOmit = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; drawTokens.delete(token); return;
        }
        try {
            options.frames.presented(frame);
            acceptHolds([...(drawTokens.get(token)?.values() ?? [])].map(drawn => drawn.hold));
            const previous = presented; presented = frame; presentedOmit = omit; presentedInk = ink; presentedContext = context;
            // A completed presentation is the only event that clears a real error.
            lastError = null; refreshProgress();
            ackFrame = null; ackOmit = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; drawTokens.delete(token);
            if (previous && previous !== frame && !retainedByDense().has(previous)) {
                options.frames.retire(previous); releaseFrame(previous); known.delete(previous);
            }
            options.onPresented?.(revision, token, presentedFrame(inkFrame(frame, ink), context.omittedNodeIds), context);
        } catch (error) { report(error); }
    };
    // A frame is drawable only while it is the current generation of its source (an optional overlay's superseded frame never paints).
    const drawable = (frame: PaintSource): boolean => !options.optional || options.frames.isCurrent(frame);
    // The offset a frame is drawn at: null for none, undefined when a dense frame cannot take one (the owner rebuilds).
    const drawnOffset = (frame: PaintSource, dense: boolean): Readonly<{ x: number; y: number }> | null | undefined => {
        const offset = options.drawOffset?.(frame);
        if (!offset || (offset.x === 0 && offset.y === 0)) return null;
        if (dense) { auditCount(options.auditSurface ?? 'board', 'fallback:offset-rebuild'); options.onOffsetUnsupported?.(); return undefined; }
        return offset;
    };
    const coverageOf = (layer: Layer, frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage => {
        const gpuCoverage = backend !== 'canvas2d' ? gpu?.coverage(frame.view) : null;
        const ready = backend === 'canvas2d' ? adapter?.readyFrame() : gpu?.readyFrame();
        const requested = frame.layers.find(item => item.layer === layer)?.sceneRevision;
        const denseCoverage = useDense && ready ? dense?.coverage(frame.view, liveFor(ready)) : null;
        if (useDense && !denseCoverage?.complete) return { complete: false, sharp: false };
        if (backend !== 'canvas2d' && !gpuCoverage?.complete) return { complete: false, sharp: false };
        if (!ready || !sameToken(ready.token, frame.token)) return { complete: false, sharp: false };
        const current = ready.sceneRevision === requested && ready.sceneRevision === options.requestedRevision()
            && ready.theme === options.requestedTheme() && options.frames.isCurrent(ready);
        return current ? { complete: true, sharp: (gpuCoverage?.sharp ?? true) && (denseCoverage?.sharp ?? true) } : { complete: false, sharp: false, staleVersion: true };
    };
    const definition = (band: PaintBand): PlatformLayerDefinition => ({
        id: `board-${band}`, group: 'document',
        create(host) {
            if (disposed || hosts.has(band)) throw new Error('Board layer already attached');
            hosts.set(band, host); ensureAdapter(host);
            let ended = false;
            const layer: Layer & LayerEvicting = {
                prepare,
                drawGpu(pass, view) {
                    const frame = gpu?.readyFrame();
                    if (!frame || !drawable(frame)) return;
                    const omit = options.omitNodes?.(frame) ?? null;
                    const shift = drawnOffset(frame, useDense); if (shift === undefined) return;
                    const ink = gpu!.readyInkNodeIds() ?? frame.inkNodeIds;
                    if (!prepareToken) return;
                    const actualView = copyView(view);
                    gpu!.drawGpu(pass, shift ? shiftedView(view, shift) : view, band, omit ?? undefined);
                    // Borrowed right after the draw read its snapshot, before anything else can move the adapter on.
                    const hold = captureDraw(frame, omit);
                    const context = Object.freeze({ view: actualView, frameId: prepareFrameId,
                        paneTransform: host.paneTransform(actualView, prepareFrameId),
                        token: Object.freeze({ ...prepareToken }), omittedNodeIds: omit ? new OmittedSnapshot(omit) : null,
                        retain: () => options.frames.retain(frame), retainImages: () => leaseOf(hold) });
                    recordDraw(band, { frame, omit, ink, context, hold });
                },
                evictGpu(bytes, frameId) {
                    // Only the band that owns the GPU adapter frees it: the other band's trim has nothing of the adapter's.
                    if (hosts.get(band) !== allocatorHost) return 0;
                    const adapter = gpu as GpuEvicting | null;
                    return typeof adapter?.evictGpu === 'function' ? adapter.evictGpu(bytes, frameId) : 0;
                },
                encodeOffscreen(passes, view) {
                    const encoder = gpu as OffscreenEncoder | null;
                    if (typeof encoder?.encodeOffscreen === 'function') encoder.encodeOffscreen(passes, view, band);
                },
                draw2d(ctx, view) {
                    const frame = adapter?.readyFrame();
                    if (!frame || !drawable(frame)) return;
                    const omit = options.omitNodes?.(frame) ?? null;
                    const shift = drawnOffset(frame, useDense); if (shift === undefined) return;
                    const ink = adapter!.borrowPrepared()?.root.inkNodeIds ?? frame.inkNodeIds;
                    if (!prepareToken) return;
                    const actualView = copyView(view);
                    adapter!.draw2d(ctx, shift ? shiftedView(view, shift) : view, band, omit ?? undefined);
                    // Borrowed right after the draw read its snapshot, before anything else can move the adapter on.
                    const hold = captureDraw(frame, omit);
                    const context = Object.freeze({ view: actualView, frameId: prepareFrameId,
                        paneTransform: host.paneTransform(actualView, prepareFrameId),
                        token: Object.freeze({ ...prepareToken }), omittedNodeIds: omit ? new OmittedSnapshot(omit) : null,
                        retain: () => options.frames.retain(frame), retainImages: () => leaseOf(hold) });
                    recordDraw(band, { frame, omit, ink, context, hold });
                },
                releaseGpu(reason) { clearResources(reason); },
                memory() {
                    const extra = gpu?.memory();
                    return allocatorHost === host ? { gpuBytes: extra?.gpuBytes ?? 0, cpuBytes: reserved + (dense?.memory().cpuBytes ?? 0) + (options.frames.memoryBytes?.() ?? 0) + (extra?.cpuBytes ?? 0) }
                        : { gpuBytes: 0, cpuBytes: 0 };
                },
                // Dense tiles are paced by preparation: while the requested picture is still building, it takes the frame's share.
                // Nothing presented at all: the board shows "Loading drawing…" and nothing on screen is waiting on this pane's frame.
                prepareUrgent() {
                    return !disposed && !ended && presented === null;
                },
                needsFrame() {
                    return !disposed && !ended && (options.frames.needsFrame() || (!denied && (!!estimate && !estimate.done || density.pending() || !!adapter?.needsFrame()
                        || !!host.device() && !!gpu?.needsFrame())));
                },
                onFramePresented(revision, token) { acknowledge(band, revision, token); },
                dispose() {
                    if (ended) return;
                    ended = true;
                    armMemoryRetry(false);
                    if (allocatorHost === host) { clearResources('pressure'); allocatorHost = null; }
                    hosts.delete(band);
                    if (!hosts.size) {
                        disposed = true; discardHolds(); gpu?.dispose(); gpu = null; adapter?.dispose(); adapter = null;
                        deferredClear = true; collectRetired(); presented = null; refreshProgress();
                    } else if (!allocatorHost) {
                        allocatorHost = activeHost()!;
                        options.frames.bindMemory?.(allocatorHost.allocator.cpu);
                        const oldDense = dense!; oldDense.dispose(); retiringDense.add(oldDense);
                        dense = createDensePaintAdapter({ frames: options.frames, images: options.images,
                            invalidate: () => { collectRetired(); activeHost()?.invalidate('board-resource'); } }, allocatorHost, report, memoryGate);
                        gpu?.dispose(); gpu = createGpuPaintAdapter(adapter!, allocatorHost, report, gpuOptions());
                    }
                },
            };
            return layer;
        },
        revision() { return options.requestedRevision(); },
        drawVersion() { return options.drawVersion?.() ?? 0; },
        cpuEvict(_layer, bytes) {
            // Only the band that holds the session's memory reclaims it; the other band's grant has nothing of the dense plan.
            if (hosts.get(band) === allocatorHost) dense?.reclaim(bytes);
        },
        cpuWorkingSet() {
            const upcoming = !useDense && estimate?.done && !density.pending() && !reservations.has(estimate.frame) ? estimate.bytes : 0;
            const scratch = allocatorHost?.device() ? gpu?.cpuWorkingSet().mandatoryBytes ?? 0 : 0;
            return { mandatoryBytes: hosts.get(band) === allocatorHost
                ? reserved + upcoming + scratch + (useDense ? dense?.cpuWorkingSet(estimate?.maxItemBytes ?? 0) ?? 0 : 0) + (options.frames.cpuWorkingSet?.() ?? 0) : 0, prefetchBytes: 0 };
        },
        critical() { return !adapter?.readyFrame(); },
        coverage(layer, frame, backend) {
            const actual = coverageOf(layer, frame, backend);
            return options.optional && !actual.complete ? { complete: true, sharp: true } : actual;
        },
    });
    const pair = [definition('underlay'), definition('content')] as unknown as BoardLayerPair;
    pair.invalidate = (reason = 'board-content') => { for (const host of hosts.values()) host.invalidate(reason); };
    pair.wakeAt = deadlineMs => { for (const host of hosts.values()) host.wakeAt(deadlineMs); };
    pair.memory = () => allocatorHost?.allocator.cpu ?? null;
    pair.paintProgress = progressNow;
    pair.readyFrame = () => {
        if (disposed) return null;
        const gpuFrame = activeHost()?.device() ? gpu?.readyFrame() : null;
        const frame = gpuFrame ?? adapter?.readyFrame();
        if (!frame) return null;
        const ink = gpuFrame ? gpu?.readyInkNodeIds() : adapter?.borrowPrepared()?.root.inkNodeIds;
        return ink ? inkFrame(frame, ink) : frame;
    };
    return Object.freeze(pair);
}
