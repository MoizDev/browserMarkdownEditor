import type { ViewState } from '../types';
import { clearRenderQuality, reportRenderPinned, reportRenderQuality } from '../renderStatus';
import type { AttachPlatformPane, PlatformLayerDefinition, PlatformPaneOptions } from './attachPlatformPane.types';
import { createPaneSurfaceHost, PaneBackendSwitch } from './backendSwitch';
import { CameraController } from './camera';
import { captureGpuOwner, registerCaptureGpu } from './captureRuntime';
import type { GpuCompositor } from './compositor';
import { registerWebgl2PaneFactory } from './compositorFactory';
import { GpuPaneCandidate } from './gpuPaneCandidate';
import type { QualifiedGpuPane } from './gpuPaneCandidate';
import type { CameraConstraint } from './camera';
import type { Compositor2DOptions, CreatedCompositor2D, PaneCompositor } from './compositor.types';
import { RENDER_CONSTANTS } from './constants';
import { createLayerHost } from './layerHost';
import type { MemoryCacheHandle } from './memoryGovernor';
import type { MirrorView } from './mirrorSet';
import { PaneLayerSet } from './paneLayerSet';
import { PaneLifecycle } from './paneLifecycle';
import { PaneSizeObserver } from './paneObservation';
import { getPlatformRuntime } from './platformRuntime';
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
    const runtime = getPlatformRuntime();
    const surfaceHost = new PaneBackendSwitch(createPaneSurfaceHost(host));
    const cpuMetrics = new SurfaceMetricsCommitter();
    const gpuMetrics = new SurfaceMetricsCommitter();
    const camera = new CameraController(options.readCamera(), { width: 0, height: 0, dpr: 1 }, unconstrained);
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
    let lastInputAt = performance.now();
    let pendingInputAt: number | null = null;
    let healthyInputAt: number | null = null;
    let lastFrameInterval: number | null = null;
    let gpu: QualifiedGpuPane | null = null;
    let cpuPresented = false;
    let gpuRequested = false;
    const drawCompositor = (): PaneCompositor | null => gpu && cpuPresented ? gpu.bundle.compositor : compositorRef.current;
    const activeMetrics = (): SurfaceMetricsCommitter => gpu && cpuPresented ? gpuMetrics : cpuMetrics;

    const token = (): FrameToken | null => {
        const current = options.currentToken();
        const drawing = drawCompositor();
        if (disposed || !current || !sameDocument(current, options.documentToken) || !drawing) return null;
        return { ...current, viewLease: options.viewLease, deviceGeneration: drawing.target.generation };
    };
    const mirrorView = (): MirrorView | null => {
        const current = options.currentToken();
        if (!current || !sameDocument(current, options.documentToken)) return null;
        if (options.readMirrorView) return options.readMirrorView(lastView);
        if (options.session.mirrors) return null;
        return { token: current, sourceRole: '', contentRevision: options.revision(), colourVersion: 0,
            geometryDigest: '', nominalDpr: lastView.viewport.dpr, view: lastView };
    };
    const layerSet = new PaneLayerSet((id, current) => {
        const now = performance.now();
        const common = { paneId: options.paneId, owner: options.documentToken, hiddenAt: visible ? null : now,
            lastVisibleAt: now, lastUsedAt: now, class: 'scene-cache' as const };
        const cacheId = `${options.paneId}:${options.viewLease}:${id}:${++cacheSerial}`;
        const cpu = runtime.governor.register({ ...common, id: `${cacheId}:cpu`, pool: 'cpu', kind: 'working',
            memory: () => ({ live: current()?.memory().cpuBytes ?? 0, retiring: 0 }), evict: () => {} });
        let gpuCache: MemoryCacheHandle;
        try {
            gpuCache = runtime.governor.register({ ...common, id: `${cacheId}:gpu`, pool: 'gpu', kind: 'working',
                memory: () => ({ live: current()?.memory().gpuBytes ?? 0, retiring: 0 }),
                evict: () => lifecycle?.releaseGpu('pressure') });
        } catch (error) { cpu.close(); throw error; }
        caches.push({ cpu, gpu: gpuCache, layer: current });
        return createLayerHost({
            allocator: { cpu, gpu: gpuCache }, generation: () => lifecycle?.surface.snapshot().gpuGeneration ?? 0,
            gpuResources: () => gpu?.bundle.compositor.resources ?? null, compositor: () => surfaceHost.current,
            invalidate: reason => lifecycle?.invalidate(reason),
            wakeAt: deadline => { const layer = current(); if (layer) frameLease?.wakeAt(layer, deadline); },
        });
    });
    layerSet.replace(options.layers);

    let created: CreatedCompositor2D<T>;
    try { created = cpuFactory<T>({
        paneId: options.paneId, governor: runtime.governor, currentToken: token,
        invalidate: reason => lifecycle?.invalidate(reason), recordUpload: (bytes, ms) => runtime.scheduler.recordUpload(bytes, ms),
        select2D: cpu => { if (!disposed) surfaceHost.select(cpu); },
        selectGpu: grant => {
            if (!gpu || gpu.grant.generation !== grant.generation) throw new Error('GPU grant is no longer current');
            created.presenter.releaseSurface();
            if (!gpu.backing.promote()) throw new Error('GPU backing promotion was refused');
            surfaceHost.select(gpu.bundle.compositor);
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
    compositor.setLayers(layerSet.compositorLayers);
    compositor.setLayout(options.layout);
    compositor.setAppearance(options.readAppearance());

    const observer = new PaneSizeObserver(host, size => {
        if (disposed) return;
        if (visible) lifecycle?.showPane({ visible: true, focused, cssWidth: size.cssWidth, cssHeight: size.cssHeight, lastInputAt });
        runtime.refresh();
        lifecycle?.invalidate('geometry');
    }, options.onError);
    const runtimePane = {
        demand: () => {
            const size = observer.current;
            const memory = layerSet.layers.map(layer => layer.memory());
            const requestedPixels = size ? size.physical.width * size.physical.height : 0;
            return { paneId: options.paneId, visible, focused, requestedPixels,
                gpuNeedBytes: memory.reduce((sum, value) => sum + value.gpuBytes, 0) + requestedPixels * RENDER_CONSTANTS.surfaceReserveBytesPerPixel,
                cpuNeedBytes: memory.reduce((sum, value) => sum + value.cpuBytes, 0),
                cpuPinned: lifecycle?.surface.snapshot().state === 'cpu-pinned' };
        },
        interacting: options.isInteracting,
        notice: () => options.onNotice('memory-pressure'),
        error: options.onError,
    };
    const removeRuntime = runtime.add(options.paneId, runtimePane);
    let removeCapture = (): void => {};
    registerWebgl2PaneFactory();
    const candidate = new GpuPaneCandidate({
        runtime, paneId: options.paneId, viewLease: options.viewLease, owner: options.documentToken,
        surface: () => lifecycle?.surface ?? null,
        invalidate: reason => lifecycle?.invalidate(reason), onError: options.onError,
        inputHealthy: () => healthyInputAt !== null && performance.now() - healthyInputAt <= RENDER_CONSTANTS.stalledFenceMs,
        frameInterval: () => lastFrameInterval,
        onEvict: () => {
            const surface = lifecycle?.surface;
            if (surface && gpu) surface.failGpu(surface.stamp, gpu.grant.generation, 'out-of-budget');
        },
        onReady: ready => {
            if (disposed || !visible) return;
            gpu = ready;
            gpu.bundle.compositor.setLayers(layerSet.compositorLayers);
            gpu.bundle.compositor.setLayout(options.layout);
            gpu.bundle.compositor.setAppearance(options.readAppearance());
            surfaceHost.stage(gpu.bundle.compositor);
            lifecycle?.invalidate('gpu-ready');
        },
    });
    const requestGpu = (): void => {
        if (disposed || !visible || !cpuPresented || gpuRequested || !lifecycle) return;
        gpuRequested = true;
        const canvas = host.ownerDocument.createElement('canvas');
        canvas.width = 0; canvas.height = 0;
        void lifecycle.surface.requestGpu(canvas, lifecycle.surface.stamp).catch(options.onError);
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
                        gpu = null;
                        cpuPresented = false;
                        surfaceHost.clearStaged();
                        options.onPresentation(null);
                        if (reason === 'context-lost') runtime.trouble('context-loss');
                    },
                    onSlotAvailable: () => { gpuRequested = false; requestGpu(); },
                    onPinned: () => { reportRenderPinned(); options.onNotice('cpu-pinned'); },
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
                        const drawing = drawCompositor();
                        if (!drawing) return null;
                        const planned = computeSurfaceMetrics(size.physical, size.nominalDpr, drawing.target.limits, grant.pixelGrant);
                        const result = activeMetrics().commit(frameId, size.generation, planned, drawing.target);
                        if (result?.kind === 'ready') drawing.setMetrics(result.metrics);
                        if (result?.kind !== 'failed') return result;
                        const failedGeneration = gpu?.grant.generation;
                        runtime.trouble('framebuffer');
                        if (drawing === compositor || !lifecycle) return result;
                        if (failedGeneration !== undefined) lifecycle.surface.failGpu(lifecycle.surface.stamp, failedGeneration, 'creation-failed');
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
                        camera.setCamera(options.readCamera());
                    },
                    isInteracting: options.isInteracting,
                    snapshotScene: (view: ViewState) => { lastView = view; const drawing = drawCompositor(); drawing?.setAppearance(options.readAppearance()); drawing?.snapshot(view); },
                    sceneRevision: (layer: Layer) => layerSet.definition(layer)?.revision(layer) ?? 0,
                    isCritical: (layer: Layer, view: ViewState) => layerSet.definition(layer)?.critical(layer, view) ?? false,
                    prepareFrame: (view: ViewState, budget: Parameters<PaneCompositor['prepareFrame']>[1]) => {
                        const drawing = drawCompositor();
                        drawing?.prepareFrame(view, budget);
                        const mirror = mirrorView();
                        if (drawing === compositor && mirror && options.session.mirrors) lifecycle?.prepare2D(mirror, budget);
                    },
                    encode: (frame: ScheduledFrame) => {
                        lastFrameInterval = frame.intervalMs;
                        const drawing = drawCompositor();
                        if (!drawing) return null;
                        const encoding = drawing.encode(frame);
                        if (!encoding && !(drawing === compositor && options.session.mirrors)) return null;
                        const revision = options.revision();
                        return {
                            discard: () => { lifecycle?.discardFrame(frame.frameId); encoding?.discard(); },
                            submit: () => {
                                const mirror = drawing === compositor && options.session.mirrors ? lifecycle?.submit2D(frame.frameId) : null;
                                const mirrored = !!mirror?.presented && mirror.complete;
                                let presented;
                                let complete: boolean;
                                let sharp: boolean;
                                let qualityScale: number;
                                if (mirrored) {
                                    encoding?.discard();
                                    presented = { drawn: [] };
                                    complete = mirror!.complete;
                                    sharp = mirror!.sharp;
                                    qualityScale = cpuMetrics.current?.kind === 'ready' ? cpuMetrics.current.metrics.qualityScale : 1;
                                } else {
                                    presented = encoding?.submit();
                                    if (!presented) return null;
                                    const coverage = drawing.coverage(frame);
                                    if (!coverage.presented || coverage.frameId !== frame.frameId || !sameFrame(coverage.token, frame.token)) return null;
                                    complete = coverage.complete;
                                    sharp = coverage.sharp;
                                    qualityScale = coverage.qualityScale;
                                }
                                const current = token();
                                const liveCamera = options.readCamera();
                                const geometry = observer.current;
                                if (!complete || !current || !sameFrame(current, frame.token) || options.revision() !== revision ||
                                    (!frame.view.moving && (liveCamera.x !== frame.view.camera.x || liveCamera.y !== frame.view.camera.y || liveCamera.z !== frame.view.camera.z)) ||
                                    geometry?.generation !== activeMetrics().current?.tags.geometryGeneration) return null;
                                if (drawing === compositor) {
                                    lifecycle?.note2DPresented(frame.token, revision);
                                    cpuPresented = true;
                                } else if (surfaceHost.current !== drawing) {
                                    const view = mirrorView();
                                    if (!view || !gpu || !lifecycle?.presentGpu(gpu.grant, frame.token, view, revision, complete)) return null;
                                }
                                options.onPresentation({ frameId: frame.frameId, token: frame.token, backend: drawing.backend,
                                    complete, sharp, viewEpoch: frame.view.epoch, revision });
                                if (lastQuality !== qualityScale) {
                                    lastQuality = qualityScale;
                                    reportRenderQuality(options.paneId, qualityScale);
                                    options.onQualityChange?.({ qualityScale });
                                }
                                if (drawing === compositor) queueMicrotask(requestGpu);
                                return presented;
                            },
                        };
                    },
                    writeOverlays: options.writeOverlays,
                    suspend: (reason: Parameters<PaneLifecycle<T>['suspend']>[0]) => { options.onPresentation(null); lifecycle?.suspend(reason); },
                };
                frameLease = runtime.scheduler.register(pane);
                const lease = frameLease;
                return { invalidate: reason => lease.invalidate(reason), setFocused: value => lease.setFocused(value),
                    dispose: () => { if (frameLease === lease) frameLease = null; lease.dispose(); } };
            },
            currentFrameToken: token, currentView: mirrorView, currentRevision: options.revision,
            setInputEnabled: options.setInputEnabled, cancelViewWork: options.cancelViewWork,
            recordUpload: (bytes, ms) => runtime.scheduler.recordUpload(bytes, ms), now: () => performance.now(),
        });
        removeCapture = registerCaptureGpu(options.paneId, () => {
            if (disposed || !visible || !gpu || options.isInteracting() || surfaceHost.current !== gpu.bundle.compositor) return null;
            const snapshot = lifecycle?.surface.snapshot();
            if (snapshot?.state !== 'gpu-visible' || snapshot.gpuGeneration !== gpu.grant.generation) return null;
            return captureGpuOwner(gpu.bundle.owner, gpu.bundle.compositor as GpuCompositor);
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
            cpuPresented = false; gpuRequested = false; options.onPresentation(null);
            lifecycle?.hidePane();
            surfaceHost.clearStaged();
            gpu = null;
        }
        const now = performance.now();
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
        setVisible,
        setFocused(value) { if (!disposed && focused !== value) { focused = value; lifecycle?.setFocused(value); runtime.refresh(); } },
        observeSize() { if (!disposed) { observer.start(); observer.refresh(); } },
        setLayers(definitions: readonly PlatformLayerDefinition[]) {
            if (disposed) return;
            try { layerSet.replace(definitions); }
            finally {
                const retained = new Set(layerSet.layers);
                for (let i = caches.length - 1; i >= 0; i--) {
                    const layer = caches[i].layer();
                    if (!layer || !retained.has(layer)) {
                        caches[i].cpu.close(); caches[i].gpu.close(); caches.splice(i, 1);
                    }
                }
            }
            lifecycle?.setLayers(layerSet.layers);
            compositor.setLayers(layerSet.compositorLayers);
            gpu?.bundle.compositor.setLayers(layerSet.compositorLayers);
            runtime.refresh();
        },
        invalidate(reason) {
            if (disposed) return;
            if (reason === 'input') { lastInputAt = performance.now(); pendingInputAt = lastInputAt; }
            lifecycle?.invalidate(reason);
        },
        captureRegion(worldRect, maxSidePx, captureOptions) {
            if (disposed) return Promise.reject(new Error('Pane capture is unavailable'));
            // Session capture owns its own revision lease and survives later pane unmount.
            if (options.session.captureRegion) return options.session.captureRegion(worldRect, maxSidePx, captureOptions);
            const selected = surfaceHost.current;
            if (!selected?.captureRegion) return Promise.reject(new Error('Pane capture is unavailable'));
            return selected.captureRegion(worldRect, maxSidePx, captureOptions);
        },
        dispose() {
            if (disposed) return;
            setVisible(false);
            disposed = true;
            options.onPresentation(null);
            observer.dispose();
            removeCapture();
            lifecycle?.unmountPane();
            surfaceHost.dispose();
            compositor.dispose();
            runtime.clearDeviceTrouble(options.paneId);
            for (const cache of caches) { cache.cpu.close(); cache.gpu.close(); }
            removeRuntime();
            clearRenderQuality(options.paneId);
        },
    };
};
