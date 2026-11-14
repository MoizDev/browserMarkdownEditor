import type { Camera, ViewState } from '../types';
import { clearRenderQuality, reportRenderPinned, reportRenderQuality } from '../renderStatus';
import type { AttachPlatformPane, PlatformLayerDefinition, PlatformPaneOptions } from './attachPlatformPane.types';
import { createPaneSurfaceHost, PaneBackendSwitch } from './backendSwitch';
import { CameraController } from './camera';
import type { CameraConstraint } from './camera';
import type { Compositor2DOptions, CreatedCompositor2D, PaneCompositor } from './compositor.types';
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

/** View lifetime only: the session, its source and its mirrors survive disposal. */
export const attachPlatformPane: AttachPlatformPane = <T extends object>(host: HTMLElement, options: PlatformPaneOptions<T>) => {
    if (!cpuFactory) throw new Error('Register the 2D compositor before attaching a platform pane');
    const runtime = getPlatformRuntime();
    const surfaceHost = new PaneBackendSwitch(createPaneSurfaceHost(host));
    const metrics = new SurfaceMetricsCommitter();
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

    const token = (): FrameToken | null => {
        const current = options.currentToken();
        if (disposed || !current || !sameDocument(current, options.documentToken) || !compositorRef.current) return null;
        return { ...current, viewLease: options.viewLease, deviceGeneration: compositorRef.current.target.generation };
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
        let gpu: MemoryCacheHandle;
        try {
            gpu = runtime.governor.register({ ...common, id: `${cacheId}:gpu`, pool: 'gpu', kind: 'working',
                memory: () => ({ live: current()?.memory().gpuBytes ?? 0, retiring: 0 }),
                evict: () => lifecycle?.releaseGpu('pressure') });
        } catch (error) { cpu.close(); throw error; }
        caches.push({ cpu, gpu, layer: current });
        return createLayerHost({
            allocator: { cpu, gpu }, generation: () => lifecycle?.surface.snapshot().gpuGeneration ?? 0,
            gpuResources: () => null, compositor: () => surfaceHost.current,
            invalidate: reason => lifecycle?.invalidate(reason),
            wakeAt: deadline => { const layer = current(); if (layer) frameLease?.wakeAt(layer, deadline); },
        });
    });
    layerSet.replace(options.layers);

    const created = cpuFactory<T>({
        paneId: options.paneId, governor: runtime.governor, currentToken: token,
        invalidate: reason => lifecycle?.invalidate(reason), recordUpload: (bytes, ms) => runtime.scheduler.recordUpload(bytes, ms),
        select2D: cpu => { if (!disposed) surfaceHost.select(cpu); },
        selectGpu: () => { throw new Error('A GPU compositor has not been selected'); },
        mirrorQuad: (entry, view) => options.mirrorQuad?.(entry, view) ?? null,
        mirrorCoverage: (view, entries) => options.mirrorCoverage?.(view, entries) ?? { complete: false, sharp: false },
    });
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
            return { paneId: options.paneId, visible, focused,
                requestedPixels: size ? size.physical.width * size.physical.height : 0,
                gpuNeedBytes: memory.reduce((sum, value) => sum + value.gpuBytes, 0),
                cpuNeedBytes: memory.reduce((sum, value) => sum + value.cpuBytes, 0), cpuPinned: false };
        },
        interacting: options.isInteracting,
        notice: () => options.onNotice('memory-pressure'),
        error: options.onError,
    };
    const removeRuntime = runtime.add(options.paneId, runtimePane);
    try {
        lifecycle = new PaneLifecycle<T>({
            host: runtime.lifecycles,
            registration: { paneId: options.paneId, viewLease: options.viewLease, documentToken: options.documentToken,
                view: { visible: false, focused, cssWidth: 0, cssHeight: 0, lastInputAt },
                callbacks: {
                    prepareGpu: async () => { throw new Error('No GPU factory is attached'); },
                    onGpuReady: () => {}, onCpuFallback: () => {}, onSlotAvailable: () => {},
                    onPinned: () => { reportRenderPinned(); options.onNotice('cpu-pinned'); },
                } },
            session: options.session, layers: layerSet.layers, presenter: created.presenter,
            registerFrames: () => {
                const pane = {
                    paneId: options.paneId, camera, layers: layerSet.layers, metrics, focused,
                    currentToken: token,
                    commitMetrics: (frameId: number) => {
                        const size = observer.readForFrame(frameId);
                        const grant = runtime.governor.grant(options.paneId);
                        if (!size || !grant) return null;
                        const planned = computeSurfaceMetrics(size.physical, size.nominalDpr, compositor.target.limits, grant.pixelGrant);
                        const result = metrics.commit(frameId, size.generation, planned, compositor.target);
                        if (result?.kind === 'ready') compositor.setMetrics(result.metrics);
                        if (result?.kind === 'failed') runtime.trouble('framebuffer');
                        return result;
                    },
                    consumeInput: (time: number) => { options.consumeInput(time); camera.setCamera(options.readCamera()); },
                    isInteracting: options.isInteracting,
                    snapshotScene: (view: ViewState) => { lastView = view; compositor.setAppearance(options.readAppearance()); compositor.snapshot(view); },
                    sceneRevision: (layer: Layer) => layerSet.definition(layer)?.revision(layer) ?? 0,
                    isCritical: (layer: Layer, view: ViewState) => layerSet.definition(layer)?.critical(layer, view) ?? false,
                    prepareFrame: (view: ViewState, budget: Parameters<PaneCompositor['prepareFrame']>[1]) => {
                        compositor.prepareFrame(view, budget);
                        const mirror = mirrorView();
                        if (mirror && options.session.mirrors) lifecycle?.prepare2D(mirror, budget);
                    },
                    encode: (frame: ScheduledFrame) => {
                        const encoding = compositor.encode(frame);
                        if (!encoding && !options.session.mirrors) return null;
                        const revision = options.revision();
                        return {
                            discard: () => { lifecycle?.discardFrame(frame.frameId); encoding?.discard(); },
                            submit: () => {
                                const mirror = options.session.mirrors ? lifecycle?.submit2D(frame.frameId) : null;
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
                                    qualityScale = metrics.current?.kind === 'ready' ? metrics.current.metrics.qualityScale : 1;
                                } else {
                                    presented = encoding?.submit();
                                    if (!presented) return null;
                                    const coverage = compositor.coverage(frame);
                                    if (!coverage.presented) return null;
                                    complete = coverage.complete;
                                    sharp = coverage.sharp;
                                    qualityScale = coverage.qualityScale;
                                }
                                const current = token();
                                if (!complete || !current || !sameDocument(current, frame.token) || current.viewLease !== frame.token.viewLease ||
                                    current.deviceGeneration !== frame.token.deviceGeneration || options.revision() !== revision) return null;
                                lifecycle?.note2DPresented(frame.token, revision);
                                options.onPresentation({ frameId: frame.frameId, token: frame.token, backend: compositor.backend,
                                    complete, sharp, viewEpoch: frame.view.epoch, revision });
                                if (lastQuality !== qualityScale) {
                                    lastQuality = qualityScale;
                                    reportRenderQuality(options.paneId, qualityScale);
                                    options.onQualityChange?.({ qualityScale });
                                }
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
        runtime.start();
        observer.start();
    } catch (error) {
        observer.dispose(); removeRuntime(); compositor.dispose();
        for (const cache of caches) { cache.cpu.close(); cache.gpu.close(); }
        throw error;
    }

    const setVisible = (next: boolean): void => {
        if (disposed || visible === next) return;
        visible = next;
        const now = performance.now();
        for (const cache of caches) for (const handle of [cache.cpu, cache.gpu]) {
            handle.updateActivity({ hiddenAt: next ? null : now, lastVisibleAt: now, lastUsedAt: now });
        }
        runtime.refresh();
        if (next) {
            const size = observer.current;
            lifecycle?.showPane({ visible: true, focused, cssWidth: size?.cssWidth ?? 0, cssHeight: size?.cssHeight ?? 0, lastInputAt });
            observer.refresh();
        } else { options.onPresentation(null); lifecycle?.hidePane(); }
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
            runtime.refresh();
        },
        invalidate(reason) { if (!disposed) { if (reason === 'input') lastInputAt = performance.now(); lifecycle?.invalidate(reason); } },
        captureRegion(worldRect, maxSidePx, captureOptions) {
            const capture = surfaceHost.current?.captureRegion;
            if (disposed || !capture || !surfaceHost.current) return Promise.reject(new Error('Pane capture is unavailable'));
            return capture.call(surfaceHost.current, worldRect, maxSidePx, captureOptions);
        },
        dispose() {
            if (disposed) return;
            setVisible(false);
            disposed = true;
            options.onPresentation(null);
            observer.dispose();
            lifecycle?.unmountPane();
            surfaceHost.dispose();
            compositor.dispose();
            for (const cache of caches) { cache.cpu.close(); cache.gpu.close(); }
            removeRuntime();
            clearRenderQuality(options.paneId);
        },
    };
};
