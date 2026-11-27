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
import { presentedScene } from './sceneAudit';
import { paintItemsOf } from './paintWindows';
import type { PaintImageProvider } from './resources';
import { createCanvasPaintAdapter, type CanvasPaintAdapter, type PreparedPaint2d, type PreparedRetain } from './reference/canvasPaintAdapter';
import { createGpuPaintAdapter } from './gpuPaintAdapter';
import type { GeometryPins } from './gpu/tileComposer';
import { auditCount, auditDrawn, auditTape, renderAuditEnabled } from '../../platform/render/renderAudit';
import { createDensePaintAdapter } from './densePlan';
import { MEMORY_RETRY_MIN_MS, MemoryRetryGate } from './memoryRetryGate';
import { DensityController, type DensityMode } from './density';
import { FilteredInk, LiveNodeUnion } from './nodeSets';
import type { PresentedImage, PresentedImageLease, ViewerPaintPresentation } from './paintPresentation';

export const BOARD_BACKEND_PREFERENCE = 'auto' as const;
export type PaintProgress = { readonly kind: 'current' } | { readonly kind: 'pending'; readonly reason: 'building' | 'waiting-memory'; readonly drawn: boolean }
    | { readonly kind: 'failed'; readonly message: string };
function sameProgress(a: PaintProgress, b: PaintProgress): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export interface BoardLayersOptions {
    readonly frames: PaintFrameAssembler;
    readonly images: PaintImageProvider;
    readonly onError: (error: unknown) => void;
    readonly onPaintProgress?: () => void;
    readonly requestedRevision: () => number;
    readonly changedNodesSince?: (from: number, to: number) => ReadonlySet<string> | null;
    readonly requestedTheme: () => 'light' | 'dark';
    readonly omitNodes?: (frame: PaintSource) => ReadonlySet<string> | null;
    readonly liveNodeIds?: () => ReadonlySet<string> | undefined;
    readonly inputActive?: () => boolean;
    readonly liveDraws?: (nodeId: string, band: PaintBand, view: ViewState, canvas: boolean) => boolean;
    readonly overlayDrawn?: () => { readonly sceneRevision: number; readonly nodes: ReadonlySet<string> } | null;
    readonly beforePrepare?: (view: ViewState, budget: FrameBudget) => void;
    readonly onPresented?: (revision: number, token: RenderToken, frame: PaintSource, context?: ViewerPaintPresentation) => void;
    readonly onPrepared?: () => void;
    readonly drawOffset?: (frame: PaintSource) => Readonly<{ x: number; y: number }>;
    readonly drawVersion?: () => number;
    readonly onOffsetUnsupported?: () => void;
    readonly onDrawn?: (revision: number, frame: PaintSource, context: ViewerPaintPresentation) => void;
    readonly candidates?: () => number | null;
    readonly onDensityMode?: (mode: DensityMode) => void;
    readonly requestFrame?: () => void;
    readonly auditSurface?: string;
    readonly optional?: boolean;
    readonly opaqueWorld?: () => readonly Rect[];
    readonly liveNodes?: ReadonlySet<string>;
    readonly geometryPins?: GeometryPins;
    readonly liveOverlay?: boolean;
    readonly requested?: () => boolean;
}
const WHOLE_PLANE: readonly Rect[] = Object.freeze([Object.freeze({ x: -1e12, y: -1e12, width: 2e12, height: 2e12 })]);
export function opaqueWorldOf(host: HostBlock, inverted: boolean, drawnPages?: readonly Rect[]): readonly Rect[] {
    if (host.kind === 'whiteboard') return inverted ? [] : WHOLE_PLANE;
    return drawnPages ?? [];
}
const NO_RECTS: readonly Rect[] = Object.freeze([]);
const NO_IMAGES: readonly PresentedImage[] = Object.freeze([]);
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
    readonly walk: Generator<PaintItem>;
    current: PaintItem | null;
    clip: number;
    chunk: number;
    bytes: number;
    itemBytes: number;
    maxItemBytes: number;
    segments: number;
    items: number;
    done: boolean;
}
export function sameToken(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId
        && a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}
function copyView(view: ViewState): ViewState {
    return Object.freeze({ ...view, camera: Object.freeze({ ...view.camera }), viewport: Object.freeze({ ...view.viewport }) });
}
function shiftedView(view: ViewState, offset: Readonly<{ x: number; y: number }>): ViewState {
    return Object.freeze({ ...view, camera: Object.freeze({ ...view.camera, x: view.camera.x - offset.x, y: view.camera.y - offset.y }) });
}
const omittedSnapshots = new WeakMap<ReadonlySet<string>, OmittedSnapshot>();
function omittedOf(omit: ReadonlySet<string> | null): OmittedSnapshot | null {
    if (!omit) return null;
    let snapshot = omittedSnapshots.get(omit);
    if (!snapshot) { snapshot = new OmittedSnapshot(omit); omittedSnapshots.set(omit, snapshot); }
    return snapshot;
}
function sameCameraView(a: ViewState, b: ViewState): boolean {
    return a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
        && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.viewport.dpr === b.viewport.dpr;
}
function sameView(a: ViewState | null | undefined, b: ViewState): boolean {
    return !!a && a.epoch === b.epoch && a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
        && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.viewport.dpr === b.viewport.dpr;
}
/** The same picture's view: camera and viewport, not the epoch. The epoch also moves when the moving flag flips at a gesture's end with
 * the camera still, and the scheduler skips that frame as unchanged (no layer presents it): compared by epoch, the board never saw its
 * view presented and showed 'Updating' at rest for good (measured, kinds sweep: hand-pan, lasso, marquee, lock, rotate, resize on WebGL2,
 * board pending on showsView alone). */
function samePictureView(a: ViewState | null | undefined, b: ViewState): boolean {
    return !!a && a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.z === b.camera.z
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
            const coverage = chunks[state.chunk++];
            const primitives = coverage.segments.length / 6 + coverage.discs.length / 3;
            state.segments += primitives;
            addBytes(state, primitives * 40 * 80);
            return;
        }
    } else if (item.kind === 'path') { addBytes(state, item.d.length * 80); state.segments += item.d.length; }
    state.items++; state.maxItemBytes = Math.max(state.maxItemBytes, state.itemBytes); state.itemBytes = 0;
    state.current = null; state.clip = 0; state.chunk = 0;
}

export interface BoardLayerPair extends Readonly<[PlatformLayerDefinition, PlatformLayerDefinition]> {
    invalidate(reason?: string): void;
    drawnInkNodeIds(): ReadonlySet<string>;
    drawnLiveNodeIds(): ReadonlySet<string>;
    plannedLiveNodeIds(): ReadonlySet<string>;
    onDevice(): boolean;
    cpuMandatoryBytes(): number;
    cpuGrantBytes(): number;
    wakeAt(deadlineMs: number | null): void;
    readyFrame(): PaintSource | null;
    paintProgress(): PaintProgress;
    memory(): MemoryAllocator | null;
}
type OffscreenEncoder = { encodeOffscreen?(passes: OffscreenPasses, view: ViewState, band: PaintBand): void; offscreenSettled?(submitted: boolean): void };
type GpuEvicting = { evictGpu?(bytes: number, frameId: number): number };
type LayerEvicting = { evictGpu?(bytes: number, frameId: number): number };
type EmptyReporting = { drewNothing(): boolean };
type GpuProtecting = { protectFrame?(frameId: number, view: ViewState): void };
type CpuEvicting = { evictCpu?(bytes: number): number };
const DIRECT_CHUNK = 64 * 1024;
const INCOMPLETE: LayerCoverage = Object.freeze({ complete: false, sharp: false });
const COMPLETE: LayerCoverage = Object.freeze({ complete: true, sharp: true });
const NO_INK: ReadonlySet<string> = Object.freeze(new Set<string>());
type DrawnInkReporter = { drawnInkNodeIds?(): ReadonlySet<string> };
type DrawnLiveReporter = { drawnLiveNodeIds?(band: PaintBand): ReadonlySet<string> };
type GpuWorkingSetReporter = { gpuMandatoryBytes?(viewport: Readonly<{ width: number; height: number }>): number };

const STALE: LayerCoverage = Object.freeze({ complete: false, sharp: false, staleVersion: true });
export function createBoardLayers(options: BoardLayersOptions): BoardLayerPair {
    const hosts = new Map<PaintBand, LayerHost>();
    let adapter: CanvasPaintAdapter | null = null, allocatorHost: LayerHost | null = null;
    let gpu: ReturnType<typeof createGpuPaintAdapter> | null = null;
    let direct: CanvasPaintAdapter | null = null, dense: ReturnType<typeof createDensePaintAdapter> | null = null;
    let denseResources: Parameters<typeof createDensePaintAdapter>[0] | null = null;
    const retiringDense = new Set<ReturnType<typeof createDensePaintAdapter>>();
    const density = new DensityController();
    let useDense = false, deferredClear = false;
    let onDeviceRoute = false;
    const drewNothing: Record<PaintBand, boolean> = { underlay: false, content: false };
    const gpuOptions = () => ({ audit: options.auditSurface ?? 'board', ...(options.liveOverlay ? { liveOverlay: true } : {}),
        ...(typeof options.opaqueWorld === 'function' ? { opaqueWorld: options.opaqueWorld } : {}),
        ...(options.liveNodes ? { liveNodes: options.liveNodes } : {}), ...(options.geometryPins ? { pins: options.geometryPins } : {}),
        ...(options.inputActive ? { inputActive: options.inputActive } : {}) });
    let preparedOmit: { frame: PaintSource; omit: ReadonlySet<string> | null } | null = null;
    let drawnOmit2d: { view: ViewState; frame: PaintSource; omit: ReadonlySet<string> | null } | null = null;
    const prepareGpu = (view: ViewState, budget: FrameBudget, frame: PaintSource): boolean => {
        const shift = options.liveOverlay ? options.drawOffset?.(frame) : null;
        const at = shift && (shift.x !== 0 || shift.y !== 0) ? shiftedView(view, shift) : view;
        const omit = options.omitNodes?.(frame) ?? null;
        preparedOmit = { frame, omit };
        return gpu?.prepare(at, withFirstUnit(budget), omit ?? undefined) !== false;
    };
    const liveSets = new WeakMap<PaintSource, { omit: ReadonlySet<string> | null | undefined; wet: ReadonlySet<string> | undefined; live: ReadonlySet<string> }>();
    const liveFor = (frame: PaintSource): ReadonlySet<string> | undefined => {
        const omit = options.omitNodes?.(frame), wet = options.liveNodeIds?.();
        if (!omit?.size && !wet?.size) return frame.sensitiveNodes;
        const old = liveSets.get(frame); if (old && old.omit === omit && old.wet === wet) return old.live;
        const live = new LiveNodeUnion(frame.sensitiveNodes, omit, wet);
        liveSets.set(frame, { omit, wet, live }); return live;
    };
    let deniedDirectSegments: number | null = null;
    let estimate: Estimate | null = null, denied = false, disposed = false, lastPrepareFrame: number | null = null;
    const sceneAudit = presentedScene(`${options.auditSurface ?? 'board'}${options.liveOverlay ? ':live' : ''}`);
    const memoryGate = new MemoryRetryGate();
    let capacityWaiting = false;
    const awaitCpu = (bytes: number): void => {
        if (capacityWaiting) return;
        capacityWaiting = true;
        awaitSizedCapacity(allocatorHost, () => { capacityWaiting = false; allocatorHost?.invalidate('board-memory'); }, { pool: 'cpu', bytes });
    };
    let memoryRetry: ReturnType<typeof setTimeout> | null = null;
    let returnedFromHide = false;
    const replacementAsked = new WeakSet<PaintSource>();
    let presented: PaintSource | null = null, presentedInk: ReadonlySet<string> | null = null;
    let ackFrame: PaintSource | null = null, ackInk: ReadonlySet<string> | null = null, ackMask = 0;
    let ackToken: RenderToken | null = null, ackContext: ViewerPaintPresentation | null = null;
    let presentedContext: ViewerPaintPresentation | null = null;
    let lastDrawn: { context: ViewerPaintPresentation; content: number; drawVersion: number; revision: number; offset: Readonly<{ x: number; y: number }> | null } | null = null;
    type Picture2d = { frameId: number; prepared: PreparedPaint2d | null; frame: PaintSource | null; view: ViewState; transform: Affine | null;
        omit: ReadonlySet<string> | null; offset: Readonly<{ x: number; y: number }> | null; drawVersion: number; current: boolean; holds: boolean;
        requested: boolean; coverage: LayerCoverage | null };
    const drawing2d = new Map<PaintBand, Picture2d>(), shown2d = new Map<PaintBand, Picture2d>();
    const read2d = new Map<PaintBand, { frameId: number; read: LayerCoverage }>();
    let prepareUnchanged = false;
    let directBuiltFor: PaintSource | null = null;
    let foregroundFrame = -1;
    let pendingFrame: PaintSource | null = null;
    let preparedView: ViewState | null = null;
    type Drawn = { frame: PaintSource; omit: ReadonlySet<string> | null; ink: ReadonlySet<string>; context: ViewerPaintPresentation; hold: DrawHold | null };
    const drawn = new Map<PaintBand, Drawn>();
    let drawSource: PaintSource | null = null, prepareToken: FrameToken | null = null, prepareFrameId = -1;
    let drawTokens = new WeakMap<RenderToken, Map<PaintBand, Drawn>>();
    let announced = new WeakMap<RenderToken, { underlay: Drawn; content: Drawn }>();
    const recordDraw = (band: PaintBand, value: Drawn) => {
        if (drawSource !== value.frame) { discardPending(); drawTokens = new WeakMap(); drawSource = value.frame; }
        drawn.set(band, value);
        if (!prepareToken) { if (value.hold) releaseHold(value.hold); return; }
        if (value.hold) pushPending(value.hold);
        let bands = drawTokens.get(prepareToken);
        if (!bands) { bands = new Map(); drawTokens.set(prepareToken, bands); }
        bands.set(band, value);
        const underlay = bands.get('underlay'), content = bands.get('content');
        if (!underlay || !content || underlay.frame !== content.frame || underlay.ink !== content.ink
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
    const truedUp = new WeakSet<PaintSource>();
    let reserved = 0;
    const activeHost = () => hosts.get('underlay') ?? hosts.get('content');
    let lastError: string | null = null, lastProgress: PaintProgress | null = null;
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
        try { if (allocatorHost?.device()) allocatorHost.reportGpuError(error); else options.onError(error); }
        catch { /* reporting cannot reject a worker callback */ }
    };
    const progressNow = (): PaintProgress => {
        if (lastError !== null) return { kind: 'failed', message: lastError };
        const blocked = !!options.frames.blocked?.() || denied || !!dense?.memoryBlocked();
        const idleOnly = useDense && !!dense?.idleOnly();
        const working = !!options.frames.needsFrame() || (!!estimate && !estimate.done) || (!idleOnly && !!adapter?.needsFrame())
            || (!!activeHost()?.device() && (!!gpu?.needsFrame() || !!gpu?.incomplete())) || !!dense?.pending();
        const showsView = !!presentedContext && !!preparedView && samePictureView(presentedContext.view, preparedView) && !options.frames.replacing?.();
        if (!blocked && !working && presented && presented.sceneRevision === options.requestedRevision() && options.frames.isCurrent(presented) && showsView) return { kind: 'current' };
        const drawn = !!presented && presented.sceneRevision === options.requestedRevision() && options.frames.isCurrent(presented);
        return { kind: 'pending', reason: blocked ? 'waiting-memory' : 'building', drawn };
    };
    const armMemoryRetry = (waiting: boolean) => {
        if (!waiting || disposed) {
            if (memoryRetry !== null) { clearTimeout(memoryRetry); memoryRetry = null; }
            if (!waiting) memoryGate.admitted();
            return;
        }
        if (memoryRetry !== null) return;
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
    interface DrawHold { readonly frame: PaintSource; readonly images: readonly PresentedImage[]; borrow: PreparedRetain | null }
    let pendingHolds: DrawHold[] = [], presentedHolds: DrawHold[] = [];
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
    const acceptHolds = (accepted: readonly (DrawHold | null)[]) => {
        const kept = accepted.filter((hold): hold is DrawHold => hold !== null);
        const last = Math.max(-1, ...kept.map(hold => pendingHolds.indexOf(hold)));
        const pending = pendingHolds;
        pendingHolds = pending.filter((_, index) => index > last);
        for (const hold of pending.slice(0, last + 1)) if (!kept.includes(hold)) releaseHold(hold);
        const old = presentedHolds; presentedHolds = kept;
        for (const hold of old) if (!kept.includes(hold)) releaseHold(hold);
    };
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
                    windows: for (const window of prepared.windows) {
                        for (const item of window.items) {
                            if (item.kind !== 'image' || omit?.has(item.nodeId)) continue;
                            if (prepared.resources.imageCrop?.(item.imageKey)) continue;
                            let bitmap: ReturnType<typeof prepared.resources.image>;
                            try { bitmap = prepared.resources.image(item.imageKey); }
                            catch { if (renderAuditEnabled()) auditCount('embed', 'hold:image-released'); continue; }
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
    const forgetPresented = (): void => {
        presented = null; presentedInk = null; presentedContext = null;
        lastDrawn = null; drawing2d.clear(); shown2d.clear(); read2d.clear();
        refreshProgress();
    };
    const clearResources = (reason: GpuReleaseReason) => {
        discardHolds();
        if (reason === 'context-lost' || reason === 'hidden') forgetPresented();
        // The reference adapter keeps CPU paths on context loss; this owner must
        // explicitly evict them before returning its CPU leases for any release.
        gpu?.release(reason);
        direct?.release(reason === 'context-lost' ? 'pressure' : reason);
        dense?.release(reason);
        for (const frame of [...reservations.keys()]) releaseFrame(frame);
        estimate = null; denied = false; deniedDirectSegments = null; lastPrepareFrame = null; preparedOmit = null; drawnOmit2d = null; drawn.clear(); drawTokens = new WeakMap(); announced = new WeakMap(); drawSource = null; prepareToken = null; prepareFrameId = -1;
        ackFrame = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; presentedInk = null;
        if (reason === 'hidden') {
            const wasDense = useDense;
            directBuiltFor = null; pendingFrame = null; foregroundFrame = -1;
            deferredClear = true; collectRetired(); presented = null; presentedContext = null; sceneAudit.forget(); refreshProgress();
            density.reset(); useDense = false; returnedFromHide = true;
            if (wasDense) options.onDensityMode?.('direct');
        }
    };
    const ensureDense = (): ReturnType<typeof createDensePaintAdapter> => {
        if (!dense) dense = createDensePaintAdapter(denseResources!, allocatorHost!, report, memoryGate);
        return dense;
    };
    let gpuBoundHost: LayerHost | null = null;
    const ensureAdapter = (host: LayerHost): CanvasPaintAdapter => {
        if (!adapter) {
            allocatorHost = host;
            options.frames.bindMemory?.(host.allocator.cpu);
            const resources = { frames: options.frames, images: options.images,
                invalidate: () => { collectRetired(); activeHost()?.invalidate('board-resource'); },
                wakeAt: (deadlineMs: number | null) => activeHost()?.wakeAt(deadlineMs), replan: () => options.requestFrame?.(),
                textureHeld: (key: string) => !useDense && !!gpu && gpu.textureHeld(key) };
            direct = createCanvasPaintAdapter(resources,
                (ctx, view, paint) => { const owner = activeHost(); if (!owner) throw new Error('Board layer is detached'); owner.paintWorld(ctx, view, paint); }, report);
            denseResources = resources;
            const current = () => useDense ? dense! : direct!;
            adapter = {
                prepare: (view, budget) => {
                    const source = options.frames.readFrame(), work = withFirstUnit(budget);
                    if (useDense) dense!.prepare(view, work, source ? liveFor(source) : undefined);
                    else direct!.prepare(view, work, !allocatorHost?.device());
                },
                readyFrame: () => current().readyFrame(), outlined: () => !useDense && !!direct!.outlined?.(), building: () => !useDense && !!direct!.building?.(), borrowPrepared: () => current().borrowPrepared(),
                retainPrepared: () => current().retainPrepared(),
                draw2d: (ctx, view, band, omit) => current().draw2d(ctx, view, band, omit),
                drawable2d: () => current().drawable2d(), reacquireReleased: () => current().reacquireReleased(),
                release: reason => { directBuiltFor = null; direct!.release(reason); dense?.release(reason); },
                needsFrame: () => current().needsFrame(), memory: () => current().memory(),
                dispose: () => { direct!.dispose(); dense?.dispose(); },
            };
            gpu = createGpuPaintAdapter(adapter, host, report, gpuOptions()); gpuBoundHost = host;
        }
        return adapter;
    };
    const startEstimate = (frame: PaintSource) => {
        if (estimate?.frame === frame) return;
        known.add(frame);
        estimate = { frame, walk: paintItemsOf(frame), current: null, clip: 0, chunk: 0, bytes: 0, itemBytes: 0, maxItemBytes: 0, segments: 0, items: 0, done: false };
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
    const chargeDirect = (frame: PaintSource): boolean => {
        const want = direct!.memory().cpuBytes;
        let leases = reservations.get(frame);
        if (!leases) { leases = []; reservations.set(frame, leases); }
        const device = !!allocatorHost?.device();
        for (const [other, charged] of reservations) {
            if (other === frame || !(device || truedUp.has(other))) continue;
            leases.push(...charged); reservations.set(other, []);
        }
        let held = 0;
        for (const lease of leases) held += lease.bytes;
        let surplus = 0;
        while (leases.length && held - leases[leases.length - 1]!.bytes >= want) {
            const lease = leases.pop()!;
            allocatorHost?.allocator.cpu.release(lease); reserved -= lease.bytes; held -= lease.bytes; surplus += lease.bytes;
        }
        if (surplus) { auditCount(options.auditSurface ?? 'board', 'direct:charge-returned', 1, { bytes: surplus }); allocatorHost?.demandChanged?.(); }
        if (held >= want) { denied = false; return true; }
        if (memoryGate.closed()) { auditCount(options.auditSurface ?? 'board', 'direct:gate-closed'); denied = true; return false; }
        while (held < want) {
            const lease = allocatorHost!.allocator.cpu.reserve(DIRECT_CHUNK);
            if (!lease) {
                memoryGate.refused(); denied = true;
                auditCount(options.auditSurface ?? 'board', 'direct:charge-refused');
                auditCount(options.auditSurface ?? 'board', 'direct:refused-missing', 1, { bytes: want - held });
                allocatorHost!.demandChanged?.();
                awaitCpu(DIRECT_CHUNK);
                return false;
            }
            memoryGate.admitted();
            leases.push(lease); reserved += lease.bytes; held += lease.bytes;
        }
        denied = false; return true;
    };
    const trueUpDirect = (frame: PaintSource): void => {
        if (adapter?.readyFrame() !== frame || allocatorHost?.device()) return;
        if (truedUp.has(frame)) { chargeDirect(frame); return; }
        truedUp.add(frame);
        const leases = reservations.get(frame);
        if (!leases?.length) return;
        const estimated = leases.reduce((sum, lease) => sum + lease.bytes, 0);
        releaseFrame(frame);
        const charged = chargeDirect(frame);
        const held = (reservations.get(frame) ?? []).reduce((sum, lease) => sum + lease.bytes, 0);
        auditCount(options.auditSurface ?? 'board', charged ? 'direct:trued-up' : 'direct:true-up-refused', 1, { bytes: estimated - held });
        allocatorHost?.demandChanged?.();
    };
    const unchangedSincePresented = (view: ViewState, budget: FrameBudget, frame: PaintSource): boolean => {
        const drawn = lastDrawn, context = drawn?.context ?? null, host = activeHost();
        const miss = (why: string): false => { if (renderAuditEnabled()) auditCount(options.auditSurface ?? 'board', `unchanged-miss:${why}`); return false; };
        if (!context || !host) return miss(!context ? 'no-context' : 'no-host');
        if (!drawn || !gpu || drawn.content !== gpu.contentKey()) return miss('content');
        if (frame.sceneRevision !== drawn.revision) return miss('revision');
        if (!options.frames.isCurrent(frame)) return miss('not-current');
        if (frame.theme !== options.requestedTheme()) return miss('theme');
        if (!sameCameraView(context.view, view)) return miss('view');
        if (!sameTransform(context.paneTransform, host.paneTransform(view, budget.frameId))) return miss('transform');
        if (!sameOmission(context.omittedNodeIds, omittedOf(options.omitNodes?.(frame) ?? null))) return miss('omission');
        const offset = options.drawOffset?.(frame);
        const ox = offset?.x ?? 0, oy = offset?.y ?? 0;
        if (ox !== (drawn.offset?.x ?? 0) || oy !== (drawn.offset?.y ?? 0)) return miss('offset');
        if ((options.drawVersion?.() ?? 0) !== drawn.drawVersion) return miss('draw-version');
        return true;
    };
    const missAnswer = (why: string): void => { if (renderAuditEnabled()) auditCount(options.auditSurface ?? 'board', `answer-miss:${why}`); };
    let answeredFrame = -1, answeredUnchanged = false;
    const finishBackground = (view: ViewState, budget: FrameBudget): void => {
        const frame = pendingFrame;
        pendingFrame = null;
        if (!frame && answeredFrame === budget.frameId) { prepareUnchanged = answeredUnchanged; return; }
        if (!frame || foregroundFrame !== budget.frameId || !adapter || disposed) {
            if (adapter && !disposed && !allocatorHost?.device()) {
                answeredFrame = budget.frameId;
                prepareUnchanged = answeredUnchanged = unchanged2d(view, budget);
                return;
            }
            missAnswer(!frame ? 'bg-no-pending' : 'bg-no-foreground'); prepareUnchanged = false; return;
        }
        foregroundFrame = -1;
        answeredFrame = budget.frameId;
        try {
            const composerChanged = prepareGpu(view, budget, frame);
            if (onDeviceRoute) {
                if (composerChanged && renderAuditEnabled()) auditCount(options.auditSurface ?? 'board', 'unchanged-miss:composer');
                const charged = chargeDirect(frame);
                prepareUnchanged = charged && !composerChanged && unchangedSincePresented(view, budget, frame);
            } else prepareUnchanged = unchanged2d(view, budget);
            prune(frame, adapter.readyFrame());
            options.onPrepared?.();
        } catch (error) { prepareUnchanged = false; report(error); }
        finally { answeredUnchanged = prepareUnchanged; refreshProgress(); }
    };
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
            if (!frame || !options.frames.isCurrent(frame) || !sameToken(frame.token, budget.token)) {
                missAnswer(!frame ? 'no-frame' : !options.frames.isCurrent(frame) ? 'frame-not-current' : 'frame-token');
                if (frame && !replacementAsked.has(frame)) { replacementAsked.add(frame); options.requestFrame?.(); }
                return;
            }
            const gpuRoute = !!allocatorHost?.device();
            if (gpuRoute !== onDeviceRoute) {
                onDeviceRoute = gpuRoute; estimate = null; denied = false; deniedDirectSegments = null; density.reset();
                if (gpuRoute) { for (const old of [...reservations.keys()]) releaseFrame(old); dense?.releaseCharged(); }
            }
            if (gpuRoute) {
                if (useDense) {
                    useDense = false; denied = false;
                    allocatorHost?.demandChanged?.();
                    dense?.release('pressure');
                    allocatorHost!.invalidate('board-density-demand-ready');
                    options.onDensityMode?.('direct');
                    return;
                }
                if (frame.liveOnly) {
                    missAnswer('live-only-gpu');
                    if (!replacementAsked.has(frame)) { replacementAsked.add(frame); options.requestFrame?.(); }
                    return;
                }
                known.add(frame);
                if (directBuiltFor !== frame && !memoryGate.closed()) {
                    adapter.prepare(view, budget);
                    directBuiltFor = frame;
                } else if (directBuiltFor !== frame) auditCount(options.auditSurface ?? 'board', 'direct:build-held');
                else if (adapter.readyFrame() !== frame) { adapter.prepare(view, budget); auditCount(options.auditSurface ?? 'board', 'direct:build-resumed'); }
                else if (adapter.outlined?.()) { adapter.prepare(view, budget); auditCount(options.auditSurface ?? 'board', 'direct:shed-outlines'); }
                else if (adapter.building?.()) { adapter.prepare(view, budget); auditCount(options.auditSurface ?? 'board', 'direct:build-staged'); }
                if (directBuiltFor !== frame || adapter.readyFrame() !== frame) prepareUnchanged = false;
                const composerChanged = prepareGpu(view, budget, frame);
                if (composerChanged && renderAuditEnabled()) auditCount(options.auditSurface ?? 'board', 'unchanged-miss:composer');
                if (budget.phase === 'foreground') { pendingFrame = frame; foregroundFrame = budget.frameId; return; }
                const charged = chargeDirect(frame);
                prune(frame, adapter.readyFrame());
                prepareUnchanged = charged && !composerChanged && unchangedSincePresented(view, budget, frame);
                options.onPrepared?.();
                return;
            }
            if (!adapter.drawable2d()) {
                const asked = adapter.reacquireReleased();
                if (asked) auditCount(options.auditSurface ?? 'board', 'image:reacquire-2d', asked);
            }
            if (!!frame.liveOnly !== useDense && frame.openTile) {
                missAnswer('open-tile');
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
            const candidates = options.candidates?.() ?? null;
            const segments = candidates ?? estimate!.segments, items = candidates ?? estimate!.items;
            const observed = density.observe({ frameId: budget.frameId, now: performance.now(),
                candidateSegments: segments, coveredDevicePixels: view.viewport.width * view.viewport.height * view.viewport.dpr ** 2,
                estimatedGpuMs: segments * .00004 + items * .0001 });
            if (deniedDirectSegments !== null && (candidates !== null || !frame.liveOnly) && segments < deniedDirectSegments * 0.5) deniedDirectSegments = null;
            const mode = dense?.gaveUp(frame) ? 'direct' : useDense && frame.liveOnly && deniedDirectSegments !== null ? 'dense'
                : frame.openTile ? (deniedDirectSegments !== null ? 'dense' : observed) : 'direct';
            if ((mode === 'dense') !== useDense) {
                useDense = mode === 'dense';
                denied = false;
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
            if (!useDense && density.pending()) { denied = false; return; }
            if (!useDense && !reservations.has(frame)) {
                const bytes = estimate!.bytes;
                if (bytes) {
                    if (memoryGate.closed()) { denied = true; return; }
                    allocatorHost!.refreshDemandNow?.();
                    const lease = allocatorHost!.allocator.cpu.reserve(bytes);
                    if (!lease) {
                        memoryGate.refused();
                        allocatorHost!.demandChanged?.();
                        denied = true;
                        if (frame.openTile && deniedDirectSegments === null) { deniedDirectSegments = segments; allocatorHost!.invalidate('board-density-demand-ready'); return; }
                        awaitCpu(bytes);
                        return;
                    }
                    memoryGate.admitted();
                    reservations.set(frame, [lease]); reserved += lease.bytes;
                } else reservations.set(frame, []);
            }
            denied = false;
            adapter.prepare(view, budget);
            if (!useDense) trueUpDirect(frame);
            prepareGpu(view, budget, frame);
            if (budget.phase === 'foreground') { pendingFrame = frame; foregroundFrame = budget.frameId; return; }
            prune(frame, adapter.readyFrame());
            options.onPrepared?.();
        } catch (error) { report(error); }
        finally { refreshProgress(); }
    };
    const acknowledge = (band: PaintBand, revision: number, token: RenderToken) => {
        const drawnBand = drawTokens.get(token)?.get(band), frame = drawnBand?.frame, ink = drawnBand?.ink;
        if (!drawnBand || !frame || !ink || frame.sceneRevision !== revision || !sameToken(frame.token, token)) return;
        const context = drawnBand.context;
        if (ackFrame !== frame || ackInk !== ink || ackToken !== token || ackContext?.frameId !== context.frameId
            || !sameView(ackContext?.view, context.view) || !sameTransform(ackContext?.paneTransform, context.paneTransform)
            || !sameOmission(ackContext?.omittedNodeIds ?? null, context.omittedNodeIds)) {
            ackFrame = frame; ackInk = ink; ackToken = token; ackContext = context; ackMask = 0;
        }
        ackMask |= band === 'underlay' ? 1 : 2;
        if (ackMask !== 3) return;
        if (presented === frame && presentedInk === ink && presentedContext?.frameId === context.frameId
            && sameView(presentedContext?.view, context.view) && sameTransform(presentedContext?.paneTransform, context.paneTransform)
            && sameOmission(presentedContext?.omittedNodeIds ?? null, context.omittedNodeIds)) {
            promote2d(context.frameId);
            ackFrame = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; drawTokens.delete(token); return;
        }
        try {
            options.frames.presented(frame);
            acceptHolds([...(drawTokens.get(token)?.values() ?? [])].map(drawn => drawn.hold));
            const previous = presented; presented = frame; presentedInk = ink; presentedContext = context;
            promote2d(context.frameId);

            // A completed presentation is the only event that clears a real error.
            lastError = null; refreshProgress();
            ackFrame = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; drawTokens.delete(token);
            if (previous && previous !== frame && !retainedByDense().has(previous)) {
                options.frames.retire(previous); releaseFrame(previous); known.delete(previous);
            }
            sceneAudit.update(frame, context.view, context.paneTransform);
            options.onPresented?.(revision, token, presentedFrame(inkFrame(frame, ink), context.omittedNodeIds), context);
        } catch (error) { report(error); }
    };
    const drawable = (frame: PaintSource): boolean => !options.optional || options.frames.isCurrent(frame);
    const drawnOffset = (frame: PaintSource, dense: boolean): Readonly<{ x: number; y: number }> | null | undefined => {
        const offset = options.drawOffset?.(frame);
        if (!offset || (offset.x === 0 && offset.y === 0)) return null;
        if (dense) { auditCount(options.auditSurface ?? 'board', 'fallback:offset-rebuild'); options.onOffsetUnsupported?.(); return undefined; }
        return offset;
    };
    const heldNodesOf = new WeakMap<object, ReadonlySet<string>>();
    const nodesHeldBy = (base: PaintSource): ReadonlySet<string> => {
        const known = heldNodesOf.get(base); if (known) return known;
        const held = new Set<string>(base.inkNodeIds);
        const lists = base as { underlay?: readonly { nodeId?: string }[]; content?: readonly { nodeId?: string }[] };
        for (const list of [lists.underlay, lists.content]) if (list) for (const item of list) if (item.nodeId) held.add(item.nodeId);
        heldNodesOf.set(base, held); return held;
    };
    const undrawnChangeSince = (from: number, to: number, band: PaintBand, view: ViewState, canvas: boolean, base: PaintSource): boolean => {
        const now = options.frames.readFrame();
        const changed = options.changedNodesSince?.(from, to) ?? (now && now.sceneRevision === to ? now.changedNodesSince?.(from) : null);
        if (!changed) return false;
        const omitted = now ? options.omitNodes?.(now) ?? null : null;
        const laid = canvas ? null : gpu?.plannedLiveNodeIds(band) ?? null;
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
    const coverageNot = (result: LayerCoverage, why: string): LayerCoverage => {
        if (renderAuditEnabled()) auditCount('board', `coverage-not:${why}`);
        return result;
    };
    const coverageOf = (band: PaintBand, frame: Pick<ScheduledFrame, 'view' | 'token'>, backend: CompositorBackend): LayerCoverage => {
        const gpuCoverage = backend !== 'canvas2d' ? gpu?.coverage(frame.view) : null;
        const ready = backend === 'canvas2d' ? adapter?.readyFrame() : gpu?.readyFrame();
        const denseCoverage = useDense && ready ? dense?.coverage(frame.view, liveFor(ready)) : null;
        if (useDense && !denseCoverage?.complete) return coverageNot(INCOMPLETE, `dense-${band}`);
        if (backend !== 'canvas2d' && !gpuCoverage?.complete) return coverageNot(INCOMPLETE, `gpu-${band}`);
        if (!ready) return coverageNot(INCOMPLETE, `no-ready-frame-${band}`);
        if (!sameToken(ready.token, frame.token)) return coverageNot(INCOMPLETE, `token-${band}`);
        if (backend === 'canvas2d' && !adapter?.drawable2d()) return coverageNot(INCOMPLETE, `image-away-${band}`);
        const latest = options.requestedRevision();
        if (ready.sceneRevision !== latest && !undrawnChangeSince(ready.sceneRevision, latest, band, frame.view, backend === 'canvas2d', ready)) {
            return coverageNot(STALE, `revision-${band}`);
        }
        if (ready.theme !== options.requestedTheme()) return coverageNot(STALE, `theme-${band}`);
        if (!options.frames.isCurrent(ready)) return coverageNot(STALE, `not-current-${band}`);
        return { complete: true, sharp: (gpuCoverage?.sharp ?? true) && (denseCoverage?.sharp ?? true) };
    };
    const bandCoverage = (band: PaintBand, frame: Pick<ScheduledFrame, 'view' | 'token'>, backend: CompositorBackend): { actual: LayerCoverage; read: LayerCoverage } => {
        if (options.optional && options.requested && !options.requested()) return { actual: COMPLETE, read: COMPLETE };
        const actual = coverageOf(band, frame, backend);
        return { actual, read: options.optional && !actual.complete ? COMPLETE : actual };
    };
    const picture2d = (band: PaintBand, view: ViewState, frameId: number): Picture2d | null => {
        const host = hosts.get(band);
        if (useDense || !adapter || !host) return null;
        const frame = adapter.readyFrame();
        const shown = !!frame && drawable(frame);
        return { frameId, prepared: shown ? adapter.borrowPrepared() : null, frame: shown ? frame : null, view: copyView(view),
            transform: host.paneTransform(view, frameId), omit: shown ? omittedOf(options.omitNodes?.(frame!) ?? null) : null,
            offset: shown ? options.drawOffset?.(frame!) ?? null : null, drawVersion: options.drawVersion?.() ?? 0,
            current: shown && options.frames.isCurrent(frame!), holds: adapter.drawable2d(), requested: options.requested?.() ?? true, coverage: null };
    };
    const differs2d = (a: Picture2d, b: Picture2d): string | null => {
        if (a.prepared !== b.prepared || a.frame !== b.frame) return 'content';
        if (!sameCameraView(a.view, b.view)) return 'view';
        if (!sameTransform(a.transform, b.transform)) return 'transform';
        if (!sameOmission(a.omit, b.omit)) return 'omission';
        if ((a.offset?.x ?? 0) !== (b.offset?.x ?? 0) || (a.offset?.y ?? 0) !== (b.offset?.y ?? 0)) return 'offset';
        if (a.drawVersion !== b.drawVersion) return 'draw-version';
        if (a.current !== b.current) return 'current';
        if (a.holds !== b.holds) return 'images';
        if (a.requested !== b.requested) return 'requested';
        if (!a.coverage || !b.coverage || a.coverage.complete !== b.coverage.complete || a.coverage.sharp !== b.coverage.sharp
            || a.coverage.staleVersion !== b.coverage.staleVersion) return 'coverage';
        return null;
    };
    const promote2d = (frameId: number): void => {
        for (const [band, picture] of drawing2d) if (picture.frameId === frameId) { shown2d.set(band, picture); drawing2d.delete(band); }
    };
    const unchanged2d = (view: ViewState, budget: FrameBudget): boolean => {
        const miss = (why: string): false => { if (renderAuditEnabled()) { auditCount(options.auditSurface ?? 'board', `unchanged2d-miss:${why}`); auditTape(`${options.auditSurface ?? 'board'}:u2d-miss:${why}`); } return false; };
        if (!hosts.size) return miss('no-host');
        for (const band of hosts.keys()) {
            const shown = shown2d.get(band);
            if (!shown) return miss(drawing2d.has(band) ? 'unconfirmed' : 'no-picture');
            const now = picture2d(band, view, budget.frameId);
            if (!now) return miss(useDense ? 'dense' : 'no-input');
            now.coverage = bandCoverage(band, { view, token: budget.token }, 'canvas2d').read;
            const why = differs2d(shown, now);
            if (why) return miss(why);
        }
        return true;
    };
    const gpuWorkingSetFor = (band: PaintBand) => ({
        gpuWorkingSet: (_layer: Layer, viewport: Readonly<{ width: number; height: number }>) => ({
            mandatoryBytes: hosts.get(band) === allocatorHost ? (gpu as GpuWorkingSetReporter | null)?.gpuMandatoryBytes?.(viewport) ?? 0 : 0,
        }),
    });
    const cpuMandatory = (): number => {
        const upcoming = !useDense && estimate?.done && !density.pending() && !reservations.has(estimate.frame) ? estimate.bytes : 0;
        const scratch = allocatorHost?.device() ? gpu?.cpuWorkingSet().mandatoryBytes ?? 0 : 0;
        return reserved + upcoming + scratch + (useDense ? dense?.cpuWorkingSet(estimate?.maxItemBytes ?? 0) ?? 0 : 0) + (options.frames.cpuWorkingSet?.() ?? 0);
    };
    const inkLessCache = new WeakMap<ReadonlySet<string>, { omit: ReadonlySet<string>; ink: ReadonlySet<string> }>();
    const inkLess = (ink: ReadonlySet<string>, omit: ReadonlySet<string>): ReadonlySet<string> => {
        const known = inkLessCache.get(ink);
        if (known?.omit === omit) return known.ink;
        const kept = new Set<string>();
        for (const id of ink) if (!omit.has(id)) kept.add(id);
        inkLessCache.set(ink, { omit, ink: kept });
        return kept;
    };
    const drawn2d: Record<PaintBand, ReadonlySet<string>> = { underlay: NO_INK, content: NO_INK };
    const drawnInk2d: Record<PaintBand, ReadonlySet<string>> = { underlay: NO_INK, content: NO_INK };
    const liveDrawn = (frame: PaintSource): ReadonlySet<string> => {
        const live = options.liveNodes, held = frame.sensitiveNodes;
        if (!live?.size || !held?.size) return NO_INK;
        const drawn = new Set<string>();
        for (const id of live) if (held.has(id)) drawn.add(id);
        return drawn.size ? drawn : NO_INK;
    };
    const definition = (band: PaintBand): PlatformLayerDefinition => ({
        id: `board-${band}`, group: 'document', foregroundCpu: true, ...gpuWorkingSetFor(band),
        create(host) {
            if (disposed || hosts.has(band)) throw new Error('Board layer already attached');
            auditCount(options.auditSurface ?? 'board', `host:attach:${band}:${gpu ? (gpuBoundHost === host ? 'same' : 'rebound-needed') : 'first'}`);
            hosts.set(band, host); ensureAdapter(host);
            let ended = false;
            const layer: Layer & LayerEvicting & EmptyReporting = {
                twoPhase: true,
                backgroundOwed: (frameId: number) => pendingFrame !== null && foregroundFrame === frameId,
                prepare: (view: ViewState, budget: FrameBudget): boolean | void => {
                    prepareFrame(view, budget);
                    return budget.phase === 'foreground' || prepareUnchanged ? false : true;
                },
                drawGpu(pass, view) {
                    drawn2d[band] = NO_INK; drawing2d.delete(band); shown2d.delete(band);
                    drewNothing[band] = true;
                    const frame = gpu?.readyFrame();
                    if (!frame || !drawable(frame)) return;
                    const omit = preparedOmit?.frame === frame ? preparedOmit.omit : options.omitNodes?.(frame) ?? null;
                    const shift = drawnOffset(frame, useDense); if (shift === undefined) return;
                    const ink = gpu!.readyInkNodeIds() ?? frame.inkNodeIds;
                    if (!prepareToken) return;
                    const actualView = copyView(view);
                    gpu!.drawGpu(pass, shift ? shiftedView(view, shift) : view, band);
                    drewNothing[band] = gpu!.drewNothing(band);
                    const content = gpu!.contentKey();
                    const hold = captureDraw(frame, omit);
                    const context = Object.freeze({ view: actualView, frameId: prepareFrameId,
                        paneTransform: host.paneTransform(actualView, prepareFrameId),
                        token: Object.freeze({ ...prepareToken }), omittedNodeIds: omittedOf(omit),
                        retain: () => options.frames.retain(frame), retainImages: () => leaseOf(hold) });
                    lastDrawn = { context, content, drawVersion: options.drawVersion?.() ?? 0, revision: frame.sceneRevision, offset: shift ? { x: shift.x, y: shift.y } : null };
                    recordDraw(band, { frame, omit, ink, context, hold });
                },
                evictGpu(bytes, frameId) {
                    if (hosts.get(band) !== allocatorHost) return 0;
                    const adapter = gpu as GpuEvicting | null;
                    return typeof adapter?.evictGpu === 'function' ? adapter.evictGpu(bytes, frameId) : 0;
                },
                protectFrame(frameId, view) {
                    if (hosts.get(band) !== allocatorHost) return;
                    const adapter = gpu as GpuProtecting | null;
                    if (typeof adapter?.protectFrame === 'function') adapter.protectFrame(frameId, view);
                },
                encodeOffscreen(passes, view) {
                    const encoder = gpu as OffscreenEncoder | null;
                    if (typeof encoder?.encodeOffscreen === 'function') encoder.encodeOffscreen(passes, view, band);
                },
                offscreenSettled(submitted) {
                    const encoder = gpu as OffscreenEncoder | null;
                    if (typeof encoder?.offscreenSettled === 'function') encoder.offscreenSettled(submitted);
                },
                drewNothing: () => drewNothing[band],
                draw2d(ctx, view) {
                    drawn2d[band] = NO_INK; drawnInk2d[band] = NO_INK; drewNothing[band] = false;
                    lastDrawn = null;
                    const picture = picture2d(band, view, prepareFrameId);
                    const reported = read2d.get(band);
                    if (picture && reported?.frameId === prepareFrameId) picture.coverage = reported.read;
                    drawing2d.delete(band); shown2d.delete(band);
                    if (picture && !picture.frame) shown2d.set(band, picture);
                    const frame = adapter?.readyFrame();
                    if (!frame || !drawable(frame)) return;
                    const reuse = band === 'content' && drawnOmit2d?.view === view && drawnOmit2d.frame === frame;
                    const omit = reuse ? drawnOmit2d!.omit : options.omitNodes?.(frame) ?? null;
                    drawnOmit2d = band === 'underlay' ? { view, frame, omit } : null;
                    const shift = drawnOffset(frame, useDense); if (shift === undefined) return;
                    const ink = adapter!.borrowPrepared()?.root.inkNodeIds ?? frame.inkNodeIds;
                    if (!prepareToken) return;
                    const actualView = copyView(view);
                    adapter!.draw2d(ctx, shift ? shiftedView(view, shift) : view, band, omit ?? undefined);
                    if (picture?.frame) drawing2d.set(band, picture);
                    drawn2d[band] = liveDrawn(frame);
                    drawnInk2d[band] = !options.frames.isCurrent(frame) ? NO_INK : omit?.size ? inkLess(ink, omit) : ink;
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
                prepareUrgent() {
                    return !disposed && !ended && presented === null;
                },
                needsFrame() {
                    const idleOnly = useDense && !!dense?.idleOnly();
                    const needed = !disposed && !ended && (options.frames.needsFrame() || (!denied && (!!estimate && !estimate.done || density.pending()
                        || (!idleOnly && !!adapter?.needsFrame()) || !!activeHost()?.device() && !!gpu?.needsFrame())));
                    if (!needed && !disposed && !ended && lastProgress?.kind === 'pending') refreshProgress();
                    return needed;
                },
                onFramePresented(revision, token) { acknowledge(band, revision, token); },
                dispose() {
                    if (ended) return;
                    ended = true;
                    auditCount(options.auditSurface ?? 'board', `host:detach:${band}`);
                    armMemoryRetry(false);
                    if (allocatorHost === host) { clearResources('pressure'); allocatorHost = null; }
                    hosts.delete(band);
                    if (!hosts.size) {
                        disposed = true; sceneAudit.dispose(); discardHolds(); gpu?.dispose(); gpu = null; adapter?.dispose(); adapter = null;
                        deferredClear = true; collectRetired(); presented = null; refreshProgress();
                    } else if (!allocatorHost) {
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
            if (hosts.get(band) !== allocatorHost) return;
            dense?.reclaim(bytes);
            const adapter = gpu as CpuEvicting | null;
            if (typeof adapter?.evictCpu === 'function') adapter.evictCpu(bytes);
        },
        cpuWorkingSet() {
            return { mandatoryBytes: hosts.get(band) === allocatorHost ? cpuMandatory() : 0, prefetchBytes: 0 };
        },
        critical(_layer, view) { return (presented === null && !adapter?.readyFrame() && !gpu?.readyFrame() && !gpu?.memoryBlocked()) || !!gpu?.listInvalid(view) || !!gpu?.holding(); },
        coverage(layer, frame, backend) {
            const { actual, read } = bandCoverage(band, frame, backend);
            if (backend === 'canvas2d') {
                read2d.set(band, { frameId: frame.frameId, read });
                const picture = drawing2d.get(band) ?? shown2d.get(band);
                if (picture?.frameId === frame.frameId) picture.coverage = read;
            }
            if (options.optional && options.requested && !options.requested()) return read;
            if (band === 'underlay' && (!actual.complete || !actual.sharp)) auditDrawn(!actual.complete && presented === null ? 'hole' : 'stand-in', 1, 'geometry', !actual.complete ? 'board-incomplete' : 'board-unsharp');
            return read;
        },
    });
    const pair = [definition('underlay'), definition('content')] as unknown as BoardLayerPair;
    pair.invalidate = (reason = 'board-content') => { for (const host of hosts.values()) host.invalidate(reason); };
    pair.drawnInkNodeIds = () => {
        const device = (gpu as DrawnInkReporter | null)?.drawnInkNodeIds?.() ?? NO_INK;
        const sets = [device, drawnInk2d.underlay, drawnInk2d.content].filter(set => set.size);
        if (sets.length <= 1) return sets[0] ?? NO_INK;
        if (sets.length === 2 && sets[0] === sets[1]) return sets[0];
        return new Set(sets.flatMap(set => [...set]));
    };
    pair.drawnLiveNodeIds = () => {
        const reporter = gpu as DrawnLiveReporter | null;
        const under = reporter?.drawnLiveNodeIds?.('underlay') ?? NO_INK, content = reporter?.drawnLiveNodeIds?.('content') ?? NO_INK;
        const sets = [under, content, drawn2d.underlay, drawn2d.content].filter(set => set.size);
        if (sets.length <= 1) return sets[0] ?? NO_INK;
        return new Set(sets.flatMap(set => [...set]));
    };
    pair.plannedLiveNodeIds = () => {
        const under = gpu?.plannedLiveNodeIds('underlay') ?? NO_INK, content = gpu?.plannedLiveNodeIds('content') ?? NO_INK;
        if (!under.size || !content.size) return under.size ? under : content;
        return new Set([...under, ...content]);
    };
    pair.onDevice = () => !!activeHost()?.device();
    pair.cpuMandatoryBytes = cpuMandatory;
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
