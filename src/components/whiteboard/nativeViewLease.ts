import type { PlatformPane } from '../../platform/render/attachPlatformPane.types';
import { cameraForPagedPosition, pagedPosition, type CameraController, type ViewportInsets, type ZoomLimits } from '../../platform/render/camera';
import type { PageGeometry, Rect } from '../../platform/types';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { paperPageSize } from '../../utils/paper';
import { getBoardRuntime, type BoardRuntime } from '../../whiteboard/host/runtime';
import { createBoardViewCamera } from '../../whiteboard/host/viewCamera';
import { createNotebookPaperLayer, type NotebookPaperSnapshot } from '../../whiteboard/host/notebookPaperLayer';
import { createBoardHostImages } from '../../whiteboard/media/hostImages';
import { boardPageStack } from '../../whiteboard/model/pages';
import { DEFAULT_BOARD_PALETTES } from '../../whiteboard/render/palette';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import { attachView } from '../../whiteboard/viewer/attachView';
import { createBoardNavigationHost } from '../../whiteboard/viewer/navigationHost';
import type { ViewerViewParams } from '../../whiteboard/viewer/types';
import type { BoardViewLease, BoardViewParameters, BoardViewSnapshot } from './boardHostRuntime';
import { createNativeViewPlatform } from './nativeViewPlatform';

export interface NativeNavigationSnapshot { readonly page: number; readonly zoom: number }
export interface NativeViewLease extends BoardViewLease<object> {
    readonly runtime: BoardRuntime;
    readonly camera: CameraController;
    getNavigationSnapshot(): NativeNavigationSnapshot;
    jump(page: number): void;
    zoomBy(factor: number): void;
    reveal(rect: Rect): void;
    changed(): void;
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
    onError(error: unknown): void;
    onNotice(message: string): void;
}): NativeViewLease {
    const { board, host, identity, limits, insets } = options;
    if (options.parameters.mode !== 'view' || !board.isReadOnly) throw new Error('The native viewer requires read-only session authority');
    const runtime = getBoardRuntime(board);
    if (!runtime || runtime.session !== board) throw new Error('Native viewer requires its acquired runtime');
    const token = Object.freeze({ vaultEpoch: identity.vaultActivation, documentId: identity.documentId,
        session: identity.session, bytesGeneration: identity.bytesGeneration });
    const viewLease = ++serial, listeners = new Set<() => void>();
    let parameters = { ...options.parameters }, disposed = false, platformPane: PlatformPane | null = null;
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
    let paperSnapshot: NotebookPaperSnapshot | undefined;
    const paper = board.doc.kind === 'notebook' ? createNotebookPaperLayer({
        read() {
            const docHost = board.doc.host;
            if (docHost.kind !== 'notebook') throw new Error('Notebook host changed kind');
            if (!paperSnapshot || paperSnapshot.host.paper !== docHost.paper) {
                const size = paperPageSize(docHost.paper);
                const pages: PageGeometry[] = Array.from({ length: docHost.paper.pageCount }, (_, index) => ({ index,
                    ...size, rotate: 0, userUnit: 1, toUserSpace: [1, 0, 0, -1, 0, size.height] }));
                paperSnapshot = { revision: board.doc.rev, host: docHost, pages };
            }
            return paperSnapshot;
        },
        palette: () => DEFAULT_BOARD_PALETTES.light, onError: options.onError,
    }) : undefined;
    const images = createBoardHostImages({ identity: { session: `${identity.documentId}:${identity.session}`,
        epoch: identity.vaultActivation, revision: board.doc.rev }, token, media: runtime.media,
        current: () => current() && parameters.visible,
        entry: id => board.doc.media.get(id),
        async readBlob(id, signal) {
            const cached = runtime.media.get(id);
            if (cached) return cached;
            const entry = board.doc.media.get(id);
            if (!entry) throw new Error(`Missing media descriptor: ${id}`);
            const found = await host.readMedia(identity, { hash: id.slice(7), preferredName: runtime.media.currentFile(id) ?? entry.file }, signal);
            if (!found) throw new Error(`Missing board media: ${id}`);
            return found.blob;
        }, onError: options.onError });
    const viewParameters = (): ViewerViewParams => ({ ...parameters, sheetId: runtime.selection.getSnapshot().sheet,
        ...(paper ? { backdrops: [paper] } : {}) });
    let viewer: ReturnType<typeof attachView>;
    const reveal = (rect: Rect) => { camera.bringIntoView(rect, 24); cameraOwner.changed(); };
    try { viewer = attachView({ session: board, token, view: viewParameters(), images, reveal, onError: options.onError }); }
    catch (error) { images.dispose(); cameraOwner.dispose(); throw error; }
    const navigation = createBoardNavigationHost({ camera, viewport: refreshViewport, platform: () => platformPane,
        visible: () => parameters.visible && !!platformPane, current,
        changed: () => cameraOwner.changed(), invalidate, onError: options.onError,
        mac: /Mac|iPhone|iPad/.test(navigator.platform) });
    const services = createNativeViewPlatform({ host, identity, board, viewer, camera,
        paneId: `native-${identity.documentId}-${viewLease}`, viewLease,
        readSheetId: () => runtime.selection.getSnapshot().sheet,
        ports: { consumeInput: timestamp => navigation.consumeInput(timestamp), isInteracting: () => navigation.isInteracting(),
            setInputEnabled: enabled => navigation.setInputEnabled(enabled), cancelViewWork: reason => navigation.cancelViewWork(reason),
            writeOverlays: frame => { refreshViewport(); navigation.writeOverlays(frame); },
            onPresentation: presentation => navigation.onPresentation(presentation), onError: options.onError, onNotice: options.onNotice } });
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
            navigation.dispose(); cameraOwner.dispose(); viewer.dispose(); images.dispose(); listeners.clear(); platformPane = null;
        },
    };
    return lease;
}
