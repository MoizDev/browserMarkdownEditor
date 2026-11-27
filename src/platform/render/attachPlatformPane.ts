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

const FRESH_VIEW_COVER_MS = 3000;
const BRIDGE_WAIT_MS = 300;
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
    let lastReport: { frameId: number; revision: string; backend: PaneCompositor['backend']; complete: boolean; sharp: boolean;
        staleVersion: boolean | undefined; camera: { x: number; y: number; z: number }; drawn: { x: number; y: number; z: number };
        geometry: number | undefined; appearance: CompositorAppearance } | null = null;
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
    let shownPresented = false;
    let bridgeSince: number | null = null, bridgeSkipped = false, bridgeTimer: ReturnType<typeof setTimeout> | null = null;
    let gpuPhysical: { width: number; height: number } | null = null;
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
    let touchedFrame = -1;
    const touchedThisFrame = (): boolean => touchedFrame === runtime.scheduler.currentFrame();
    // Layers whose GPU release is already scheduled. Several caches of one pane can ask in the same trim; the second must not
    // count residency the first has already promised to free.
    const releasing = new Set<Layer>();
    const trimGpu = (bytes: number, only?: Layer): number => {
        if (disposed || !visible) return 0;
        const frameId = runtime.scheduler.currentFrame();
        const touched = touchedThisFrame();
        const victims: Layer[] = [];
        let freed = 0;
        for (const layer of only ? [only] : layerSet.layers) {
            if (freed >= bytes) break;
            if (releasing.has(layer)) continue;
            if (layer.memory().gpuBytes <= 0) continue;
            const want = bytes - freed;
            const reported = layer.evictGpu ? layer.evictGpu(want, frameId) : 0;
            const partial = Number.isFinite(reported) ? Math.max(0, reported) : 0;
            if (partial > 0) {
                freed += partial;
                auditCount('governor', `evict-partial:${layerSet.definition(layer)?.id ?? 'unnamed'}`, 1, { bytes: partial });
            }
            if (partial >= want) break;
            if (layer.evictGpu || touched) continue;
            const remaining = layer.memory().gpuBytes;
            if (remaining <= 0) continue;
            victims.push(layer);
            releasing.add(layer);
            freed += remaining;
        }
        if (!victims.length) return freed;
        queueMicrotask(() => {
            for (const layer of victims) releasing.delete(layer);
            if (disposed || !visible) return;
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
    let demandQueued = false;
    const requestDemand = (): void => {
        if (demandQueued || disposed) return;
        demandQueued = true;
        queueMicrotask(() => { demandQueued = false; if (!disposed) runtime.refresh(); });
    };
    const heldBytes = (cache: MemoryCacheHandle | undefined): number => cache ? cache.readout().reservedBytes : 0;
    const layerSet = new PaneLayerSet((id, current, definition) => {
        const now = performance.now();
        const common = { paneId: options.paneId, owner: options.documentToken, hiddenAt: visible ? null : now,
            lastVisibleAt: now, lastUsedAt: now, class: 'scene-cache' as const };
        const cacheId = `${options.paneId}:${options.viewLease}:${id}:${++cacheSerial}`;
        const cpu = runtime.governor.register({ ...common, id: `${cacheId}:cpu`, pool: 'cpu', kind: 'working', liveInput: definition.liveInput === true, foreground: definition.foregroundCpu === true,
            memory: () => ({ live: current()?.memory().cpuBytes ?? 0, retiring: 0 }),
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
                evict: bytes => { const layer = current(); return layer ? trimGpu(bytes, layer) : 0; } });
        } catch (error) { cpu.close(); throw error; }
        caches.push({ cpu, gpu: gpuCache, layer: current });
        return createLayerHost({
            auditId: id,
            allocator: { cpu, gpu: gpuCache, cpuGrantBytes: () => runtime.governor.grant(options.paneId)?.cpuBytes ?? 0 },
            generation: () => lifecycle?.surface.snapshot().gpuGeneration ?? 0,
            trouble: () => runtime.governor.trouble(),
            gpuError: error => candidate.fail(error, 'layer'),
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
            const frameCopies = 2 + Number(options.readAppearance().inverted) + Number(!!options.session.mirrors) + isolated;
            let mandatory = created.compositor.cpuWorkingBytes?.() ?? 0, prefetch = 0, pinned = 0;
            for (const layer of layerSet.layers) {
                if (requestedPixels > 0) pinned += layerSet.definition(layer)?.gpuWorkingSet?.(layer, size!.physical).mandatoryBytes ?? 0;
                const demand = requestedPixels > 0 ? layerSet.definition(layer)?.cpuWorkingSet?.(layer, size!.physical) : undefined;
                const own = layer.memory().cpuBytes, held = heldBytes(caches.find(cache => cache.layer() === layer)?.cpu);
                const floor = demand ? demand.mandatoryBytes : own;
                mandatory += floor;
                prefetch += (demand?.prefetchBytes ?? 0) + Math.max(0, Math.max(own, held) - floor);
            }
            const cpuMandatoryBytes = requestedPixels ? Math.max(mandatory, requestedPixels * RENDER_CONSTANTS.decodedRgbaBytesPerPixel) +
                (requestedPixels + bandPixels) * 4 : 0;
            return { paneId: options.paneId, visible, focused, requestedPixels, devicePixelRatio: size?.nominalDpr ?? 1,
                gpuPinnedBytes: pinned,
                gpuNeedBytes: memory.reduce((sum, value) => sum + value.gpuBytes, 0) +
                    (frameCopies * requestedPixels + bandPixels) * RENDER_CONSTANTS.surfaceReserveBytesPerPixel + requestedPixels * 4,
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
            if (!cpuPresented && !shownPresented && bridgeSince === null) cpuPresented = true;
            lifecycle?.invalidate('gpu-ready');
        },
    });
    const requestGpu = (): void => {
        if (backendPreference === 'canvas2d' || disposed || !visible || gpuRequested || !lifecycle) return;
        gpuRequested = true;
        const canvas = host.ownerDocument.createElement('canvas');
        canvas.width = 0; canvas.height = 0;
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
                        lifecycle?.invalidate('cpu-fallback');
                        if (reason === 'context-lost') runtime.trouble('context-loss');
                    },
                    onSlotAvailable: () => { gpuRequested = false; requestGpu(); },
                    onPinned: () => { reportRenderPinned(); options.onNotice('cpu-pinned'); },
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
                        if (!cpuPresented && gpu && bridgeSince !== null && performance.now() - bridgeSince >= BRIDGE_WAIT_MS) {
                            auditCount('pane', 'fallback:2d-bridge-skipped');
                            endBridge();
                            bridgeSkipped = true;
                            cpuPresented = true;
                        }
                        let drawing = drawCompositor();
                        if (!drawing) return null;
                        let planned = computeSurfaceMetrics(size.physical, size.nominalDpr, drawing.target.limits, grant.pixelGrant);
                        if (drawing === compositor && !gpuRequested && planned.kind === 'ready') queueMicrotask(requestGpu);
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
                                bridgeTimer = setTimeout(() => { bridgeTimer = null; if (!disposed && bridgeSince !== null) lifecycle?.invalidate('bridge-wait'); },
                                    BRIDGE_WAIT_MS + 1);
                            }
                            auditCount('pane', 'fallback:2d-bridge', 1, { px: size.physical.width * size.physical.height });
                            const shown = drawing.surface.width * drawing.surface.height;
                            drawing = compositor;
                            planned = computeSurfaceMetrics(size.physical, size.nominalDpr, drawing.target.limits,
                                shown > 0 ? Math.min(grant.pixelGrant, shown) : grant.pixelGrant);
                        }
                        const result = activeMetrics().commit(frameId, size.generation, planned, drawing.target);
                        if (result?.kind === 'ready') drawing.setMetrics(result.metrics);
                        if (result?.kind === 'ready' && drawing !== compositor) gpuPhysical = { width: size.physical.width, height: size.physical.height };
                        if (result?.kind !== 'failed') return result;
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
                        if (demandMoved()) runtime.refresh();
                    },
                    layerId: (layer: Layer) => layerSet.definition(layer)?.id ?? 'unnamed',
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
                    presentUnchanged: (frame: ScheduledFrame): boolean => {
                        const last = lastReport;
                        const drawing = drawCompositor();
                        if (!last || !drawing || drawing.backend !== last.backend || disposed) return false;
                        const current = token();
                        const drawn = frame.view.camera;
                        if (!current || !sameFrame(current, frame.token) || options.revision() !== last.revision ||
                            drawn.x !== last.drawn.x || drawn.y !== last.drawn.y || drawn.z !== last.drawn.z ||
                            observer.current?.generation !== last.geometry) return false;
                        const appearance = options.readAppearance();
                        if (appearance.inverted !== last.appearance.inverted
                            || appearance.background.some((value, i) => value !== last.appearance.background[i])) {
                            if (renderAuditEnabled()) auditCount('pane', 'present-kept:appearance');
                            return false;
                        }
                        const liveCamera = options.readCamera();
                        if (liveCamera.x !== last.camera.x || liveCamera.y !== last.camera.y || liveCamera.z !== last.camera.z) return true;
                        if (!last.sharp && drawing.nowSharp?.(frame)) { if (renderAuditEnabled()) auditCount('pane', 'present-kept:sharpened'); return false; }
                        options.onPresentation({ frameId: frame.frameId, token: frame.token, backend: last.backend, complete: last.complete,
                            sharp: last.sharp, staleVersion: last.staleVersion, viewEpoch: frame.view.epoch, revision: last.revision, drawnFrameId: last.frameId });
                        return true;
                    },
                    encodeOffscreen: (frame: ScheduledFrame) => {
                        const drawing = drawCompositor();
                        const offscreen = drawing && drawing !== compositor ? drawing.encodeOffscreen?.(frame) ?? null : null;
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
