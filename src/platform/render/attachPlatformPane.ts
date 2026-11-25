import { auditCount, auditFrame, auditPresent, presentView, renderAuditEnabled } from './renderAudit';
import type { ViewState } from '../types';
const benchmarkMemory = __BME_BENCH__ ? await import('./benchmarkMemory') : null;
import type { DamageRecord } from './damage';
import { reportRenderPinned } from '../renderStatus';
import type { AttachPlatformPane, PlatformLayerDefinition, PlatformPaneOptions } from './attachPlatformPane.types';
import { createPaneSurfaceHost, PaneBackendSwitch } from './backendSwitch';
import { CameraController } from './camera';
import { captureGpuOwner, registerCaptureGpu } from './captureRuntime';
import { CaptureError } from './captureError';
import type { GpuCompositor } from './compositor';
import { registerWebgl2PaneFactory } from './compositorFactory';
import { GPU_RETRY_QUIET_MS, GpuPaneCandidate } from './gpuPaneCandidate';

/** How long a fresh view keeps its previous picture while its layers first draw complete and sharp. A bound, not a target. */
const FRESH_VIEW_COVER_MS = 3000;
/** How long a WebGL2 pane's resize waits on its 2D bridge before it rebuilds without one. A raise never waits on a frame that cannot
 * present: a WebGL2 PDF holding a 4000x3000 picture at 400% (DPR 2) raised its quality, the bridge's 2D frame could not fit the 41 MB CPU
 * pool (its mirror trimmed, 'mirror-unpresented'), the GPU rebuild waited on it, and nothing asked again: 'Updating' for good, about half
 * of gpu-f2's runs. A bridge that presents does so within a few frames; past this the GPU is resized directly and draws from the
 * textures it kept, the last picture standing in until the exact one lands. */
const BRIDGE_WAIT_MS = 300;
/** How long a pane must stay on canvas2d for want of a free GPU context before the person is told: a layout change can show a pane
 * a moment before its neighbour's context is released, and a notice for that would flash and vanish. */
const BUDGET_NOTICE_DELAY_MS = 1000;
import type { QualifiedGpuPane } from './gpuPaneCandidate';
import type { CameraConstraint } from './camera';
import type { CompositorAppearance, CompositorBackend, CompositorLayer, Compositor2DOptions, CreatedCompositor2D, PaneCompositor } from './compositor.types';
import { RENDER_CONSTANTS } from './constants';
import { createLayerHost } from './layerHost';
import type { MemoryCacheHandle } from './memoryGovernor';
import type { MirrorView } from './mirrorSet';
import { PaneLayerSet } from './paneLayerSet';
import { PaneLifecycle } from './paneLifecycle';
import { PaneSizeObserver } from './paneObservation';
import { getPlatformRuntime, type MemoryNotice } from './platformRuntime';
import type { ScheduledFrame, ScheduledPaneLease } from './scheduler';
import { computeSurfaceMetrics, SurfaceMetricsCommitter } from './surfaceMetrics';
import type { FrameToken, Layer, RenderToken } from './types';

export type CpuPaneFactory = <T extends object>(options: Compositor2DOptions<T>) => CreatedCompositor2D<T>;
let cpuFactory: CpuPaneFactory | null = null;

/** Called by the lazily loaded 2D implementation; registration creates no canvas or listener. */
export function registerCpuPaneFactory(factory: CpuPaneFactory): void {
    if (cpuFactory && cpuFactory !== factory) throw new Error('A CPU compositor factory is already registered');
    cpuFactory = factory;
}

const unconstrained: CameraConstraint = {
    clampZoom: z => z,
    bounds: () => ({ minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity }),
    resize: camera => ({ ...camera }),
    allowsHorizontalPan: () => true,
};

function sameDocument(a: RenderToken, b: RenderToken): boolean {
    return a.vaultEpoch === b.vaultEpoch && a.documentId === b.documentId &&
        a.bytesGeneration === b.bytesGeneration && a.session === b.session;
}

function sameFrame(a: FrameToken, b: FrameToken): boolean {
    return sameDocument(a, b) && a.viewLease === b.viewLease && a.deviceGeneration === b.deviceGeneration;
}

/** View lifetime only: the session, its source and its mirrors survive disposal. */
export const attachPlatformPane: AttachPlatformPane = <T extends object>(host: HTMLElement, options: PlatformPaneOptions<T>) => {
    if (!cpuFactory) throw new Error('Register the 2D compositor before attaching a platform pane');
    const backendPreference = options.backendPreference ?? 'auto';
    const runtime = getPlatformRuntime();
    const surfaceHost = new PaneBackendSwitch(createPaneSurfaceHost(host));
    const cpuMetrics = new SurfaceMetricsCommitter();
    const gpuMetrics = new SurfaceMetricsCommitter();
    const camera = options.camera ?? new CameraController(options.readCamera(), { width: 0, height: 0, dpr: 1 }, unconstrained);
    const caches: Array<{ cpu: MemoryCacheHandle; gpu: MemoryCacheHandle; layer: () => Layer | null }> = [];
    let cacheSerial = 0;
    let visible = false;
    let focused = options.initialFocused;
    let disposed = false;
    let frameLease: ScheduledPaneLease | null = null;
    let lifecycle: PaneLifecycle<T> | null = null;
    const compositorRef: { current: PaneCompositor | null } = { current: null };
    let lastView: ViewState = { camera: { ...camera.camera }, viewport: { ...camera.viewport }, epoch: 0, moving: false };
    let lastQuality: number | null = null;
    /** What the last real present reported, for the frames that skip it (see presentUnchanged). Cleared whenever the pane stops presenting. */
    let lastReport: { frameId: number; revision: string; backend: PaneCompositor['backend']; complete: boolean; sharp: boolean;
        staleVersion: boolean | undefined; camera: { x: number; y: number; z: number }; drawn: { x: number; y: number; z: number };
        geometry: number | undefined; appearance: CompositorAppearance } | null = null;
    // Audit only: the camera scale of the previous mirrored present, for the present's zooming flag.
    let lastMirroredScale: number | null = null;
    let sampledCamera = { ...camera.camera };
    let lastInputAt = performance.now();
    let pendingInputAt: number | null = null;
    let healthyInputAt: number | null = null;
    let lastFrameInterval: number | null = null;
    let layout = options.layout;
    let gpu: QualifiedGpuPane | null = null;
    let cpuPresented = false;
    let gpuRequested = false;
    // A complete picture (either backend) has been presented since the pane was last shown. Until then nothing is on screen for the
    // 2D picture to protect, so a GPU that qualifies first draws the first picture itself (see onReady).
    let shownPresented = false;
    /** The 2D bridge of a GPU resize: when it began (null when none is pending), whether this resize skipped it, and its wake. */
    let bridgeSince: number | null = null, bridgeSkipped = false, bridgeTimer: ReturnType<typeof setTimeout> | null = null;
    /** The pane size (physical pixels) the GPU surface was last committed for: a backing change at the same size is a quality step. */
    let gpuPhysical: { width: number; height: number } | null = null;
    // The visible-context cap is full: this pane draws on canvas2d until a slot frees (the broker's budget fallback). The person is
    // told once it has lasted BUDGET_NOTICE_DELAY_MS, and the notice is withdrawn at the pane's first GPU present.
    let budgetNoticeTimer: ReturnType<typeof setTimeout> | null = null, budgetNoticeShown = false;
    const endBudgetNotice = (): void => {
        if (budgetNoticeTimer !== null) { clearTimeout(budgetNoticeTimer); budgetNoticeTimer = null; }
        if (budgetNoticeShown) { budgetNoticeShown = false; options.onNoticeCleared?.('gpu-unavailable', 'too-many-panes'); }
    };
    const endBridge = (): void => { bridgeSince = null; if (bridgeTimer !== null) { clearTimeout(bridgeTimer); bridgeTimer = null; } };
    const drawCompositor = (): PaneCompositor | null => gpu && cpuPresented ? gpu.bundle.compositor : compositorRef.current;
    const activeMetrics = (): SurfaceMetricsCommitter => gpu && cpuPresented ? gpuMetrics : cpuMetrics;

    const token = (): FrameToken | null => {
        const current = options.currentToken();
        const drawing = drawCompositor();
        if (disposed || !current || !sameDocument(current, options.documentToken) || !drawing) return null;
        // The CPU target reflects this token, so reading its target.generation here would recurse.
        const deviceGeneration = drawing === compositorRef.current ? lifecycle?.surface.snapshot().gpuGeneration ?? 0 : drawing.target.generation;
        return { ...current, viewLease: options.viewLease, deviceGeneration };
    };
    const mirrorView = (): MirrorView | null => {
        const current = options.currentToken();
        if (!current || !sameDocument(current, options.documentToken)) return null;
        if (options.readMirrorView) return options.readMirrorView(lastView);
        if (options.session.mirrors) return null;
        return { token: current, sourceRole: '', contentRevision: options.revision(), colourVersion: 0,
            geometryDigest: '', nominalDpr: lastView.viewport.dpr, view: lastView };
    };
    // The frame this pane was last prepared or presented in. Whole-layer victims are chosen only in a frame this pane has not
    // presented: an eviction of a pane that is on screen is re-prepared the next frame and evicted again (measured: 170 'budget'
    // invalidations per 3 s on the large seed). A pane presented after the choice is released after the task, see below.
    let touchedFrame = -1;
    const touchedThisFrame = (): boolean => touchedFrame === runtime.scheduler.currentFrame();
    // Layers whose GPU release is already scheduled. Several caches of one pane can ask in the same trim; the second must not
    // count residency the first has already promised to free.
    const releasing = new Set<Layer>();
    /** Frees this pane's GPU residency, up to `bytes`, from its layers in order (or only `only`). The bytes are decided and
     * returned now, so the governor can count them, and a whole-layer victim is released in a microtask, outside any
     * reservation: the governor counts it as freed, so that release must happen (it does unless the pane is gone), and then
     * the pane is invalidated for the budget. A pane with nothing resident frees 0 and is not invalidated. */
    const trimGpu = (bytes: number, only?: Layer): number => {
        if (disposed || !visible) return 0;
        const frameId = runtime.scheduler.currentFrame();
        // A pane this frame has already prepared still gives its partial relief: each layer's evictGpu keeps what this frame
        // uses (frame-keyed for the board, drawn-tile-keyed for the PDF). Only a whole-layer release waits for a frame that is
        // not in progress, since that is what drops what the frame is composing. Gated whole, the pane refused a notebook's
        // board ink tile in every frame it painted its paper, and the paper's off-view tiles were never offered (measured: ~2 in 10 runs).
        const touched = touchedThisFrame();
        const victims: Layer[] = [];
        let freed = 0;
        for (const layer of only ? [only] : layerSet.layers) {
            if (freed >= bytes) break;
            if (releasing.has(layer)) continue;
            if (layer.memory().gpuBytes <= 0) continue;
            // A layer that can give back part of its residency does so first, synchronously, and the whole layer is released
            // only when that falls short of the ask. Without the hook the layer is released whole, as before.
            const want = bytes - freed;
            // A layer without the hook frees nothing here and is released whole; a non-finite report counts as nothing freed.
            const reported = layer.evictGpu ? layer.evictGpu(want, frameId) : 0;
            const partial = Number.isFinite(reported) ? Math.max(0, reported) : 0;
            if (partial > 0) {
                freed += partial;
                auditCount('governor', `evict-partial:${layerSet.definition(layer)?.id ?? 'unnamed'}`, 1, { bytes: partial });
            }
            if (partial >= want) break;
            // A layer that frees part of itself has already given every position it does not need on screen. What it keeps
            // is its visible set, which is pinned: releasing it whole here dropped a board's on-screen tiles under a trim.
            // Such a layer is refused instead, and the refused position is composed at a lower level (h1's 'lower').
            if (layer.evictGpu || touched) continue;
            const remaining = layer.memory().gpuBytes;
            if (remaining <= 0) continue;
            victims.push(layer);
            releasing.add(layer);
            freed += remaining;
        }
        // The partial relief above is freed already: a trim with no whole-layer victim reported 0 for it, so the governor credited a
        // board that gave back 4.26 MB of tiles with nothing and refused the PDF beside it (doc12, WebGL2, at rest).
        if (!victims.length) return freed;
        queueMicrotask(() => {
            for (const layer of victims) releasing.delete(layer);
            // The victims were chosen in a frame this pane had not presented, and the bytes above were counted on that promise.
            // The release is kept: it runs after the task that presented this pane (the picture on screen is already drawn), so
            // the only cost of a later paint is re-rastering the victims, which the next prepare does when they are still wanted.
            // Only a pane that is gone keeps them: its caches have already left the governor's books.
            if (disposed || !visible) return;
            // Releasing a visible pane's whole working set dropped the plans on screen (a notebook's paper and board) on each
            // eviction, so only the layers the governor asked for are released. The pane is repainted for the budget only when a
            // release actually freed bytes: a layer that is already gone, or one the lifecycle refused to release, leaves the
            // picture as it is and asks for no frame. A promised release that did not free its bytes is audited by name.
            let released = false;
            for (const layer of victims) {
                if (!layerSet.layers.includes(layer)) continue;
                const before = layer.memory().gpuBytes;
                lifecycle?.releaseLayerGpu(layer, 'pressure');
                const after = layer.memory().gpuBytes;
                if (after < before) released = true;
                else if (after > 0 && renderAuditEnabled()) auditCount('governor', `evict-unrealized:${layerSet.definition(layer)?.id ?? 'unnamed'}`, 1, { bytes: after });
            }
            if (released) lifecycle?.invalidate('budget');
        });
        return freed;
    };
    // A layer's declared demand changes between refreshes (a plan starts, a session bitmap is kept or dropped, a run is
    // refused). Each change marks the pane dirty; one refresh runs on the next microtask, however many changes landed.
    let demandQueued = false;
    const requestDemand = (): void => {
        if (demandQueued || disposed) return;
        demandQueued = true;
        queueMicrotask(() => { demandQueued = false; if (!disposed) runtime.refresh(); });
    };
    // A cache's reserved bytes include any accounting fault the governor has charged (it never throws out of a readout).
    const heldBytes = (cache: MemoryCacheHandle | undefined): number => cache ? cache.readout().reservedBytes : 0;
    const layerSet = new PaneLayerSet((id, current, definition) => {
        const now = performance.now();
        const common = { paneId: options.paneId, owner: options.documentToken, hiddenAt: visible ? null : now,
            lastVisibleAt: now, lastUsedAt: now, class: 'scene-cache' as const };
        const cacheId = `${options.paneId}:${options.viewLease}:${id}:${++cacheSerial}`;
        const cpu = runtime.governor.register({ ...common, id: `${cacheId}:cpu`, pool: 'cpu', kind: 'working', liveInput: definition.liveInput === true, foreground: definition.foregroundCpu === true,
            memory: () => ({ live: current()?.memory().cpuBytes ?? 0, retiring: 0 }),
            // The layer names what it can rebuild; without the hook nothing in this cache is reclaimable, and the bytes its
            // drop measures are the bytes freed. A hidden pane draws no frame, so this frame's touch protects nothing of it: gated on
            // it, the governor's ask at hide (releaseHiddenPane) came in the frame the pane last presented and was refused.
            evict: bytes => {
                const layer = current();
                if (!layer || (visible && touchedThisFrame())) return 0;
                const before = layer.memory().cpuBytes;
                layerSet.definition(layer)?.cpuEvict?.(layer, bytes);
                return Math.max(0, before - layer.memory().cpuBytes);
            } });
        let gpuCache: MemoryCacheHandle;
        try {
            gpuCache = runtime.governor.register({ ...common, id: `${cacheId}:gpu`, pool: 'gpu',
                kind: definition.liveInput ? 'live-input' : 'working',
                memory: () => ({ live: current()?.memory().gpuBytes ?? 0, retiring: 0 }),
                // Evict this layer's GPU cache, not the pane's: the governor names the cache it wants back.
                evict: bytes => { const layer = current(); return layer ? trimGpu(bytes, layer) : 0; } });
        } catch (error) { cpu.close(); throw error; }
        caches.push({ cpu, gpu: gpuCache, layer: current });
        return createLayerHost({
            auditId: id,
            // The pane's current CPU grant: a layer sizes its CPU working set against it (0 while the pane has none).
            allocator: { cpu, gpu: gpuCache, cpuGrantBytes: () => runtime.governor.grant(options.paneId)?.cpuBytes ?? 0 },
            generation: () => lifecycle?.surface.snapshot().gpuGeneration ?? 0,
            // The governor's read-only state, so a layer sheds work under 'slow-gpu' or 'pressure' (h10's LayerHost.trouble).
            trouble: () => runtime.governor.trouble(),
            // A GPU error a layer caught (an acquisition or prepare error on the device route) demotes the pane, the same way a
            // compositor error does: counted and logged once per generation, and the open does not fail on it.
            gpuError: error => candidate.fail(error, 'layer'),
            // GPU uploads cannot gate CPU source acquisition, including the resize bridge.
            gpuResources: () => {
                if (!gpu || !cpuPresented) return null;
                const preparing = drawCompositor()?.resources;
                return preparing?.device ? preparing : null;
            }, compositor: drawCompositor,
            preparationCompositor: drawCompositor,
            invalidate: (reason, damage) => lifecycle?.invalidate(reason, damage),
            wakeAt: deadline => { const layer = current(); if (layer) frameLease?.wakeAt(layer, deadline); },
            demandChanged: requestDemand,
            refreshDemandNow: () => { if (!disposed) runtime.refresh(); },
        });
    });
    // The compositor's view of the layers. Its critical() is the definition's, judged on each frame's view: a layer whose
    // content a stand-in covers is non-critical and presents with it (PLAN issue 3). Rebuilt only when the layer set changes.
    // A fresh view's layers (attached by beginFreshView, never a layer added mid-life) report incomplete until each first draws
    // complete and sharp: the frame is refused and the picture on screen stays the previous one (the cover). Bounded by
    // FRESH_VIEW_COVER_MS, so a stuck build releases to today's behaviour, counted as fresh-cover:expired.
    const freshLayers = new Set<unknown>();
    let freshSince = 0;
    let freshTimer: ReturnType<typeof setTimeout> | null = null;
    const compositorLayers = (): readonly CompositorLayer[] => layerSet.compositorLayers.map(binding => ({
        ...binding,
        critical: (frame: ScheduledFrame) => layerSet.definition(binding.layer)?.critical(binding.layer, frame.view) ?? true,
        coverage: (frame: ScheduledFrame, backend: CompositorBackend) => {
            const coverage = binding.coverage(frame, backend);
            if (!freshLayers.has(binding.layer)) return coverage;
            if (coverage.complete && coverage.sharp) { freshLayers.delete(binding.layer); return coverage; }
            if (performance.now() - freshSince > FRESH_VIEW_COVER_MS) { freshLayers.delete(binding.layer); auditCount('pane', 'fresh-cover:expired'); return coverage; }
            return { ...coverage, complete: false };
        },
    }));
    try { layerSet.replace(options.layers); }
    catch (error) {
        for (const cache of caches) { cache.cpu.close(); cache.gpu.close(); }
        throw error;
    }

    let created: CreatedCompositor2D<T>;
    try { created = cpuFactory<T>({
        paneId: options.paneId, governor: runtime.governor, currentToken: token,
        invalidate: reason => lifecycle?.invalidate(reason), recordUpload: (bytes, ms) => runtime.scheduler.recordUpload(bytes, ms),
        select2D: cpu => {
            if (disposed) return;
            if (gpu && surfaceHost.current === gpu.bundle.compositor &&
                (gpu.grant.canvas.width || gpu.grant.canvas.height || gpu.backing.reservedBytes)) {
                // CPU has already submitted its complete detached bridge. Return the old
                // display credit before promoting it; both were never charged as two displays.
                const zeroed = gpu.backing.resize(0, 0, gpu.grant.resizeSurface);
                if (!zeroed?.complete) throw new Error('Could not relinquish the GPU display backing');
                gpu.backing.stage();
            }
            if (cpu.promoteSurface?.() === false) throw new Error('CPU backing promotion was refused');
            surfaceHost.select(cpu);
        },
        selectGpu: grant => {
            if (!gpu || gpu.grant.generation !== grant.generation) return false;
            const memoryGrant = runtime.governor.grant(options.paneId);
            const memory = runtime.governor.readout().gpu;
            if (!memoryGrant || gpu.backing.reservedBytes > memoryGrant.pixelGrant * RENDER_CONSTANTS.surfaceReserveBytesPerPixel ||
                memory.chargedBytes > memory.targetBytes) {
                // A ready GPU held behind the 2D picture for memory: the screen stays canvas2d, so it is counted like any other
                // fallback (it was the one hold with no counter).
                if (renderAuditEnabled()) auditCount('pane', `fallback:gpu-held:${!memoryGrant ? 'no-grant' : memory.chargedBytes > memory.targetBytes ? 'over-target' : 'pixel-grant'}`);
                lifecycle?.invalidate('budget');
                return false;
            }
            created.presenter.releaseSurface();
            if (!gpu.backing.promote()) {
                auditCount('pane', 'fallback:gpu-held:promote-refused');
                const surface = lifecycle?.surface;
                surface?.failGpu(surface.stamp, grant.generation, 'out-of-budget', false);
                return false;
            }
            surfaceHost.select(gpu.bundle.compositor);
            return true;
        },
        mirrorQuad: (entry, view) => options.mirrorQuad?.(entry, view) ?? null,
        mirrorCoverage: (view, entries) => options.mirrorCoverage?.(view, entries) ?? { complete: false, sharp: false },
    }); } catch (error) {
        for (const layer of layerSet.layers) layer.dispose();
        for (const cache of caches) { cache.cpu.close(); cache.gpu.close(); }
        throw error;
    }
    const compositor = created.compositor;
    compositorRef.current = compositor;
    compositor.setLayers(compositorLayers());
    compositor.setLayout(options.layout);
    compositor.setAppearance(options.readAppearance());

    const observer = new PaneSizeObserver(host, size => {
        if (disposed) return;
        if (visible) lifecycle?.showPane({ visible: true, focused, cssWidth: size.cssWidth, cssHeight: size.cssHeight, lastInputAt });
        runtime.refresh();
        lifecycle?.invalidate('geometry');
    }, options.onError);
    // The inputs the pane's demand is built from that move without an event of their own: size, visibility, focus, colour
    // mode, mirrors, and what the layers hold. Reading them is a few numbers; the demand and the governor's plan are not, so
    // they run only when one of these moved. A layer's own demand change (a plan, a refused run) still asks via requestDemand.
    let demandMark: { pixels: number; visible: boolean; focused: boolean; inverted: boolean; mirrors: boolean; gpu: number; cpu: number } | null = null;
    const demandMoved = (): boolean => {
        const size = observer.current;
        let gpu = 0, cpu = 0;
        for (const layer of layerSet.layers) { const held = layer.memory(); gpu += held.gpuBytes; cpu += held.cpuBytes; }
        const next = { pixels: size ? size.physical.width * size.physical.height : 0, visible, focused,
            inverted: options.readAppearance().inverted, mirrors: !!options.session.mirrors, gpu, cpu };
        const old = demandMark;
        demandMark = next;
        return !old || old.pixels !== next.pixels || old.visible !== next.visible || old.focused !== next.focused
            || old.inverted !== next.inverted || old.mirrors !== next.mirrors || old.gpu !== next.gpu || old.cpu !== next.cpu;
    };
    const runtimePane = {
        demand: () => {
            const size = observer.current;
            const memory = layerSet.layers.map(layer => layer.memory());
            const requestedPixels = size ? size.physical.width * size.physical.height : 0;
            const tilePixels = (RENDER_CONSTANTS.tileInteriorPixels + 2 * RENDER_CONSTANTS.tileGutterTexels) ** 2;
            const bandPixels = Math.min(requestedPixels, tilePixels);
            const isolated = layerSet.compositorLayers.filter(binding => binding.isolation).length;
            // CPU's retained back frame coexists with the staged GPU backing and its
            // document-colour target until promotion. Inversion is not a free surface effect.
            const frameCopies = 2 + Number(options.readAppearance().inverted) + Number(!!options.session.mirrors) + isolated;
            // The 2D canvas's CPU working cache is charged to this pane, so its bytes are part of the demand the grant covers.
            let mandatory = created.compositor.cpuWorkingBytes?.() ?? 0, prefetch = 0, pinned = 0;
            for (const layer of layerSet.layers) {
                // A layer's visible positions are GPU bytes the pane must keep; the governor grants them before any other need.
                if (requestedPixels > 0) pinned += layerSet.definition(layer)?.gpuWorkingSet?.(layer, size!.physical).mandatoryBytes ?? 0;
                // An unobserved/zero box has no drawable viewport. Asking a producer for an
                // artificial 0×0 floor can deny it before ResizeObserver has published its size.
                const demand = requestedPixels > 0 ? layerSet.definition(layer)?.cpuWorkingSet?.(layer, size!.physical) : undefined;
                // Leases charged to the layer's cache beyond what the layer itself reports (session rasters, tile runs, frame
                // blocks) are still this pane's: left out, a dense board declared 2.7 MB over a 0.5 MB self-count while its
                // cache held 6-9 MB, the grant sat at the pane floor and every next 1 MB tile was refused after a return.
                const own = layer.memory().cpuBytes, held = heldBytes(caches.find(cache => cache.layer() === layer)?.cpu);
                // The declared working set is the floor; what the layer holds beyond it is need that competes after every
                // floor, and reclaimable on refusal. Holding counted as floor made a long PDF's stale pages (28 MB held over
                // an 11.9 MB view) the whole CPU target after a zoom out: the floor was denied and nothing presented again.
                const floor = demand ? demand.mandatoryBytes : own;
                mandatory += floor;
                prefetch += (demand?.prefetchBytes ?? 0) + Math.max(0, Math.max(own, held) - floor);
            }
            const cpuMandatoryBytes = requestedPixels ? Math.max(mandatory, requestedPixels * RENDER_CONSTANTS.decodedRgbaBytesPerPixel) +
                (requestedPixels + bandPixels) * 4 : 0;
            return { paneId: options.paneId, visible, focused, requestedPixels, devicePixelRatio: size?.nominalDpr ?? 1,
                // Needs stay inside G/C: detached CPU completion, staged GPU, mirror/effect targets,
                // native bitmap residency and one bounded colour band do not raise either cap.
                gpuPinnedBytes: pinned,
                gpuNeedBytes: memory.reduce((sum, value) => sum + value.gpuBytes, 0) +
                    (frameCopies * requestedPixels + bandPixels) * RENDER_CONSTANTS.surfaceReserveBytesPerPixel + requestedPixels * 4,
                // Working-set demand precedes allocations; prefetch competes only after all visible floors.
                cpuMandatoryBytes, cpuNeedBytes: cpuMandatoryBytes + prefetch,
                cpuPinned: lifecycle?.surface.snapshot().state === 'cpu-pinned' };
        },
        interacting: options.isInteracting,
        windowVisibility: (windowVisible: boolean) => {
            if (!windowVisible) { lastReport = null; options.onPresentation(null); return; }
            const state = lifecycle?.surface.snapshot().state;
            if (state !== 'gpu-visible' && state !== 'rebuilding') {
                gpu = null;
                cpuPresented = false;
                gpuRequested = false;
                surfaceHost.clearStaged();
            }
        },
        notice: (message: MemoryNotice) => options.onNotice(message),
        noticeCleared: (message: MemoryNotice) => options.onNoticeCleared?.(message),
        error: options.onError,
    };
    const removeRuntime = runtime.add(options.paneId, runtimePane);
    let removeCapture = (): void => {};
    registerWebgl2PaneFactory();
    const candidate = new GpuPaneCandidate({
        runtime, paneId: options.paneId, viewLease: options.viewLease, owner: options.documentToken,
        surface: () => lifecycle?.surface ?? null,
        invalidate: reason => lifecycle?.invalidate(reason),
        inputHealthy: () => healthyInputAt !== null && performance.now() - healthyInputAt <= RENDER_CONSTANTS.stalledFenceMs,
        quiet: () => !options.isInteracting() && performance.now() - lastInputAt >= GPU_RETRY_QUIET_MS,
        frameInterval: () => lastFrameInterval,
        onEvict: bytes => trimGpu(bytes),
        onReady: ready => {
            if (disposed || !visible) return;
            gpu = ready;
            gpu.bundle.compositor.setLayers(compositorLayers());
            gpu.bundle.compositor.setLayout(layout);
            gpu.bundle.compositor.setAppearance(options.readAppearance());
            surfaceHost.stage(gpu.bundle.compositor);
            // The GPU is asked for as soon as the pane has a size, beside the first 2D picture. Ready before that picture was
            // presented, it draws the first picture: the 2D one was only a bridge to it, and a dense board's 2D picture is a CPU
            // raster of every stroke (measured, WebGL2: Notes4 4 s, Strokes-3 8.5 s of main thread before the GPU was even asked).
            if (!cpuPresented && !shownPresented && bridgeSince === null) cpuPresented = true;
            lifecycle?.invalidate('gpu-ready');
        },
    });
    const requestGpu = (): void => {
        if (backendPreference === 'canvas2d' || disposed || !visible || gpuRequested || !lifecycle) return;
        gpuRequested = true;
        const canvas = host.ownerDocument.createElement('canvas');
        canvas.width = 0; canvas.height = 0;
        // A failed GPU request demotes this pane; it is not the document's failure. A request the broker could not consider (the pane
        // not drawable yet, or a newer surface) is asked again by the next frame that has a size.
        void lifecycle.surface.requestGpu(canvas, lifecycle.surface.stamp)
            .then(result => { if (result.kind === 'ineligible' || result.kind === 'stale') gpuRequested = false; })
            .catch(error => candidate.fail(error, 'request'));
    };
    try {
        lifecycle = new PaneLifecycle<T>({
            host: runtime.lifecycles,
            registration: { paneId: options.paneId, viewLease: options.viewLease, documentToken: options.documentToken,
                view: { visible: false, focused, cssWidth: 0, cssHeight: 0, lastInputAt },
                callbacks: {
                    prepareGpu: preparation => candidate.prepare(preparation),
                    onSurfaceZeroed: canvas => candidate.zeroed(canvas),
                    onGpuReady: grant => candidate.ready(grant),
                    onCapabilityFailure: () => runtime.observeCapabilityFailure(options.paneId),
                    onCpuFallback: reason => {
                        auditCount('pane', `fallback:pane-2d:${reason}`);
                        if (reason === 'budget' && budgetNoticeTimer === null && !budgetNoticeShown) {
                            budgetNoticeTimer = setTimeout(() => {
                                budgetNoticeTimer = null;
                                if (disposed || !visible || (gpu && surfaceHost.current === gpu.bundle.compositor)) return;
                                budgetNoticeShown = true;
                                auditCount('pane', 'notice:too-many-panes');
                                options.onNotice('gpu-unavailable', 'too-many-panes');
                            }, BUDGET_NOTICE_DELAY_MS);
                        }
                        gpu = null;
                        cpuPresented = false;
                        endBridge(); bridgeSkipped = false;
                        surfaceHost.clearStaged();
                        lastReport = null; options.onPresentation(null);
                        // Every fallback, a GPU error included, needs a frame now: the GPU frame that failed may have cleared the
                        // canvas, and only a 2D frame repaints it. Without this the pane waited for an unrelated change.
                        lifecycle?.invalidate('cpu-fallback');
                        if (reason === 'context-lost') runtime.trouble('context-loss');
                    },
                    onSlotAvailable: () => { gpuRequested = false; requestGpu(); },
                    onPinned: () => { reportRenderPinned(); options.onNotice('cpu-pinned'); },
                    // No usable GPU for this pane (the broker says it once per cause): the person sees why it draws in a compatible mode.
                    onGpuUnavailable: cause => options.onNotice('gpu-unavailable', cause),
                } },
            session: options.session, layers: layerSet.layers, presenter: created.presenter,
            registerFrames: () => {
                const pane = {
                    paneId: options.paneId, camera, layers: layerSet.layers, get metrics() { return activeMetrics(); }, focused,
                    currentToken: token,
                    commitMetrics: (frameId: number) => {
                        const size = observer.readForFrame(frameId);
                        const grant = runtime.governor.grant(options.paneId);
                        if (!size || !grant) return null;
                        // A bridge that has not presented within BRIDGE_WAIT_MS is skipped: the GPU, still displayed, is resized below.
                        if (!cpuPresented && gpu && bridgeSince !== null && performance.now() - bridgeSince >= BRIDGE_WAIT_MS) {
                            auditCount('pane', 'fallback:2d-bridge-skipped');
                            endBridge();
                            bridgeSkipped = true;
                            cpuPresented = true;
                        }
                        let drawing = drawCompositor();
                        if (!drawing) return null;
                        let planned = computeSurfaceMetrics(size.physical, size.nominalDpr, drawing.target.limits, grant.pixelGrant);
                        // The pane has a drawable size: its GPU is asked for now, not after the first 2D picture (see onReady).
                        if (drawing === compositor && !gpuRequested && planned.kind === 'ready') queueMicrotask(requestGpu);
                        // Only a pane whose own size changed is bridged. A backing that changes with the pane's size unchanged is a quality step:
                        // the GPU draws the new backing at once from the tiles it keeps, and a bridge then rastered a dense board on the CPU,
                        // was refused, and that refusal stepped the quality down again, so every raise was undone (measured, three dense boards
                        // on WebGL2 after divider drags: 7 bridges and 27 unmet CPU trims per 10 s at rest, quality 0.64; at deviceMemory 2,
                        // 13 bridges, 363 presents and 13 s of CPU per 10 s).
                        const resized = gpuPhysical === null || gpuPhysical.width !== size.physical.width || gpuPhysical.height !== size.physical.height;
                        const backingChanges = drawing !== compositor && planned.kind === 'ready' &&
                            (drawing.surface.width !== planned.backingWidth || drawing.surface.height !== planned.backingHeight);
                        if (backingChanges && !resized && surfaceHost.current === drawing) auditCount('pane', 'bridge:none:quality');
                        if (!bridgeSkipped && resized && backingChanges && surfaceHost.current === drawing && planned.kind === 'ready') {
                            // Resizing a displayed GL canvas destroys its last complete pixels before
                            // layers can prepare the new viewport. Build the normal CPU bridge detached,
                            // then resize/rebuild this SAME kept GPU behind that complete picture.
                            cpuPresented = false;
                            if (bridgeSince === null) {
                                bridgeSince = performance.now();
                                // Nothing else asks for a frame while a bridge that cannot present waits: this wake does.
                                bridgeTimer = setTimeout(() => { bridgeTimer = null; if (!disposed && bridgeSince !== null) lifecycle?.invalidate('bridge-wait'); },
                                    BRIDGE_WAIT_MS + 1);
                            }
                            // The bridge is board content rastered on the CPU while the device exists: counted with its pixels.
                            auditCount('pane', 'fallback:2d-bridge', 1, { px: size.physical.width * size.physical.height });
                            const shown = drawing.surface.width * drawing.surface.height;
                            drawing = compositor;
                            // The bridge stands in for the picture on screen while the GL canvas rebuilds, so it needs no more pixels
                            // than that picture has: its back buffer and its staged display are both charged at the surface reserve,
                            // on top of the kept GPU display and caches. At the grant it did not fit (measured, WebGL2 DPR 2 annotated
                            // PDF, raise 0.8 -> 1.0: 2 x 32.7 MB of bridge beside 57 MB of GPU, pool 116 MB): the raise was refused,
                            // quality stepped back to 0.8 every 5 s, and the editing cover, which waits for a sharp frame, never lifted.
                            planned = computeSurfaceMetrics(size.physical, size.nominalDpr, drawing.target.limits,
                                shown > 0 ? Math.min(grant.pixelGrant, shown) : grant.pixelGrant);
                        }
                        const result = activeMetrics().commit(frameId, size.generation, planned, drawing.target);
                        if (result?.kind === 'ready') drawing.setMetrics(result.metrics);
                        if (result?.kind === 'ready' && drawing !== compositor) gpuPhysical = { width: size.physical.width, height: size.physical.height };
                        if (result?.kind !== 'failed') return result;
                        // A governor refusal is pressure the governor has already answered with its own quality step. The pane keeps
                        // its complete picture and waits for capacity; it is neither a framebuffer fault nor a reason to fall back to
                        // 2D, whose working canvases need more of the same pool (the fallback refused too, and the loop cycled 1.0 <-> 0.8).
                        if (result.reason === 'refused') return result;
                        const failedGeneration = gpu?.grant.generation;
                        runtime.trouble('framebuffer');
                        if (drawing === compositor || !lifecycle) return result;
                        if (failedGeneration !== undefined) lifecycle.surface.failGpu(lifecycle.surface.stamp, failedGeneration, 'creation-failed', false);
                        const fallback = computeSurfaceMetrics(size.physical, size.nominalDpr, compositor.target.limits,
                            runtime.governor.grant(options.paneId)?.pixelGrant ?? 0);
                        const cpu = cpuMetrics.commit(frameId, size.generation, fallback, compositor.target);
                        if (cpu?.kind === 'ready') compositor.setMetrics(cpu.metrics);
                        return cpu;
                    },
                    consumeInput: (time: number) => {
                        options.consumeInput(time);
                        if (pendingInputAt !== null) {
                            const now = performance.now();
                            if (now - pendingInputAt <= RENDER_CONSTANTS.stalledFenceMs) healthyInputAt = now;
                            pendingInputAt = null;
                        }
                        const next = options.readCamera();
                        if (next.x !== sampledCamera.x || next.y !== sampledCamera.y || next.z !== sampledCamera.z) camera.setCamera(next);
                        sampledCamera = { ...next };
                    },
                    isInteracting: options.isInteracting,
                    snapshotScene: (view: ViewState) => {
                        lastView = view;
                        const nextLayout = options.readLayout ? options.readLayout() : options.layout;
                        if (nextLayout !== layout) {
                            layout = nextLayout;
                            compositor.setLayout(layout);
                            gpu?.bundle.compositor.setLayout(layout);
                        }
                        const drawing = drawCompositor();
                        drawing?.setAppearance(options.readAppearance());
                        drawing?.snapshot(view);
                        // Arrivals and colour-mode changes alter demand without a ResizeObserver event. Refresh before
                        // preparation, not after an allocation was refused; a layer's own demand change asks through requestDemand.
                        if (demandMoved()) runtime.refresh();
                    },
                    layerId: (layer: Layer) => layerSet.definition(layer)?.id ?? 'unnamed',
                    // The scheduler offers a pane its own error first. A failure of this pane's GPU work (its compositor, not the 2D path
                    // or the document) demotes the pane to canvas2d, and the board stays open.
                    recover: (error: unknown) => {
                        if (!gpu || !cpuPresented) return false;
                        candidate.fail(error, 'frame');
                        return true;
                    },
                    sceneRevision: (layer: Layer) => layerSet.definition(layer)?.revision(layer) ?? 0,
                    isCritical: (layer: Layer, view: ViewState) => layerSet.definition(layer)?.critical(layer, view) ?? false,
                    progressUploadBytes: () => drawCompositor()?.progressUploadBytes?.() ?? 0,
                    prepareFrame: (frame: ScheduledFrame, budget: Parameters<PaneCompositor['prepareFrame']>[1]) => {
                        touchedFrame = frame.frameId;
                        // What this frame shows is stamped before any layer prepares, so the frame's own partial relief leaves it.
                        for (const meta of frame.layers) meta.layer.protectFrame?.(frame.frameId, frame.view);
                        const drawing = drawCompositor();
                        drawing?.prepareFrame(frame, budget);
                        const mirror = mirrorView();
                        if (drawing === compositor && mirror && options.session.mirrors) lifecycle?.prepare2D(mirror, budget);
                    },
                    finishPrepareFrame: (frame: ScheduledFrame, budget: Parameters<PaneCompositor['prepareFrame']>[1]) => {
                        drawCompositor()?.finishPrepareFrame?.(frame, budget);
                    },
                    encode: (frame: ScheduledFrame, changed: boolean) => {
                        lastFrameInterval = frame.intervalMs;
                        const drawing = drawCompositor();
                        if (!drawing) return null;
                        // The 2D compositor draws this frame while a device exists (the bridge, or a pane whose GPU is not yet
                        // presented): board content rastered on the CPU, counted with the pixels it covers.
                        if (drawing === compositor && gpu && renderAuditEnabled()) {
                            auditCount('pane', 'cpu-raster', 1, { px: drawing.surface.width * drawing.surface.height });
                        }
                        const encodeStart = performance.now();
                        const encoding = drawing.encode(frame, changed);
                        if (!encoding && !(drawing === compositor && options.session.mirrors)) return null;
                        const revision = options.revision();
                        const sourceCamera = sampledCamera;
                        return {
                            discard: () => { lifecycle?.discardFrame(frame.frameId); encoding?.discard(); },
                            submit: () => {
                                const mirror = drawing === compositor && options.session.mirrors ? lifecycle?.submit2D(frame.frameId) : null;
                                const mirrored = !!mirror?.presented && mirror.complete;
                                let presented;
                                let complete: boolean;
                                let sharp: boolean;
                                let staleVersion: boolean | undefined;
                                let qualityScale: number;
                                if (mirrored) {
                                    encoding?.discard();
                                    presented = { drawn: [], ...(__BME_BENCH__ ? { commitObservation: mirror!.commitObservation,
                                        cancelObservation: mirror!.cancelObservation } : {}) };
                                    complete = mirror!.complete;
                                    sharp = mirror!.sharp;
                                    staleVersion = mirror!.staleVersion;
                                    qualityScale = cpuMetrics.current?.kind === 'ready' ? cpuMetrics.current.metrics.qualityScale : 1;
                                } else {
                                    presented = encoding?.submit();
                                    if (!presented) return null;
                                    const coverage = drawing.coverage(frame);
                                    if (!coverage.presented || coverage.frameId !== frame.frameId || !sameFrame(coverage.token, frame.token)) {
                                        if (__BME_BENCH__) presented.cancelObservation?.();
                                        return null;
                                    }
                                    complete = coverage.complete;
                                    sharp = coverage.sharp;
                                    staleVersion = coverage.staleVersion;
                                    qualityScale = coverage.qualityScale;
                                }
                                const current = token();
                                const liveCamera = options.readCamera();
                                const geometry = observer.current;
                                if (!complete || !current || !sameFrame(current, frame.token) || options.revision() !== revision ||
                                    (liveCamera.x !== sourceCamera.x || liveCamera.y !== sourceCamera.y || liveCamera.z !== sourceCamera.z) ||
                                    geometry?.generation !== activeMetrics().current?.tags.geometryGeneration) {
                                    if (__BME_BENCH__) presented.cancelObservation?.();
                                    return null;
                                }
                                if (drawing === compositor) {
                                    lifecycle?.note2DPresented(frame.token, revision);
                                    cpuPresented = true;
                                    endBridge();
                                } else if (surfaceHost.current !== drawing) {
                                    const view = mirrorView();
                                    if (!view || !gpu || !lifecycle?.presentGpu(gpu.grant, frame.token, view, revision, complete, !shownPresented)) {
                                        if (__BME_BENCH__) presented.cancelObservation?.();
                                        return null;
                                    }
                                }
                                // A mirrored frame is presented from the 2D mirror without an encode: it is recorded here, as the 2D
                                // compositor records its own, so the present audit counts every presented frame. The mirror is a 2D picture: canvas2d.
                                if (mirrored && renderAuditEnabled()) {
                                    const scale = frame.view.camera.z;
                                    const zooming = lastMirroredScale !== null && scale !== lastMirroredScale;
                                    lastMirroredScale = scale;
                                    auditPresent({ pane: options.paneId, frame: frame.frameId, rawTick: frame.timestamp, view: presentView(frame.view), backend: 'canvas2d',
                                        layersComplete: complete, canvas: null, standIns: 0, standInsRaster: 0, holes: 0, zooming,
                                        refusal: null });
                                }
                                auditFrame(drawing.backend, performance.now() - encodeStart);
                                touchedFrame = frame.frameId;
                                shownPresented = true;
                                if (qualityScale < 1) auditCount('pane', 'quality-below-1');
                                if (drawing !== compositor) {
                                    candidate.presented(frame.token.deviceGeneration); bridgeSkipped = false; if (budgetNoticeTimer !== null || budgetNoticeShown) endBudgetNotice();
                                    // The GPU presents on its own display with no bridge pending: a 2D bridge it skipped (or overtook) still
                                    // held its back buffer and staged display, which only a switch to the GPU gave back (selectGpu). Kept, they
                                    // were 'canvas-working' and 'surface-scratch' charges no frame drew (measured, three dense panes after six
                                    // divider drags on WebGL2: 18.5 MB at rest, which held the GPU pool over its cool line, so a quality lowered
                                    // for the drags never stepped back up).
                                    if (bridgeSince === null && surfaceHost.current === drawing && created.presenter.holdsSurface()) {
                                        created.presenter.releaseSurface();
                                        auditCount('pane', 'bridge:released');
                                    }
                                }
                                lastReport = { frameId: frame.frameId, revision, backend: drawing.backend, complete, sharp, staleVersion,
                                    camera: { x: liveCamera.x, y: liveCamera.y, z: liveCamera.z },
                                    drawn: { x: frame.view.camera.x, y: frame.view.camera.y, z: frame.view.camera.z }, geometry: geometry?.generation,
                                    appearance: options.readAppearance() };
                                options.onPresentation({ frameId: frame.frameId, token: frame.token, backend: drawing.backend,
                                    complete, sharp, staleVersion,
                                    viewEpoch: frame.view.epoch, revision, drawnFrameId: frame.frameId });
                                if (lastQuality !== qualityScale) {
                                    lastQuality = qualityScale;
                                    options.onQualityChange?.({ qualityScale });
                                }
                                if (drawing === compositor) queueMicrotask(requestGpu);
                                return presented;
                            },
                        };
                    },
                    // A frame whose layers all answered unchanged is presented without encode or submit: the picture on screen is the one
                    // it would draw. It reports what the last real present reported, and only for the same token, revision, camera,
                    // geometry and backend; anything else returns false and the scheduler encodes the frame as usual.
                    presentUnchanged: (frame: ScheduledFrame): boolean => {
                        const last = lastReport;
                        const drawing = drawCompositor();
                        if (!last || !drawing || drawing.backend !== last.backend || disposed) return false;
                        const current = token();
                        // The frame's own camera (as drawn: snapped to the pixel grid, not the live value) decides what it would draw: it
                        // must be the one on screen.
                        const drawn = frame.view.camera;
                        if (!current || !sameFrame(current, frame.token) || options.revision() !== last.revision ||
                            drawn.x !== last.drawn.x || drawn.y !== last.drawn.y || drawn.z !== last.drawn.z ||
                            observer.current?.generation !== last.geometry) return false;
                        // Inversion and the surround are the compositor's, not a layer's: every layer answers unchanged when only they
                        // move, so the frame was skipped and the picture on screen kept the old colours (measured, Annotate: Invert
                        // pressed 6 times, aria-pressed flipped, page luminance 255 at 1.5 s each time on both backends; WebGL2 counted
                        // draws-changed:inverted and no present; it showed only when a scroll repainted). Such a frame is encoded.
                        const appearance = options.readAppearance();
                        if (appearance.inverted !== last.appearance.inverted
                            || appearance.background.some((value, i) => value !== last.appearance.background[i])) {
                            if (renderAuditEnabled()) auditCount('pane', 'present-kept:appearance');
                            return false;
                        }
                        // The camera has moved past this frame (input after its snapshot): a real present at a stale camera reports nothing
                        // either (see the present path), so this one skips and reports nothing. Refused, it presented the picture already on
                        // screen (measured, doc12 paced pan: 1 redundant present, unchanged-refused:camera with every layer unchanged).
                        const liveCamera = options.readCamera();
                        if (liveCamera.x !== last.camera.x || liveCamera.y !== last.camera.y || liveCamera.z !== last.camera.z) return true;
                        // The picture on screen was reported unsharp, and the layers have since finished it off screen (tiles composed in a
                        // skipped frame): present it for real, once, so its sharp report reaches the presentation's consumers. Repeating the
                        // unsharp report kept a loaded embed hidden for good (an embed is shown only on a sharp presentation; measured,
                        // WebGL2 DPR 2 drawing: 25 skipped frames after Load, each reporting the last real present's dirty tiles).
                        if (!last.sharp && drawing.nowSharp?.(frame)) { if (renderAuditEnabled()) auditCount('pane', 'present-kept:sharpened'); return false; }
                        options.onPresentation({ frameId: frame.frameId, token: frame.token, backend: last.backend, complete: last.complete,
                            sharp: last.sharp, staleVersion: last.staleVersion, viewEpoch: frame.view.epoch, revision: last.revision, drawnFrameId: last.frameId });
                        return true;
                    },
                    // Only the GPU compositor has offscreen passes; a 2D or bridge frame has none.
                    encodeOffscreen: (frame: ScheduledFrame) => {
                        const drawing = drawCompositor();
                        const offscreen = drawing && drawing !== compositor ? drawing.encodeOffscreen?.(frame) ?? null : null;
                        // Off-screen work under an unsharp report may be what finishes the picture: one more frame asks (presentUnchanged)
                        // whether it now presents sharp. Bounded by the work itself: with no offscreen work left, no frame is asked for.
                        if (offscreen && lastReport && !lastReport.sharp) lifecycle?.invalidate('offscreen-sharpen');
                        return offscreen;
                    },
                    writeOverlays: options.writeOverlays,
                    ...(__BME_BENCH__ ? { benchmarkMemory: () => {
                        const memory = runtime.governor.readout();
                        const grant = runtime.governor.grant(options.paneId);
                        return {
                            memory: { gpuChargedBytes: memory.gpu.chargedBytes, cpuChargedBytes: memory.cpu.chargedBytes,
                                gpuRetiringBytes: memory.gpu.retiringBytes, cpuRetiringBytes: memory.cpu.retiringBytes,
                                ...benchmarkMemory!.readMeasurementMemory(options.paneId) },
                            grants: { pixelGrant: grant?.pixelGrant ?? 0, gpuCacheBytes: grant?.gpuCacheBytes ?? 0,
                                cpuBytes: grant?.cpuBytes ?? 0 },
                        };
                    } } : {}),
                    suspend: (reason: Parameters<PaneLifecycle<T>['suspend']>[0]) => { lastReport = null; options.onPresentation(null); lifecycle?.suspend(reason); },
                };
                frameLease = runtime.scheduler.register(pane);
                const lease = frameLease;
                return { invalidate: (reason: string, damage?: DamageRecord) => lease.invalidate(reason, damage), setFocused: value => lease.setFocused(value),
                    dispose: () => { if (frameLease === lease) frameLease = null; lease.dispose(); } };
            },
            currentFrameToken: token, currentView: mirrorView, currentRevision: options.revision,
            setInputEnabled: options.setInputEnabled, cancelViewWork: options.cancelViewWork,
            recordUpload: (bytes, ms) => runtime.scheduler.recordUpload(bytes, ms), now: () => performance.now(),
        });
        removeCapture = registerCaptureGpu(options.paneId, options.documentToken, () => {
            if (backendPreference === 'canvas2d' || disposed || !visible || !cpuPresented || !gpu || options.isInteracting() || surfaceHost.current !== gpu.bundle.compositor) return null;
            const current = options.currentToken();
            if (!current || !sameDocument(current, options.documentToken) || !runtime.scheduler.idleForCapture()) return null;
            const snapshot = lifecycle?.surface.snapshot();
            const compositor = gpu.bundle.compositor as GpuCompositor;
            if (snapshot?.state !== 'gpu-visible' || snapshot.gpuGeneration !== gpu.grant.generation || !compositor.captureIdle) return null;
            return captureGpuOwner(gpu.bundle.owner, compositor);
        });
        runtime.start();
        observer.start();
    } catch (error) {
        removeCapture(); lifecycle?.unmountPane();
        observer.dispose(); removeRuntime(); compositor.dispose();
        for (const cache of caches) { cache.cpu.close(); cache.gpu.close(); }
        throw error;
    }

    const setVisible = (next: boolean): void => {
        if (disposed || visible === next) return;
        visible = next;
        if (!next) {
            cpuPresented = false; gpuRequested = false; shownPresented = false; lastReport = null; options.onPresentation(null);
            endBridge(); bridgeSkipped = false;
            lifecycle?.hidePane();
            surfaceHost.clearStaged();
            gpu = null;
        }
        const now = performance.now();
        candidate.setVisible(next, now);
        for (const cache of caches) for (const handle of [cache.cpu, cache.gpu]) {
            handle.updateActivity({ hiddenAt: next ? null : now, lastVisibleAt: now, lastUsedAt: now });
        }
        runtime.refresh();
        if (next) {
            gpuRequested = false;
            const size = observer.current;
            lifecycle?.showPane({ visible: true, focused, cssWidth: size?.cssWidth ?? 0, cssHeight: size?.cssHeight ?? 0, lastInputAt });
            observer.refresh();
        }
    };
    setVisible(options.initialVisible);
    return {
        currentFrameToken: token,
        setVisible,
        setFocused(value) { if (!disposed && focused !== value) { focused = value; lifecycle?.setFocused(value); runtime.refresh(); } },
        observeSize() { if (!disposed) { observer.start(); observer.refresh(); } },
        beginFreshView() {
            if (disposed) return;
            freshLayers.clear();
            for (const binding of layerSet.compositorLayers) freshLayers.add(binding.layer);
            freshSince = performance.now();
            // The cover is also released by a timer: a refused frame may request no other frame, and the coverage check is what
            // would otherwise expire it (review3, gpu-h2). The timer only expires and refreshes; it never presents.
            if (freshTimer !== null) clearTimeout(freshTimer);
            freshTimer = setTimeout(() => {
                freshTimer = null;
                if (disposed || freshLayers.size === 0) return;
                freshLayers.clear();
                auditCount('pane', 'fresh-cover:expired');
                runtime.refresh();
            }, FRESH_VIEW_COVER_MS);
        },
        setLayers(definitions: readonly PlatformLayerDefinition[]) {
            if (disposed) return;
            const previousCount = caches.length;
            try { layerSet.replace(definitions); }
            catch (error) {
                for (const cache of caches.splice(previousCount)) { cache.cpu.close(); cache.gpu.close(); }
                throw error;
            }
            const retained = new Set(layerSet.layers);
            for (let i = caches.length - 1; i >= 0; i--) {
                const layer = caches[i].layer();
                if (!layer || !retained.has(layer)) {
                    caches[i].cpu.close(); caches[i].gpu.close(); caches.splice(i, 1);
                }
            }
            lifecycle?.setLayers(layerSet.layers);
            compositor.setLayers(compositorLayers());
            gpu?.bundle.compositor.setLayers(compositorLayers());
            runtime.refresh();
        },
        invalidate(reason, damage) {
            if (disposed) return;
            if (reason === 'input') { lastInputAt = performance.now(); pendingInputAt = lastInputAt; }
            lifecycle?.invalidate(reason, damage);
        },
        startFling(samples) { if (!disposed && visible) frameLease?.startFling(samples); },
        animateZoom(targetZ, anchor) { if (!disposed && visible) frameLease?.animateZoom(targetZ, anchor); },
        animatePan(delta, durationMs) { if (!disposed && visible) frameLease?.animatePan(delta, durationMs); },
        glideTo(target, durationMs) { if (!disposed && visible) frameLease?.glideTo(target, durationMs); },
        cancelMotion() { if (!disposed && visible) frameLease?.cancelMotion(); },
        captureRegion(worldRect, maxSidePx, captureOptions) {
            if (disposed) return Promise.reject(new Error('Pane capture is unavailable'));
            // Session capture owns its own revision lease and survives later pane unmount.
            if (options.session.captureRegion) return options.session.captureRegion(worldRect, maxSidePx, captureOptions);
            const selected = surfaceHost.current;
            if (!selected?.captureRegion) return Promise.reject(new Error('Pane capture is unavailable'));
            return selected.captureRegion(worldRect, maxSidePx, captureOptions);
        },
        captureBlob(worldRect, maxSidePx, captureOptions) {
            if (disposed || !options.session.captureBlob) return Promise.reject(new Error('Pane capture is unavailable'));
            return options.session.captureBlob(worldRect, maxSidePx, captureOptions);
        },
        captureExportBlob(worldRect, maxSidePx, captureOptions) {
            if (disposed) return Promise.reject(new CaptureError('disposed'));
            if (!options.session.captureExportBlob) return Promise.reject(new CaptureError('incomplete'));
            return options.session.captureExportBlob(worldRect, maxSidePx, captureOptions);
        },
        dispose() {
            if (disposed) return;
            setVisible(false);
            disposed = true;
            if (freshTimer !== null) { clearTimeout(freshTimer); freshTimer = null; }
            if (budgetNoticeTimer !== null) { clearTimeout(budgetNoticeTimer); budgetNoticeTimer = null; }
            endBridge();
            lastReport = null; options.onPresentation(null);
            candidate.dispose();
            observer.dispose();
            removeCapture();
            lifecycle?.unmountPane();
            surfaceHost.dispose();
            compositor.dispose();
            runtime.clearDeviceTrouble(options.paneId);
            for (const cache of caches) { cache.cpu.close(); cache.gpu.close(); }
            removeRuntime();
        },
    };
};
