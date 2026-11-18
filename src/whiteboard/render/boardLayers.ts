import type { Affine, Rect, ViewState } from '../../platform/types';
import type { HostBlock } from '../model/doc';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import { awaitSizedCapacity, isBudgetRefusal } from './budgetRefusal';
import { withFirstUnit } from './firstUnit';
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
import type { GeometryPins } from './gpu/tileComposer';
import { auditCount, auditDrawn } from '../../platform/render/renderAudit';
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
export interface BoardLayersOptions {
    readonly frames: PaintFrameAssembler;
    readonly images: PaintImageProvider;
    readonly onError: (error: unknown) => void;
    /** Fired once per actual change of the renderer's progress; never for a repeated value. */
    readonly onPaintProgress?: () => void;
    readonly requestedRevision: () => number;
    /** The node ids published in (from, to], or null when unknown (history not retained, a structural change, or no scene yet). */
    readonly changedNodesSince?: (from: number, to: number) => ReadonlySet<string> | null;
    /** The theme the view asks for: a frame painted for the other theme is never current, whatever its revision. */
    readonly requestedTheme: () => 'light' | 'dark';
    /** View-only suppression, evaluated against the actual ready preview frame. */
    readonly omitNodes?: (frame: PaintSource) => ReadonlySet<string> | null;
    readonly liveNodeIds?: () => ReadonlySet<string> | undefined;
    /** Whether the live layer paints this changed node in the frame at `view`: a changed node counts as covered by the picture
     * only then (or when it is omitted, a drag's preview). Membership in liveNodeIds alone is not coverage. */
    readonly liveDraws?: (nodeId: string, band: PaintBand, view: ViewState, canvas: boolean) => boolean;
    /** The overlay's report of the nodes it drew at a scene revision (after a commit it is frozen, so this is its last composite).
     * A stale base picture covers a changed node only where this report has it at the latest revision (gpu's ruling). */
    readonly overlayDrawn?: () => { readonly sceneRevision: number; readonly nodes: ReadonlySet<string> } | null;
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
    /** A live-only overlay's own nodes: its composer indexes and draws only these items of the paint it is handed (see the GPU adapter). */
    readonly liveNodes?: ReadonlySet<string>;
    /** The geometry service a live zoom pins its visible strokes in (the GPU adapter's pins; absent pins nothing). */
    readonly geometryPins?: GeometryPins;
    /** An overlay (a drag's preview): its few plain parts are drawn live with no tiles, so no tile grant can stall it. */
    readonly liveOverlay?: boolean;
    /** Whether an optional layer has a request to draw. Nothing requested is nothing to draw: the layer is complete and counts no hole. */
    readonly requested?: () => boolean;
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
const NO_RECTS: readonly Rect[] = Object.freeze([]);
const NO_IMAGES: readonly PresentedImage[] = Object.freeze([]);
/** The pages the host's own layers have painted at least once, read from each layer that reports them (`drawnPageRects`: a
 * notebook's paper, a PDF's page layer). A layer that reports none contributes nothing, so a claim is never made early.
 * The composer asks once per tile: a layer's claim array keeps its identity while the claim is unchanged, so the reader
 * rebuilds its answer only when one of those arrays changes, and allocates nothing while they hold. */
export function createDrawnPagesReader(): (layers: readonly unknown[]) => readonly Rect[] {
    const sources: (readonly Rect[])[] = [];
    let result: readonly Rect[] = NO_RECTS;
    return layers => {
        let changed = sources.length !== layers.length;
        for (let i = 0; i < layers.length; i++) {
            const rects = (layers[i] as { drawnPageRects?: () => readonly Rect[] }).drawnPageRects?.() ?? NO_RECTS;
            if (sources[i] !== rects) { sources[i] = rects; changed = true; }
        }
        if (changed) {
            sources.length = layers.length;
            result = Object.freeze(sources.flat());
        }
        return result;
    };
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
// One snapshot per omitted set: the drag's set keeps its identity across draws (attachView's union caches it), so a copy per
// draw would be the same copy again. A set edited in place would keep its first snapshot, so the sets are built immutable.
const omittedSnapshots = new WeakMap<ReadonlySet<string>, OmittedSnapshot>();
function omittedOf(omit: ReadonlySet<string> | null): OmittedSnapshot | null {
    if (!omit) return null;
    let snapshot = omittedSnapshots.get(omit);
    if (!snapshot) { snapshot = new OmittedSnapshot(omit); omittedSnapshots.set(omit, snapshot); }
    return snapshot;
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
    /** The ink nodes the board's GPU tiles drew in the last composite: the live stroke's wet layer hands over to them. */
    drawnInkNodeIds(): ReadonlySet<string>;
    /** The live-only nodes the board's GPU tiles drew in the last composite, both bands: a live overlay hands a node over only after this. */
    drawnLiveNodeIds(): ReadonlySet<string>;
    /** Whether the board draws on a device (its GPU composer), so the owner may ask for whole-scene frames. */
    onDevice(): boolean;
    /** The owning band's CPU bytes now (the direct charge, the dense plan, the device scratch): the measured cost a request's size is judged by. */
    cpuMandatoryBytes(): number;
    /** The pane's CPU grant as its layer host reports it (`allocator.cpuGrantBytes`); 0 when none is known (no host has drawn,
     * or the allocator does not report one), and the caller then judges by its own floor. */
    cpuGrantBytes(): number;
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
/** The adapter's CPU reclaim (h2, `evictCpu` on impl/lane/gpu-h2): typeof-guarded until it merges, so an absent method frees nothing. */
type CpuEvicting = { evictCpu?(bytes: number): number };
/** The grain of a device's direct-frame charge (see chargeDirect): densePlan's DIRECT_CHUNK, the dense direct phase's own grain. */
const DIRECT_CHUNK = 64 * 1024;
/** The coverage a layer reports while it cannot draw the frame: shared, so the per-frame check allocates nothing. */
const INCOMPLETE: LayerCoverage = Object.freeze({ complete: false, sharp: false });
const NO_INK: ReadonlySet<string> = Object.freeze(new Set<string>());
/** The GPU adapter's report of the ink its tiles drew (h2 adds it to the adapter). Until then nothing is reported drawn,
 * so the live stroke keeps drawing itself, as it does today. */
type DrawnInkReporter = { drawnInkNodeIds?(): ReadonlySet<string> };
type DrawnLiveReporter = { drawnLiveNodeIds?(band: PaintBand): ReadonlySet<string> };
/** The GPU adapter's mandatory bytes for a viewport (h2 adds it to the adapter). Until then a device reports none beyond its
 * own leases, as before this member existed. */
type GpuWorkingSetReporter = { gpuMandatoryBytes?(viewport: Readonly<{ width: number; height: number }>): number };

const STALE: LayerCoverage = Object.freeze({ complete: false, sharp: false, staleVersion: true });
/** The revision a frame asks a layer for: a loop, since this runs every frame and `find` would allocate a closure. */
export function createBoardLayers(options: BoardLayersOptions): BoardLayerPair {
    const hosts = new Map<PaintBand, LayerHost>();
    let adapter: CanvasPaintAdapter | null = null, allocatorHost: LayerHost | null = null;
    let gpu: ReturnType<typeof createGpuPaintAdapter> | null = null;
    let direct: CanvasPaintAdapter | null = null, dense: ReturnType<typeof createDensePaintAdapter> | null = null;
    // The dense adapter's resources, kept so the adapter can be built when dense mode is first entered (see ensureDense).
    let denseResources: Parameters<typeof createDensePaintAdapter>[0] | null = null;
    const retiringDense = new Set<ReturnType<typeof createDensePaintAdapter>>();
    const density = new DensityController();
    let useDense = false, deferredClear = false;
    // The route the last prepare took: true while the pane has a device (the GPU composer draws the direct paint).
    let onDeviceRoute = false;
    // The composer's adapter options (PLAN §3.3). Built as a value, not a literal: the adapter's option type gains
    // `opaqueWorld` in wave 2, and until then today's adapter ignores it.
    const gpuOptions = () => ({ audit: options.auditSurface ?? 'board', ...(options.liveOverlay ? { liveOverlay: true } : {}),
        ...(typeof options.opaqueWorld === 'function' ? { opaqueWorld: options.opaqueWorld } : {}),
        ...(options.liveNodes ? { liveNodes: options.liveNodes } : {}), ...(options.geometryPins ? { pins: options.geometryPins } : {}) });
    // The drag's omitted set is applied where the tiles are built: prepare takes it, and each prepare reads the current
    // omitNodes(frame). The draw never took it (the composer's draw has no omission), so it is not passed there.
    // A live-only overlay admits its parts at the view they are drawn at (its live runs are baked at prepare, and only tiles take
    // the draw-time shift), so its offset is applied here as well as at draw; the draw keeps the same shift, so both agree.
    // False only when the composer proves its draw list unchanged; a missing composer or an unknown answer is changed.
    const prepareGpu = (view: ViewState, budget: FrameBudget, frame: PaintSource): boolean => {
        const shift = options.liveOverlay ? options.drawOffset?.(frame) : null;
        const at = shift && (shift.x !== 0 || shift.y !== 0) ? shiftedView(view, shift) : view;
        return gpu?.prepare(at, withFirstUnit(budget), options.omitNodes?.(frame) ?? undefined) !== false;
    };
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
    // One sized waiter for the layer pair's refused CPU reservations: a refusal registers it once, until it fires.
    let capacityWaiting = false;
    const awaitCpu = (bytes: number): void => {
        if (capacityWaiting) return;
        capacityWaiting = true;
        awaitSizedCapacity(allocatorHost, () => { capacityWaiting = false; allocatorHost?.invalidate('board-memory'); }, { pool: 'cpu', bytes });
    };
    let memoryRetry: ReturnType<typeof setTimeout> | null = null;
    // The first prepare after a hide drops the session bitmaps the returned view cannot draw, before it plans.
    let returnedFromHide = false;
    const replacementAsked = new WeakSet<PaintSource>();
    let presented: PaintSource | null = null, presentedOmit: ReadonlySet<string> | null = null, presentedInk: ReadonlySet<string> | null = null;
    let ackFrame: PaintSource | null = null, ackOmit: ReadonlySet<string> | null = null, ackInk: ReadonlySet<string> | null = null, ackMask = 0;
    let ackToken: RenderToken | null = null, ackContext: ViewerPaintPresentation | null = null;
    let presentedContext: ViewerPaintPresentation | null = null;
    // What the last presented frame drew beyond its context: the live set and the draw version (both read at draw time).
    let presentedLive: ReadonlySet<string> | undefined, presentedDrawVersion = -1;
    // The layer's answer for the frame it prepared: true only when every input to the draw matches the presented frame.
    let prepareUnchanged = false;
    // The source whose reference paths the device route built last: a camera-only frame of it builds nothing.
    let directBuiltFor: PaintSource | null = null;
    // Two-phase prepare (Layer.twoPhase): the foreground call of frame `foregroundFrame` leaves the frame it prepared in `pendingFrame`
    // for the background call of the same frame, which completes it and sets the answer.
    let foregroundFrame = -1;
    let pendingFrame: PaintSource | null = null;
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
    // A refusal whose size its thrower did not report (the device and arena errors carry none) waits on each pool once: one
    // waiter per pool until that pool fires. A waiter per refusal would pile up for as long as a stall lasts, one per frame.
    // The latch belongs to the owner host it was set on. A waiter on a disposed owner may never fire (a closed cache drops it), so
    // a new owner starts with no latch, and an old owner's callback never clears the new owner's flag.
    const refusalWaiting: { owner: LayerHost | null; cpu: boolean; gpu: boolean } = { owner: null, cpu: false, gpu: false };
    const awaitRefusal = (): void => {
        const owner = activeHost();
        if (!owner) return;
        if (refusalWaiting.owner !== owner) { refusalWaiting.owner = owner; refusalWaiting.cpu = false; refusalWaiting.gpu = false; }
        for (const pool of ['cpu', 'gpu'] as const) {
            const allocator = owner.allocator[pool];
            if (refusalWaiting[pool] || !allocator.whenAvailable) continue;
            refusalWaiting[pool] = true;
            allocator.whenAvailable(() => {
                if (refusalWaiting.owner === owner) refusalWaiting[pool] = false;
                for (const host of hosts.values()) host.invalidate('board-capacity');
            });
        }
    };
    const report = (error: unknown) => {
        if (isBudgetRefusal(error)) { awaitRefusal(); return; }
        lastError = messageOf(error); refreshProgress();
        // On a device route the error belongs to the pane's GPU error channel (it may demote the route); canvas2d keeps onError.
        try { if (allocatorHost?.device()) allocatorHost.reportGpuError(error); else options.onError(error); }
        catch { /* reporting cannot reject a worker callback */ }
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
    // frame has moved on, or a drawn image is neither a live ImageBitmap nor a VideoFrame) has no hold, so its facts stay unknown.
    // The image walk of one prepared snapshot, per omitted set. A draw repeats both until the snapshot changes, so the walk
    // runs once for them; each draw still takes its own borrow, so the hold's lifetime stays per draw. Keyed weakly: an entry
    // lives only as long as the snapshot it describes.
    const imageWalks = new WeakMap<object, { omit: ReadonlySet<string> | null; images: readonly PresentedImage[] }>();
    const captureDraw = (frame: PaintSource, omit: ReadonlySet<string> | null): DrawHold | null => {
        const borrow = adapter?.retainPrepared() ?? null;
        if (!borrow) return null;
        const { prepared } = borrow;
        const source = prepared.sourceFrame;
        let usable = source.sceneRevision === frame.sceneRevision && sameToken(source.token, frame.token);
        let images: readonly PresentedImage[] = NO_IMAGES;
        if (usable) {
            const walked = imageWalks.get(prepared);
            if (walked && walked.omit === omit) images = walked.images;
            else {
                const found: PresentedImage[] = [];
                try {
                    // Windows are walked in canonical order, one bounded window at a time.
                    windows: for (const window of prepared.windows) {
                        for (const item of window.items) {
                            if (item.kind !== 'image' || omit?.has(item.nodeId)) continue;
                            // A standin draws a crop with no quad to classify: it gets no facts, so the embed keeps its poster.
                            if (prepared.resources.imageCrop?.(item.imageKey)) continue;
                            const bitmap = prepared.resources.image(item.imageKey);
                            // A video frame draws like a bitmap (drawImage takes both) but has no readback for the image facts: it
                            // is drawn without an entry, so its facts stay unknown (embedPresentationFacts) while the draw stays usable.
                            if (bitmap instanceof VideoFrame) continue;
                            if (!(bitmap instanceof ImageBitmap)) { usable = false; break windows; }
                            found.push({ nodeId: item.nodeId, item, source: bitmap });
                        }
                    }
                } catch { usable = false; }
                if (usable) {
                    images = Object.freeze(found);
                    imageWalks.set(prepared, { omit, images });
                }
            }
        }
        if (!usable) { borrow.release(); return null; }
        return { frame: source, images, borrow };
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
    // The presented picture lives on a device or tile set that is being released; forget it and every input its unchanged answer
    // compares, so the next prepare answers changed until a new picture is presented.
    const forgetPresented = (): void => {
        presented = null; presentedOmit = null; presentedInk = null; presentedContext = null; presentedLive = undefined; presentedDrawVersion = -1;
        refreshProgress();
    };
    const clearResources = (reason: GpuReleaseReason) => {
        discardHolds();
        if (reason === 'context-lost') forgetPresented();
        // The reference adapter keeps CPU paths on context loss; this owner must
        // explicitly evict them before returning its CPU leases for any release.
        gpu?.release(reason);
        direct?.release(reason === 'context-lost' ? 'pressure' : reason);
        dense?.release(reason);
        for (const frame of [...reservations.keys()]) releaseFrame(frame);
        estimate = null; denied = false; deniedDirectSegments = null; lastPrepareFrame = null; drawn.clear(); drawTokens = new WeakMap(); announced = new WeakMap(); drawSource = null; prepareToken = null; prepareFrameId = -1;
        ackFrame = null; ackOmit = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; presentedInk = null;
        if (reason === 'hidden') {
            const wasDense = useDense;
            deferredClear = true; collectRetired(); presented = null; presentedContext = null; refreshProgress();
            density.reset(); useDense = false; returnedFromHide = true;
            // The owner's density mode outlives a hide: a board that returns direct must say so, or its owner keeps asking
            // for live-only frames this board cannot take (by reading: dense-coupling note, the hide-while-dense item).
            if (wasDense) options.onDensityMode?.('direct');
        }
    };
    /** The dense tile adapter, built the first time the board enters dense mode. A device never enters it (its direct paint
     * is the GPU composer's), so no CPU tile path is constructed there. */
    const ensureDense = (): ReturnType<typeof createDensePaintAdapter> => {
        if (!dense) dense = createDensePaintAdapter(denseResources!, allocatorHost!, report, memoryGate);
        return dense;
    };
    const ensureAdapter = (host: LayerHost): CanvasPaintAdapter => {
        if (!adapter) {
            allocatorHost = host;
            options.frames.bindMemory?.(host.allocator.cpu);
            const resources = { frames: options.frames, images: options.images,
                invalidate: () => { collectRetired(); activeHost()?.invalidate('board-resource'); } };
            direct = createCanvasPaintAdapter(resources,
                (ctx, view, paint) => { const owner = activeHost(); if (!owner) throw new Error('Board layer is detached'); owner.paintWorld(ctx, view, paint); }, report);
            denseResources = resources;
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
                release: reason => { directBuiltFor = null; direct!.release(reason); dense?.release(reason); },
                needsFrame: () => current().needsFrame(), memory: () => current().memory(),
                dispose: () => { direct!.dispose(); dense?.dispose(); },
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
                auditCount(options.auditSurface ?? 'board', 'direct:charge-refused');
                allocatorHost!.demandChanged?.();
                awaitCpu(DIRECT_CHUNK);
                return false;
            }
            memoryGate.admitted();
            leases.push(lease); reserved += lease.bytes; held += lease.bytes;
        }
        denied = false; return true;
    };
    // Returns nothing on every path, which the Layer contract reads as changed: the composer's prepare reports nothing, and no
    // path here proves the band's picture unchanged from the last presented frame (the view, the frame and the composer's
    // settled state are not compared).
    // The draw inputs that a change would alter without a composer change (a drag's offset or draw version, the live set) and the
    // presented frame's view, omission and frame. Any difference, or no presented frame, is changed.
    const unchangedSincePresented = (view: ViewState, budget: FrameBudget, frame: PaintSource): boolean => {
        const context = presentedContext, host = activeHost();
        if (!context || !host || presented !== frame || !options.frames.isCurrent(frame)) return false;
        if (frame.sceneRevision !== options.requestedRevision() || frame.theme !== options.requestedTheme()) return false;
        if (!sameView(context.view, view) || !sameTransform(context.paneTransform, host.paneTransform(view, budget.frameId))) return false;
        if (!sameOmission(context.omittedNodeIds, omittedOf(options.omitNodes?.(frame) ?? null))) return false;
        const offset = options.drawOffset?.(frame);
        if (offset && (offset.x !== 0 || offset.y !== 0)) return false;
        if ((options.drawVersion?.() ?? 0) !== presentedDrawVersion || liveFor(frame) !== presentedLive) return false;
        return true;
    };
    // The background call of a two-phase frame: the composer's background part, then what the foreground call left (the charge, the prune,
    // the answer). A background call with no foreground of its frame answers changed.
    const finishBackground = (view: ViewState, budget: FrameBudget): void => {
        const frame = pendingFrame;
        pendingFrame = null;
        if (!frame || foregroundFrame !== budget.frameId || !adapter || disposed) { prepareUnchanged = false; return; }
        foregroundFrame = -1;
        try {
            const composerChanged = prepareGpu(view, budget, frame);
            if (onDeviceRoute) {
                const charged = chargeDirect(frame);
                prepareUnchanged = charged && !composerChanged && unchangedSincePresented(view, budget, frame);
            } else prepareUnchanged = false;
            prune(frame, adapter.readyFrame());
            options.onPrepared?.();
        } catch (error) { prepareUnchanged = false; report(error); }
        finally { refreshProgress(); }
    };
    // Returns nothing on every path it does not prove unchanged; the layer's answer is read from prepareUnchanged. The foreground call
    // (budget.phase 'foreground') stops after the composer's foreground part and leaves the frame for the background call.
    const prepareFrame = (view: ViewState, budget: FrameBudget): void => {
        if (budget.phase === 'background') { finishBackground(view, budget); return; }
        if (!adapter || disposed) { prepareUnchanged = false; return; }
        if (lastPrepareFrame === budget.frameId) return;
        prepareUnchanged = false;
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
                    dense?.release('pressure');
                    allocatorHost!.invalidate('board-density-demand-ready');
                    options.onDensityMode?.('direct');
                    return;
                }
                if (frame.liveOnly) {
                    if (!replacementAsked.has(frame)) { replacementAsked.add(frame); options.requestFrame?.(); }
                    return;
                }
                known.add(frame);
                // The reference's CPU paths are the composer's input, so they are built once per source. While a refused charge's
                // back-off runs, a source that has no paths yet waits for the wake (one attempt per wake); a camera-only frame reuses
                // the paths built for its source, and the GPU composer prepares at the new camera either way (a refused charge never
                // stopped it: 85 of 94 device prepares were refused before this, measured). The build is charged after it, as held bytes.
                // While a refused charge's back-off runs, a new source is not built: the paths built for the previous source stay bound
                // and the composer still prepares, at the new camera, from them, so the previous band keeps drawing under the live
                // camera until the new one is built (the wake). Without this the composer did not prepare, and the draw-list guard
                // drew nothing for the frame.
                if (directBuiltFor !== frame && !memoryGate.closed()) {
                    adapter.prepare(view, budget);
                    directBuiltFor = frame;
                } else if (directBuiltFor !== frame) auditCount(options.auditSurface ?? 'board', 'direct:build-held');
                if (directBuiltFor !== frame) prepareUnchanged = false;
                const composerChanged = prepareGpu(view, budget, frame);
                if (budget.phase === 'foreground') { pendingFrame = frame; foregroundFrame = budget.frameId; return; }
                // A refused charge leaves the build unheld: the frame then answers changed, never unchanged.
                const charged = chargeDirect(frame);
                prune(frame, adapter.readyFrame());
                prepareUnchanged = charged && !composerChanged && unchangedSincePresented(view, budget, frame);
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
            // One step is always admitted: under a zero slice the estimate never advances, and it re-invalidates forever.
            const estimateBudget = withFirstUnit(budget);
            while (!estimate!.done && !estimateBudget.shouldYield()) estimateStep(estimate!);
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
            const mode = dense?.gaveUp(frame) ? 'direct' : useDense && frame.liveOnly && deniedDirectSegments !== null ? 'dense'
                : frame.openTile ? (deniedDirectSegments !== null ? 'dense' : observed) : 'direct';
            if ((mode === 'dense') !== useDense) {
                useDense = mode === 'dense';
                denied = false;
                // The dense working set (kept bitmaps, tile runs) is declared only in dense mode: the pane re-collects its demand.
                allocatorHost?.demandChanged?.();
                if (useDense) {
                    direct!.release('pressure');
                    ensureDense();
                    for (const old of [...reservations.keys()]) releaseFrame(old);
                } else dense?.release('pressure');
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
                        awaitCpu(bytes);
                        return;
                    }
                    memoryGate.admitted();
                    reservations.set(frame, [lease]); reserved += lease.bytes;
                } else reservations.set(frame, []);
            }
            denied = false;
            adapter.prepare(view, budget);
            prepareGpu(view, budget, frame);
            if (budget.phase === 'foreground') { pendingFrame = frame; foregroundFrame = budget.frameId; return; }
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
            presentedLive = liveFor(frame); presentedDrawVersion = options.drawVersion?.() ?? 0;
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
    // A presented frame older than the latest revision is still the picture the band draws when every node that changed since
    // it is one the band does not draw: the omitted nodes (a drag's moving node, drawn by the preview) and the live ones (drawn
    // by their live layer). A drag moves only those, so its base picture stays current (measured: stale:revision on 186 of 186
    // drag-sat frames). Unknown history (null, or a structural change) is stale.
    // The node ids a presented base picture holds (its items' nodes and its ink ids), built once per picture.
    const heldNodesOf = new WeakMap<object, ReadonlySet<string>>();
    const nodesHeldBy = (base: PaintSource): ReadonlySet<string> => {
        const known = heldNodesOf.get(base); if (known) return known;
        const held = new Set<string>(base.inkNodeIds);
        const lists = base as { underlay?: readonly { nodeId?: string }[]; content?: readonly { nodeId?: string }[] };
        for (const list of [lists.underlay, lists.content]) if (list) for (const item of list) if (item.nodeId) held.add(item.nodeId);
        heldNodesOf.set(base, held); return held;
    };
    const undrawnChangeSince = (from: number, to: number, band: PaintBand, view: ViewState, canvas: boolean, base: PaintSource): boolean => {
        // The live scene history first (it names the revisions a frame lags behind); the pinned frame's own history when the
        // live one is not retained for this span.
        const now = options.frames.readFrame();
        const changed = options.changedNodesSince?.(from, to) ?? (now && now.sceneRevision === to ? now.changedNodesSince?.(from) : null);
        if (!changed) return false;
        const omitted = now ? options.omitNodes?.(now) ?? null : null;
        // The live parts the next prepare plans are drawn live in this frame: coverage runs after prepare in the same frame (d14a4dfa),
        // so the plan is this frame's own, and the draw-time set would be one composite late.
        const laid = canvas ? null : gpu?.plannedLiveNodeIds(band) ?? null;
        // A changed node is current in a stale picture only when the picture does not show it (omitted, or created after the picture)
        // and a live layer drew it at the latest revision (the wet layer this frame, or the overlay's report). A node the picture
        // holds with an old copy (a move) stays stale: covering it would show the old copy as current.
        const overlay = options.overlayDrawn?.() ?? null;
        const held = nodesHeldBy(base);
        for (const id of changed) {
            const live = options.liveDraws?.(id, band, view, canvas) || !!laid?.has(id) ||
                (overlay !== null && overlay.sceneRevision >= to && overlay.nodes.has(id));
            if (!live) return false;
            if (!omitted?.has(id) && held.has(id)) return false;
        }
        return true;
    };
    const coverageOf = (band: PaintBand, frame: ScheduledFrame, backend: CompositorBackend): LayerCoverage => {
        const gpuCoverage = backend !== 'canvas2d' ? gpu?.coverage(frame.view) : null;
        const ready = backend === 'canvas2d' ? adapter?.readyFrame() : gpu?.readyFrame();
        const denseCoverage = useDense && ready ? dense?.coverage(frame.view, liveFor(ready)) : null;
        if (useDense && !denseCoverage?.complete) return INCOMPLETE;
        if (backend !== 'canvas2d' && !gpuCoverage?.complete) return INCOMPLETE;
        if (!ready || !sameToken(ready.token, frame.token)) return INCOMPLETE;
        const latest = options.requestedRevision();
        // The picture drawn is current at the latest revision, whatever revision this layer's frame was scheduled for (a preview
        // band's scheduled frame lags the drag's moves while its picture is already the latest: measured 62 of 62 as stale).
        const current = (ready.sceneRevision === latest || undrawnChangeSince(ready.sceneRevision, latest, band, frame.view, backend === 'canvas2d', ready))
            && ready.theme === options.requestedTheme() && options.frames.isCurrent(ready);
        return current ? { complete: true, sharp: (gpuCoverage?.sharp ?? true) && (denseCoverage?.sharp ?? true) } : STALE;
    };
    // The GPU working set a band reports: only the band that owns the adapter reports it, so one adapter is counted once for the
    // pair (the rule evictGpu follows). A spread, not a literal member, until the platform type carries gpuWorkingSet (h9).
    const gpuWorkingSetFor = (band: PaintBand) => ({
        gpuWorkingSet: (_layer: Layer, viewport: Readonly<{ width: number; height: number }>) => ({
            mandatoryBytes: hosts.get(band) === allocatorHost ? (gpu as GpuWorkingSetReporter | null)?.gpuMandatoryBytes?.(viewport) ?? 0 : 0,
        }),
    });
    /** The owning band's CPU bytes now: the direct charge, the dense plan, the device scratch and the frame's own. */
    const cpuMandatory = (): number => {
        const upcoming = !useDense && estimate?.done && !density.pending() && !reservations.has(estimate.frame) ? estimate.bytes : 0;
        const scratch = allocatorHost?.device() ? gpu?.cpuWorkingSet().mandatoryBytes ?? 0 : 0;
        return reserved + upcoming + scratch + (useDense ? dense?.cpuWorkingSet(estimate?.maxItemBytes ?? 0) ?? 0 : 0) + (options.frames.cpuWorkingSet?.() ?? 0);
    };
    const definition = (band: PaintBand): PlatformLayerDefinition => ({
        id: `board-${band}`, group: 'document', ...gpuWorkingSetFor(band),
        create(host) {
            if (disposed || hosts.has(band)) throw new Error('Board layer already attached');
            hosts.set(band, host); ensureAdapter(host);
            let ended = false;
            const layer: Layer & LayerEvicting = {
                // false only when the composer and the draw inputs all match the presented frame (see unchangedSincePresented). The
                // foreground call answers false: the frame's answer is the background call's.
                twoPhase: true,
                prepare: (view: ViewState, budget: FrameBudget): boolean | void => {
                    prepareFrame(view, budget);
                    return budget.phase === 'foreground' || prepareUnchanged ? false : true;
                },
                drawGpu(pass, view) {
                    const frame = gpu?.readyFrame();
                    if (!frame || !drawable(frame)) return;
                    const omit = options.omitNodes?.(frame) ?? null;
                    const shift = drawnOffset(frame, useDense); if (shift === undefined) return;
                    const ink = gpu!.readyInkNodeIds() ?? frame.inkNodeIds;
                    if (!prepareToken) return;
                    const actualView = copyView(view);
                    gpu!.drawGpu(pass, shift ? shiftedView(view, shift) : view, band);
                    // Borrowed right after the draw read its snapshot, before anything else can move the adapter on.
                    const hold = captureDraw(frame, omit);
                    const context = Object.freeze({ view: actualView, frameId: prepareFrameId,
                        paneTransform: host.paneTransform(actualView, prepareFrameId),
                        token: Object.freeze({ ...prepareToken }), omittedNodeIds: omittedOf(omit),
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
                        token: Object.freeze({ ...prepareToken }), omittedNodeIds: omittedOf(omit),
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
                // The work progressNow counts, so a board with nothing left to compose asks for no frame. An idle ancestor
                // pass is not work the board waits on, and the composer's needs belong to the active host alone.
                needsFrame() {
                    const idleOnly = useDense && !!dense?.idleOnly();
                    return !disposed && !ended && (options.frames.needsFrame() || (!denied && (!!estimate && !estimate.done || density.pending()
                        || (!idleOnly && !!adapter?.needsFrame()) || !!activeHost()?.device() && !!gpu?.needsFrame())));
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
                        // A route change: the surviving band's adapter replaces the released one, so the old presented picture goes too.
                        forgetPresented();
                        allocatorHost = activeHost()!;
                        options.frames.bindMemory?.(allocatorHost.allocator.cpu);
                        const oldDense = dense; dense = null;
                        if (oldDense) { oldDense.dispose(); retiringDense.add(oldDense); }
                        if (useDense) ensureDense();
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
            if (hosts.get(band) !== allocatorHost) return;
            dense?.reclaim(bytes);
            // The device's CPU bytes are the direct build's and the GPU composer's scratch: the adapter gives back what it holds.
            const adapter = gpu as CpuEvicting | null;
            if (typeof adapter?.evictCpu === 'function') adapter.evictCpu(bytes);
        },
        cpuWorkingSet() {
            return { mandatoryBytes: hosts.get(band) === allocatorHost ? cpuMandatory() : 0, prefetchBytes: 0 };
        },
        // Critical (its missing positions refuse the frame) only while the board has nothing drawable at all: no presented
        // frame and no prepared tile to stand in. Anything drawable makes it non-critical, so a large board whose coverage is
        // never complete still presents its stand-ins (measured: 129 refusals, 0 presents, all from incomplete coverage).
        // A layer waiting on a refused GPU admission defers instead: holding every frame for memory the governor has not freed
        // froze the pane (a board whose ink tile could not be admitted refused every frame, and nothing requested another).
        // A draw list that cannot be drawn for this frame's view is critical too: the compositor then refuses the frame and keeps the
        // previous complete picture, instead of presenting the board with its draws skipped.
        critical(_layer, view) { return (presented === null && !adapter?.readyFrame() && !gpu?.readyFrame() && !gpu?.memoryBlocked()) || !!gpu?.listInvalid(view); },
        coverage(layer, frame, backend) {
            // An optional layer with no request has nothing to draw: the platform reads it complete, and so does the audit.
            if (options.optional && options.requested && !options.requested()) return { complete: true, sharp: true };
            const actual = coverageOf(band, frame, backend);
            // What the board draws besides the current picture, for the present audit: a previous frame or a scaled tile is a
            // stand-in; nothing drawable at all is a hole. Both bands read the same composer and adapter, so their coverage is one
            // state: it is reported once per frame, from the underlay band, not once per band.
            if (band === 'underlay' && (!actual.complete || !actual.sharp)) auditDrawn(!actual.complete && presented === null ? 'hole' : 'stand-in');
            return options.optional && !actual.complete ? { complete: true, sharp: true } : actual;
        },
    });
    const pair = [definition('underlay'), definition('content')] as unknown as BoardLayerPair;
    pair.invalidate = (reason = 'board-content') => { for (const host of hosts.values()) host.invalidate(reason); };
    pair.drawnInkNodeIds = () => (gpu as DrawnInkReporter | null)?.drawnInkNodeIds?.() ?? NO_INK;
    pair.drawnLiveNodeIds = () => {
        const reporter = gpu as DrawnLiveReporter | null;
        if (!reporter?.drawnLiveNodeIds) return NO_INK;
        const under = reporter.drawnLiveNodeIds('underlay'), content = reporter.drawnLiveNodeIds('content');
        if (!under.size && !content.size) return NO_INK;
        return new Set([...under, ...content]);
    };
    pair.onDevice = () => !!activeHost()?.device();
    pair.cpuMandatoryBytes = cpuMandatory;
    // Typeof-guarded: an allocator that does not report a grant reads as 0 (none known).
    pair.cpuGrantBytes = () => (allocatorHost?.allocator as (LayerHost['allocator'] & { cpuGrantBytes?(): number }) | null)?.cpuGrantBytes?.() ?? 0;
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
