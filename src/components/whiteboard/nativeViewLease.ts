import type { PlatformLayerDefinition, PlatformPane } from '../../platform/render/attachPlatformPane.types';
import { cameraForPagedPosition, pagedPosition, type CameraController, type ViewportInsets, type ZoomLimits } from '../../platform/render/camera';
import type { Rect } from '../../platform/types';
import { createPlatformCapturer } from '../../platform/render/captureRuntime';
import type { CompositorCaptureOptions } from '../../platform/render/compositor.types';
import type { CaptureRequest, CaptureSnapshot } from '../../platform/render/capture';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { getBoardRuntime, type BoardRuntime } from '../../whiteboard/host/runtime';
import { createBoardViewCamera } from '../../whiteboard/host/viewCamera';
import { createBoardCaptureSnapshot } from '../../whiteboard/export/runtimeSnapshot';
import { createBoardHostImages } from '../../whiteboard/media/hostImages';
import { boardPageStack } from '../../whiteboard/model/pages';
import type { MediaId } from '../../whiteboard/model/media';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import { attachView } from '../../whiteboard/viewer/attachView';
import { createBoardNavigationHost } from '../../whiteboard/viewer/navigationHost';
import type { ViewerViewParams } from '../../whiteboard/viewer/types';
import type { BoardViewLease, BoardViewParameters, BoardViewSnapshot } from './boardHostRuntime';
import { createNativeViewPlatform } from './nativeViewPlatform';

export interface NativePdfBackdrop {
    readonly layers: readonly PlatformLayerDefinition[];
    readonly pages: readonly { readonly width: number; readonly height: number }[];
    captureSnapshot(request: CaptureRequest, memory: MemoryAllocator): CaptureSnapshot;
    assertCaptureCurrent(): void;
    setVisible(visible: boolean, focused: boolean): void;
    notePresentation?(): void;
    dispose(): void;
}

export interface NativeNavigationSnapshot { readonly page: number; readonly zoom: number }
export interface NativeViewLease extends BoardViewLease<object> {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    getNavigationSnapshot(): NativeNavigationSnapshot;
    jump(page: number): void;
    zoomBy(factor: number): void;
    reveal(rect: Rect): void;
    captureRegion(rect: Rect, maxSide: number, signal: AbortSignal): Promise<ImageBitmap>;
    changed(): void;
    replaceBackdrop(backdrop: NativePdfBackdrop): void;
}
let serial = 0;

/** The viewer route owns only this view's camera, input and paint leases. Editing
 * remains a separate capability until the real tool/chrome host is attached. */
export function createNativeViewLease(options: {
    board: ComposedBoardSession;
    parameters: BoardViewParameters;
    host: NativeCanvasHost;
    identity: NativeCanvasIdentity;
    limits: ZoomLimits;
    insets: ViewportInsets;
    pdfBackdrop?: NativePdfBackdrop;
    readPdfMedia?(id: MediaId, signal: AbortSignal): Promise<Blob>;
    onError(error: unknown): void;
    onNotice(message: string): void;
}): NativeViewLease {
    const { board, host, identity, limits, insets } = options;
    if (options.parameters.mode !== 'view') throw new Error('The native viewer requires view mode');
    if (board.doc.kind === 'pdf-ink' && (!options.pdfBackdrop || !options.readPdfMedia)) {
        throw new Error('The PDF viewer requires its acquired backdrop and media reader');
    }
    if (board.doc.kind !== 'pdf-ink' && options.pdfBackdrop) throw new Error('A PDF backdrop requires a PDF ink session');
    const runtime = getBoardRuntime(board);
    if (!runtime || runtime.session !== board) throw new Error('Native viewer requires its acquired runtime');
    const token = Object.freeze({ vaultEpoch: identity.vaultActivation, documentId: identity.documentId,
        session: identity.session, bytesGeneration: identity.bytesGeneration });
    const viewLease = ++serial, listeners = new Set<() => void>();
    let parameters = { ...options.parameters }, disposed = false, platformPane: PlatformPane | null = null;
    let backdrop = options.pdfBackdrop;
    let surface: HTMLElement | null = null;
    const current = () => !disposed && host.isCurrent(identity);
    const publish = () => { if (!disposed) for (const listener of [...listeners]) listener(); };
    const invalidate = () => { platformPane?.invalidate('native-view'); publish(); };
    const cameraOwner = createBoardViewCamera({ runtime,
        currentPath: () => current() ? host.identity(identity.documentId)?.path : undefined,
        limits, insets, initialViewport: { width: 0, height: 0, dpr: window.devicePixelRatio || 1 },
        invalidate, onError: options.onError });
    const camera = cameraOwner.camera;
    let viewportKey = '';
    const refreshViewport = () => {
        const viewport = camera.viewport, key = `${viewport.width}:${viewport.height}:${viewport.dpr}`;
        if (key !== viewportKey) { viewportKey = key; cameraOwner.resize(viewport); }
        return camera.viewport;
    };
    const images = createBoardHostImages({ identity: { session: `${identity.documentId}:${identity.session}`,
        epoch: identity.vaultActivation, revision: board.doc.rev }, token, media: runtime.media,
        current: () => current() && parameters.visible,
        entry: id => board.doc.media.get(id),
        async readBlob(id, signal) {
            const cached = runtime.media.get(id);
            if (cached) return cached;
            if (board.doc.kind === 'pdf-ink') {
                if (!options.readPdfMedia) throw new Error('PDF media reader is unavailable');
                return options.readPdfMedia(id, signal);
            }
            const entry = board.doc.media.get(id);
            if (!entry) throw new Error(`Missing media descriptor: ${id}`);
            const found = await host.readMedia(identity, { hash: id.slice(7), preferredName: runtime.media.currentFile(id) ?? entry.file }, signal);
            if (!found) throw new Error(`Missing board media: ${id}`);
            return found.blob;
        }, onError: options.onError });
    const viewParameters = (): ViewerViewParams => ({ ...parameters, sheetId: runtime.selection.getSnapshot().sheet,
        // attachView owns the notebook's actual paper layer; adding another one
        // here gives the compositor two definitions with the same layer id.
        ...(backdrop ? { backdrops: backdrop.layers, pages: backdrop.pages } : {}) });
    let viewer: ReturnType<typeof attachView>;
    const reveal = (rect: Rect) => { camera.bringIntoView(rect, 24); cameraOwner.changed(); };
    try {
        backdrop?.setVisible(parameters.visible && current(), parameters.focused && parameters.visible && current());
        viewer = attachView({ session: board, token, view: viewParameters(), images, reveal, onError: options.onError });
    } catch (error) { backdrop?.dispose(); images.dispose(); cameraOwner.dispose(); throw error; }
    const navigation = createBoardNavigationHost({ camera, viewport: refreshViewport, platform: () => platformPane,
        visible: () => parameters.visible && !!platformPane, current,
        changed: () => cameraOwner.changed(), invalidate, onError: options.onError,
        mac: /Mac|iPhone|iPad/.test(navigator.platform) });
    const paneId = `native-${identity.documentId}-${viewLease}`;
    const captureRegion = (rect: Rect, maxSide: number, request: CompositorCaptureOptions): Promise<ImageBitmap> => {
        if (!current()) return Promise.reject(new Error('Native view capture is unavailable'));
        const sheetId = runtime.selection.getSnapshot().sheet;
        const blobs = new Map<MediaId, Blob>();
        for (const id of board.doc.media.keys()) { const blob = runtime.media.get(id); if (blob) blobs.set(id, blob); }
        const capturer = createPlatformCapturer({ paneId, owner: token, snapshot: (capture, memory) => {
            if (!current()) throw new DOMException('Native view ended', 'AbortError');
            const readMedia = async (entry: { readonly id: MediaId; readonly bytes: number }, signal: AbortSignal) => {
                signal.throwIfAborted();
                const blob = blobs.get(entry.id);
                if (!blob || blob.size !== entry.bytes) throw new Error(`Captured board media is unavailable: ${entry.id}`);
                return blob;
            };
            if (board.doc.kind !== 'pdf-ink') return createBoardCaptureSnapshot({ runtime, sheetId, request: capture, memory, onError: options.onError, readMedia });
            const pdf = backdrop;
            if (!pdf) throw new Error('PDF backdrop capture is unavailable');
            pdf.assertCaptureCurrent();
            const pdfIds = new Set(pdf.layers.map(layer => layer.id));
            const pdfLayers = capture.layers.filter(id => pdfIds.has(id));
            const boardLayers = capture.layers.filter(id => id === 'board-underlay' || id === 'board-content');
            if (pdfLayers.length + boardLayers.length !== capture.layers.length || !capture.layers.length) throw new Error('PDF capture requested an unavailable layer');
            const children: Array<{ snapshot: CaptureSnapshot; request: CaptureRequest }> = [];
            const releaseChildren = () => { for (const child of children) { try { child.snapshot.release(); } catch (error) { try { options.onError(error); } catch { /* Continue releasing the other pins. */ } } } };
            let identityPin: ReturnType<NonNullable<BoardRuntime['scene']>['pin']> | undefined;
            try {
                if (pdfLayers.length) {
                    const request = { ...capture, layers: pdfLayers };
                    children.push({ snapshot: pdf.captureSnapshot(request, memory), request });
                }
                if (boardLayers.length) {
                    const request = { ...capture, layers: boardLayers };
                    children.push({ snapshot: createBoardCaptureSnapshot({ runtime, sheetId, request, memory, onError: options.onError, readMedia }), request });
                } else {
                    if (!runtime.scene || runtime.scene.revision !== board.doc.rev) throw new Error('Board scene is not ready');
                    identityPin = runtime.scene.pin();
                }
                const root = boardLayers.length ? children[children.length - 1].snapshot : identityPin!;
                const controller = new AbortController();
                let released = false;
                return {
                    token: root.token, revision: String(root.revision),
                    signal: AbortSignal.any([controller.signal, ...children.map(child => child.snapshot.signal)]),
                    layers: children.flatMap(child => child.snapshot.layers),
                    get isolation() {
                        return children.every(child => child.snapshot.isolation !== undefined)
                            ? children.flatMap(child => child.snapshot.isolation ?? []) : undefined;
                    },
                    async prepare(_request, route, signal) {
                        let result: 'exact' | 'standin' | 'incomplete' = 'exact';
                        for (const child of children) {
                            const status = await child.snapshot.prepare(child.request, route, signal);
                            if (status === 'incomplete') return status;
                            if (status === 'standin') result = status;
                        }
                        return result;
                    },
                    release() {
                        if (released) return; released = true; controller.abort();
                        try { releaseChildren(); } finally { identityPin?.release(); }
                    },
                };
            } catch (error) {
                try { releaseChildren(); } finally { identityPin?.release(); }
                throw error;
            }
        } });
        return capturer.captureRegion(rect, maxSide, request).finally(() => capturer.dispose());
    };
    const services = createNativeViewPlatform({ host, identity, board, viewer, camera,
        paneId, viewLease,
        captureRegion,
        readSheetId: () => runtime.selection.getSnapshot().sheet,
        ports: { consumeInput: timestamp => navigation.consumeInput(timestamp), isInteracting: () => navigation.isInteracting(),
            setInputEnabled: enabled => navigation.setInputEnabled(enabled), cancelViewWork: reason => navigation.cancelViewWork(reason),
            writeOverlays: frame => { refreshViewport(); navigation.writeOverlays(frame); },
            onPresentation: presentation => {
                navigation.onPresentation(presentation);
                if (presentation && parameters.visible && current() && presentation.token.documentId === token.documentId &&
                    presentation.token.session === token.session && presentation.token.vaultEpoch === token.vaultEpoch &&
                    presentation.token.bytesGeneration === token.bytesGeneration) backdrop?.notePresentation?.();
            }, onError: options.onError, onNotice: options.onNotice } });
    // The platform receives the same controller as pointer input, including its
    // actual constraints and measured viewport; motion never uses a second pose.
    const platform = { ...services, camera, readCamera: () => { refreshViewport(); return camera.camera; } };
    let snapshot: BoardViewSnapshot<object> | undefined, priorLayers: ReturnType<typeof viewer.getSnapshot>['layers'];
    let navigationSnapshot: NativeNavigationSnapshot = { page: 0, zoom: 1 };
    const getNavigationSnapshot = () => {
        const stack = boardPageStack(board.doc.host);
        const pos = stack ? pagedPosition(camera.camera, camera.viewport, stack, insets) : null;
        const page = pos?.page ?? 0, zoom = pos?.zoom ?? camera.camera.z;
        if (page !== navigationSnapshot.page || zoom !== navigationSnapshot.zoom) navigationSnapshot = { page, zoom };
        return navigationSnapshot;
    };
    const stopViewer = viewer.subscribe(invalidate);
    const stopSelection = runtime.selection.subscribe(() => { viewer.setView(viewParameters()); publish(); });
    let resize: ResizeObserver | undefined;
    const detachSurface = () => { resize?.disconnect(); resize = undefined; surface = null; };
    const lease: NativeViewLease = {
        runtime, camera, getNavigationSnapshot, changed: () => cameraOwner.changed(), reveal,
        captureRegion: (rect, maxSide, signal) => captureRegion(rect, maxSide, { signal, theme: 'light', inverted: false,
            layers: board.doc.kind === 'notebook' ? ['notebook-paper', 'board-underlay', 'board-content']
                : board.doc.kind === 'pdf-ink' ? [...(backdrop?.layers.map(layer => layer.id) ?? []), 'board-underlay', 'board-content']
                    : ['board-underlay', 'board-content'] }),
        replaceBackdrop(next) {
            if (disposed || board.doc.kind !== 'pdf-ink' || !current()) throw new Error('PDF view is not current');
            if (next === backdrop) return;
            next.setVisible(parameters.visible, parameters.visible && parameters.focused);
            const old = backdrop; backdrop = next;
            try { viewer.setView(viewParameters()); platformPane?.setLayers(viewer.getSnapshot().layers); }
            catch (error) { backdrop = old; next.dispose(); viewer.setView(viewParameters()); platformPane?.setLayers(viewer.getSnapshot().layers); throw error; }
            old?.dispose();
        },
        jump(page) {
            const stack = boardPageStack(board.doc.host);
            if (!stack || !Number.isInteger(page) || page < 0 || page >= stack.rects.length) return;
            const next = cameraForPagedPosition({ page, offset: 0, zoom: getNavigationSnapshot().zoom }, camera.viewport, stack, insets, limits);
            if (next) { platformPane?.cancelMotion(); camera.setCamera(next); cameraOwner.changed(); }
        },
        zoomBy(factor) {
            if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid zoom factor');
            if (platformPane) platformPane.animateZoom(camera.camera.z * factor);
            else { camera.zoomTo(camera.camera.z * factor, { x: camera.viewport.width / 2, y: camera.viewport.height / 2 }); cameraOwner.changed(); }
        },
        view: {
            sourceToken: token,
            accessibility: viewer.accessibility, subscribe: listener => lease.subscribe(listener),
            setView(next) {
                parameters = { ...parameters, ...next };
                backdrop?.setVisible(parameters.visible && current(), parameters.focused && parameters.visible && current());
                viewer.setView(viewParameters());
                navigation.setInputEnabled(next.visible && !!platformPane);
            },
            attachPlatform(next) {
                if (!next) navigation.cancelViewWork('platform-detach');
                platformPane = next;
                navigation.setInputEnabled(parameters.visible && !!next);
                if (next) next.invalidate('native-attachment');
            },
            attachInput(interaction, overlay) {
                detachSurface(); surface = interaction;
                const measure = () => {
                    if (surface !== interaction || disposed) return;
                    // Platform metrics remain authoritative once attached. This
                    // initial measure only lets a pre-frame notebook restore fit.
                    if (camera.viewport.width === 0 || camera.viewport.height === 0) cameraOwner.resize({ width: interaction.clientWidth,
                        height: interaction.clientHeight, dpr: window.devicePixelRatio || 1 });
                };
                resize = new ResizeObserver(measure); resize.observe(interaction); measure();
                const detach = navigation.attachInput(interaction, overlay);
                return () => { detach(); if (surface === interaction) detachSurface(); };
            },
        },
        getSnapshot() {
            const next = viewer.getSnapshot();
            if (!snapshot || priorLayers !== next.layers || snapshot.reason !== next.readOnlyReason) {
                priorLayers = next.layers; snapshot = { layers: next.layers, reason: next.readOnlyReason, platform };
            }
            return snapshot;
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        dispose() {
            if (disposed) return;
            disposed = true; stopSelection(); stopViewer(); detachSurface();
            navigation.dispose(); cameraOwner.dispose(); viewer.dispose(); images.dispose(); backdrop?.dispose(); backdrop = undefined; listeners.clear(); platformPane = null;
        },
    };
    return lease;
}
