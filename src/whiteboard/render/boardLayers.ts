import type { Affine, ViewState } from '../../platform/types';
import type { PlatformLayerDefinition } from '../../platform/render/attachPlatformPane.types';
import type { LayerHost } from '../../platform/render/compositor.types';
import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { FrameBudget, FrameToken, GpuReleaseReason, Layer, RenderToken } from '../../platform/render/types';
import type { PaintFrameAssembler } from './frameTypes';
import type { PaintBand } from './material';
import { inkCoverageChunks, type PaintItem, type PaintSource } from './paintStream';
import { paintItemsOf } from './paintWindows';
import type { PaintImageProvider } from './resources';
import { createCanvasPaintAdapter, type CanvasPaintAdapter } from './reference/canvasPaintAdapter';
import { createGpuPaintAdapter } from './gpuPaintAdapter';
import { createDensePaintAdapter } from './densePlan';
import { DensityController, type DensityMode } from './density';
import { FilteredInk, LiveNodeUnion } from './nodeSets';
import type { PresentedImage, PresentedImageLease, ViewerPaintPresentation } from './paintPresentation';

/** Both paths execute the same prepared paint; the platform alone selects/recovers the device. */
export const BOARD_BACKEND_PREFERENCE = 'auto' as const;
/** What the renderer holds for the current revision. `pending` keeps the last coherent presented pixels on screen;
 * `current` needs a presented frame of the requested revision with nothing outstanding; `failed` is a real error. */
export type PaintProgress = { readonly kind: 'current' } | { readonly kind: 'pending'; readonly reason: 'building' | 'waiting-memory' }
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
    /** View-only suppression, evaluated against the actual ready preview frame. */
    readonly omitNodes?: (frame: PaintSource) => ReadonlySet<string> | null;
    readonly liveNodeIds?: () => ReadonlySet<string> | undefined;
    readonly beforePrepare?: (view: ViewState, budget: FrameBudget) => void;
    readonly onPresented?: (revision: number, token: RenderToken, frame: PaintSource, context?: ViewerPaintPresentation) => void;
    readonly onDrawn?: (revision: number, frame: PaintSource, context: ViewerPaintPresentation) => void;
    /** Upper bound on the nodes this view meets, from the sheet index; null while that index builds. */
    readonly candidates?: () => number | null;
    /** The density mode changed: the owner requests the matching kind of frame (live-only for dense). */
    readonly onDensityMode?: (mode: DensityMode) => void;
    /** A live item the current dense frame does not hold: the owner requests a frame that does. */
    readonly requestFrame?: () => void;
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
export function createBoardLayers(options: BoardLayersOptions): BoardLayerPair {
    const hosts = new Map<PaintBand, LayerHost>();
    let adapter: CanvasPaintAdapter | null = null, allocatorHost: LayerHost | null = null;
    let gpu: ReturnType<typeof createGpuPaintAdapter> | null = null;
    let direct: CanvasPaintAdapter | null = null, dense: ReturnType<typeof createDensePaintAdapter> | null = null;
    const retiringDense = new Set<ReturnType<typeof createDensePaintAdapter>>();
    const density = new DensityController();
    let useDense = false, deferredClear = false;
    const liveSets = new WeakMap<PaintSource, { omit: ReadonlySet<string> | null | undefined; wet: ReadonlySet<string> | undefined; live: ReadonlySet<string> }>();
    const liveFor = (frame: PaintSource): ReadonlySet<string> | undefined => {
        const omit = options.omitNodes?.(frame), wet = options.liveNodeIds?.();
        if (!omit?.size && !wet?.size) return frame.sensitiveNodes;
        const old = liveSets.get(frame); if (old && old.omit === omit && old.wet === wet) return old.live;
        const live = new LiveNodeUnion(frame.sensitiveNodes, omit, wet);
        liveSets.set(frame, { omit, wet, live }); return live;
    };
    let estimate: Estimate | null = null, denied = false, disposed = false, lastPrepareFrame: number | null = null;
    let missingKey: string | null = null;
    let presented: PaintSource | null = null, presentedOmit: ReadonlySet<string> | null = null, presentedInk: ReadonlySet<string> | null = null;
    let ackFrame: PaintSource | null = null, ackOmit: ReadonlySet<string> | null = null, ackInk: ReadonlySet<string> | null = null, ackMask = 0;
    let ackToken: RenderToken | null = null, ackContext: ViewerPaintPresentation | null = null;
    let presentedContext: ViewerPaintPresentation | null = null;
    type Drawn = { frame: PaintSource; omit: ReadonlySet<string> | null; ink: ReadonlySet<string>; context: ViewerPaintPresentation };
    const drawn = new Map<PaintBand, Drawn>();
    let drawSource: PaintSource | null = null, prepareToken: FrameToken | null = null, prepareFrameId = -1;
    let drawTokens = new WeakMap<RenderToken, Map<PaintBand, Drawn>>();
    let announced = new WeakMap<RenderToken, { underlay: Drawn; content: Drawn }>();
    const recordDraw = (band: PaintBand, value: Drawn) => {
        // Accepted acknowledgements retain this exact frozen budget token. Revision alone cannot
        // distinguish a coarse summary from its fine replacement of the SAME immutable source.
        if (drawSource !== value.frame) { drawTokens = new WeakMap(); drawSource = value.frame; }
        drawn.set(band, value);
        if (!prepareToken) return;
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
        lastError = messageOf(error); refreshProgress();
        try { options.onError(error); } catch { /* reporting cannot reject a worker callback */ }
    };
    // Pending while work or memory is outstanding; current only for the presented requested revision with nothing
    // outstanding. Memory denial is waiting for capacity, never a failure. A real error stands until a current
    // presentation actually completes.
    const progressNow = (): PaintProgress => {
        if (lastError !== null) return { kind: 'failed', message: lastError };
        const blocked = !!options.frames.blocked?.() || denied || !!dense?.memoryBlocked();
        const working = !!options.frames.needsFrame() || (!!estimate && !estimate.done) || !!adapter?.needsFrame()
            || (!!activeHost()?.device() && !!gpu?.needsFrame()) || !!dense?.pending();
        if (!blocked && !working && presented && presented.sceneRevision === options.requestedRevision() && options.frames.isCurrent(presented)) return { kind: 'current' };
        return { kind: 'pending', reason: blocked ? 'waiting-memory' : 'building' };
    };
    const refreshProgress = () => {
        const next = progressNow();
        if (lastProgress && sameProgress(lastProgress, next)) return;
        lastProgress = next; options.onPaintProgress?.();
    };
    const releaseFrame = (frame: PaintSource) => {
        const leases = reservations.get(frame);
        if (!leases) return;
        reservations.delete(frame);
        for (const lease of leases) { allocatorHost!.allocator.cpu.release(lease); reserved -= lease.bytes; }
    };
    // Facts borrow the exact prepared plan this draw read, never the raw provider: the 2D snapshot
    // or dense plan keeps its image leases and bitmaps alive until the lease is released.
    const presentedImages = (frame: PaintSource, omit: ReadonlySet<string> | null) => (): PresentedImageLease | null => {
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
                        const bitmap = prepared.resources.image(item.imageKey);
                        if (!(bitmap instanceof ImageBitmap)) { usable = false; break windows; }
                        images.push({ nodeId: item.nodeId, item, source: bitmap });
                    }
                }
            } catch { usable = false; }
        }
        if (!usable) { borrow.release(); return null; }
        let released = false;
        return Object.freeze({ frame: source, images: Object.freeze(images), release() { if (!released) { released = true; borrow.release(); } } });
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
        // The reference adapter keeps CPU paths on context loss; this owner must
        // explicitly evict them before returning its CPU leases for any release.
        gpu?.release(reason);
        direct?.release(reason === 'context-lost' ? 'pressure' : reason);
        dense?.release(reason);
        for (const frame of [...reservations.keys()]) releaseFrame(frame);
        estimate = null; denied = false; lastPrepareFrame = null; drawn.clear(); drawTokens = new WeakMap(); announced = new WeakMap(); drawSource = null; prepareToken = null; prepareFrameId = -1;
        ackFrame = null; ackOmit = null; ackInk = null; ackMask = 0; ackToken = null; ackContext = null; presentedInk = null;
        if (reason === 'hidden') {
            deferredClear = true; collectRetired(); presented = null; presentedContext = null; refreshProgress();
            density.reset(); useDense = false;
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
            dense = createDensePaintAdapter(resources, host, report);
            const current = () => useDense ? dense! : direct!;
            adapter = {
                prepare: (view, budget) => {
                    const source = options.frames.readFrame();
                    if (useDense) dense!.prepare(view, budget, source ? liveFor(source) : undefined);
                    else direct!.prepare(view, budget);
                },
                readyFrame: () => current().readyFrame(), borrowPrepared: () => current().borrowPrepared(),
                retainPrepared: () => current().retainPrepared(),
                draw2d: (ctx, view, band, omit) => current().draw2d(ctx, view, band, omit),
                release: reason => { direct!.release(reason); dense!.release(reason); },
                needsFrame: () => current().needsFrame(), memory: () => current().memory(),
                dispose: () => { direct!.dispose(); dense!.dispose(); },
            };
            gpu = createGpuPaintAdapter(adapter, host, report);
        }
        return adapter;
    };
    const startEstimate = (frame: PaintSource) => {
        if (estimate?.frame === frame) return;
        known.add(frame);
        estimate = { frame, walk: paintItemsOf(frame), current: null, clip: 0, chunk: 0, arc: -1, bytes: 0, itemBytes: 0, maxItemBytes: 0, segments: 0, items: 0, demandPublished: false, done: false }; denied = false;
    };
    const prune = (requested: PaintSource, ready: PaintSource | null) => {
        const retained = retainedByDense();
        for (const frame of known) {
            if (!retained.has(frame) && frame !== requested && frame !== ready && frame !== gpu?.readyFrame() && frame !== presented && frame !== drawn.get('underlay')?.frame && frame !== drawn.get('content')?.frame) {
                options.frames.retire(frame); releaseFrame(frame); known.delete(frame);
            }
        }
    };
    const prepare = (view: ViewState, budget: FrameBudget) => {
        if (!adapter || disposed || lastPrepareFrame === budget.frameId) return;
        lastPrepareFrame = budget.frameId; prepareToken = budget.token; prepareFrameId = budget.frameId;
        deferredClear = false;
        try {
            options.beforePrepare?.(view, budget);
            options.frames.prepare(budget);
            const frame = options.frames.readFrame();
            if (!frame || !options.frames.isCurrent(frame) || !sameToken(frame.token, budget.token)) return;
            // A live-only frame holds no other items, so it can never serve direct drawing; a direct frame
            // cannot serve dense drawing either. The owner's request for the other kind is already in flight.
            if (!!frame.liveOnly !== useDense && frame.openTile) return;
            if (useDense && frame.liveOnly) {
                const live = liveFor(frame), missing: string[] = [];
                if (live) for (const id of live) if (!frame.sensitiveNodes?.has(id)) missing.push(id);
                if (missing.length) {
                    // Requested once per distinct missing set; a request is never repeated per prepare.
                    const key = missing.join('\n');
                    if (key !== missingKey) { missingKey = key; options.requestFrame?.(); }
                    return;
                }
                missingKey = null;
            }
            startEstimate(frame);
            while (!estimate!.done && !budget.shouldYield()) estimateStep(estimate!);
            if (!estimate!.done) return;
            // Initial operation-count defaults; the owner defers binding calibration, not the hierarchy.
            // Dense tiles are streamed from the frame's own pin; a frame that cannot reopen its stream stays direct.
            // The index count is the same for a dense and a direct frame, so the mode cannot oscillate
            // with the frame kind it selects; the frame's own estimate stands in only before the index is built.
            const candidates = options.candidates?.() ?? null;
            const segments = candidates ?? estimate!.segments, items = candidates ?? estimate!.items;
            const observed = density.observe({ frameId: budget.frameId, now: performance.now(),
                candidateSegments: segments, coveredDevicePixels: view.viewport.width * view.viewport.height * view.viewport.dpr ** 2,
                estimatedGpuMs: segments * .00004 + items * .0001 });
            const mode = frame.openTile ? observed : 'direct';
            if ((mode === 'dense') !== useDense) {
                useDense = mode === 'dense';
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
            if (!useDense && !reservations.has(frame) && !estimate!.demandPublished && estimate!.bytes) {
                estimate!.demandPublished = true;
                allocatorHost!.invalidate('board-native-demand-ready'); return;
            }
            if (!useDense && !reservations.has(frame)) {
                const bytes = estimate!.bytes;
                if (bytes) {
                    const lease = allocatorHost!.allocator.cpu.reserve(bytes);
                    if (!lease) { denied = true; return; }
                    reservations.set(frame, [lease]); reserved += lease.bytes;
                } else reservations.set(frame, []);
            }
            denied = false;
            adapter.prepare(view, budget);
            gpu?.prepare(view, budget);
            prune(frame, adapter.readyFrame());
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
    const definition = (band: PaintBand): PlatformLayerDefinition => ({
        id: `board-${band}`, group: 'document',
        create(host) {
            if (disposed || hosts.has(band)) throw new Error('Board layer already attached');
            hosts.set(band, host); ensureAdapter(host);
            let ended = false;
            const layer: Layer = {
                prepare,
                drawGpu(pass, view) {
                    const frame = gpu?.readyFrame();
                    if (!frame) return;
                    const omit = options.omitNodes?.(frame) ?? null;
                    const ink = gpu!.readyInkNodeIds() ?? frame.inkNodeIds;
                    if (!prepareToken) return;
                    const actualView = copyView(view);
                    const context = Object.freeze({ view: actualView, frameId: prepareFrameId,
                        paneTransform: host.paneTransform(actualView, prepareFrameId),
                        token: Object.freeze({ ...prepareToken }), omittedNodeIds: omit ? new OmittedSnapshot(omit) : null,
                        retain: () => options.frames.retain(frame), retainImages: presentedImages(frame, omit) });
                    gpu!.drawGpu(pass, view, band, omit ?? undefined);
                    recordDraw(band, { frame, omit, ink, context });
                },
                draw2d(ctx, view) {
                    const frame = adapter?.readyFrame();
                    if (!frame) return;
                    const omit = options.omitNodes?.(frame) ?? null;
                    const ink = adapter!.borrowPrepared()?.root.inkNodeIds ?? frame.inkNodeIds;
                    if (!prepareToken) return;
                    const actualView = copyView(view);
                    const context = Object.freeze({ view: actualView, frameId: prepareFrameId,
                        paneTransform: host.paneTransform(actualView, prepareFrameId),
                        token: Object.freeze({ ...prepareToken }), omittedNodeIds: omit ? new OmittedSnapshot(omit) : null,
                        retain: () => options.frames.retain(frame), retainImages: presentedImages(frame, omit) });
                    adapter!.draw2d(ctx, view, band, omit ?? undefined);
                    recordDraw(band, { frame, omit, ink, context });
                },
                releaseGpu(reason) { clearResources(reason); },
                memory() {
                    const extra = gpu?.memory();
                    return allocatorHost === host ? { gpuBytes: extra?.gpuBytes ?? 0, cpuBytes: reserved + (dense?.memory().cpuBytes ?? 0) + (options.frames.memoryBytes?.() ?? 0) + (extra?.cpuBytes ?? 0) }
                        : { gpuBytes: 0, cpuBytes: 0 };
                },
                needsFrame() {
                    return !disposed && !ended && (options.frames.needsFrame() || (!denied && (!!estimate && !estimate.done || density.pending() || !!adapter?.needsFrame()
                        || !!host.device() && !!gpu?.needsFrame())));
                },
                onFramePresented(revision, token) { acknowledge(band, revision, token); },
                dispose() {
                    if (ended) return;
                    ended = true;
                    if (allocatorHost === host) { clearResources('pressure'); allocatorHost = null; }
                    hosts.delete(band);
                    if (!hosts.size) {
                        disposed = true; gpu?.dispose(); gpu = null; adapter?.dispose(); adapter = null;
                        deferredClear = true; collectRetired(); presented = null; refreshProgress();
                    } else if (!allocatorHost) {
                        allocatorHost = activeHost()!;
                        options.frames.bindMemory?.(allocatorHost.allocator.cpu);
                        const oldDense = dense!; oldDense.dispose(); retiringDense.add(oldDense);
                        dense = createDensePaintAdapter({ frames: options.frames, images: options.images,
                            invalidate: () => { collectRetired(); activeHost()?.invalidate('board-resource'); } }, allocatorHost, report);
                        gpu?.dispose(); gpu = createGpuPaintAdapter(adapter!, allocatorHost, report);
                    }
                },
            };
            return layer;
        },
        revision() { return options.requestedRevision(); },
        cpuWorkingSet() {
            const upcoming = !useDense && estimate?.done && !density.pending() && !reservations.has(estimate.frame) ? estimate.bytes : 0;
            const scratch = allocatorHost?.device() ? gpu?.cpuWorkingSet().mandatoryBytes ?? 0 : 0;
            return { mandatoryBytes: hosts.get(band) === allocatorHost
                ? reserved + upcoming + scratch + (useDense ? dense?.cpuWorkingSet(estimate?.maxItemBytes ?? 0) ?? 0 : 0) + (options.frames.cpuWorkingSet?.() ?? 0) : 0, prefetchBytes: 0 };
        },
        critical() { return !adapter?.readyFrame(); },
        coverage(layer, frame, backend) {
            const gpuCoverage = backend !== 'canvas2d' ? gpu?.coverage(frame.view) : null;
            const ready = backend === 'canvas2d' ? adapter?.readyFrame() : gpu?.readyFrame();
            const requested = frame.layers.find(item => item.layer === layer)?.sceneRevision;
            const denseCoverage = useDense && ready ? dense?.coverage(frame.view, liveFor(ready)) : null;
            if (useDense && !denseCoverage?.complete) return { complete: false, sharp: false };
            if (backend !== 'canvas2d' && !gpuCoverage?.complete) return { complete: false, sharp: false };
            if (!ready || !sameToken(ready.token, frame.token)) return { complete: false, sharp: false };
            const current = ready.sceneRevision === requested && ready.sceneRevision === options.requestedRevision() && options.frames.isCurrent(ready);
            return current ? { complete: true, sharp: (gpuCoverage?.sharp ?? true) && (denseCoverage?.sharp ?? true) } : { complete: false, sharp: false, staleVersion: true };
        },
    });
    const pair = [definition('underlay'), definition('content')] as unknown as BoardLayerPair;
    pair.invalidate = (reason = 'board-content') => { for (const host of hosts.values()) host.invalidate(reason); };
    pair.memory = () => allocatorHost?.allocator.cpu ?? null;
    pair.wakeAt = deadlineMs => { for (const host of hosts.values()) host.wakeAt(deadlineMs); };
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
