import { getBoardPreferences, mouseInputChosen, mouseZoomInverted } from '../../utils/boardPreferences';
import { isTransientPictureFailure } from '../../whiteboard/media/transientFailure';
import { isMissingMedia, MissingMediaError, missingPictureSentence } from '../../whiteboard/media/missingMedia';
import { recordBoardPresentation } from './debugStats';
import { encodeTiledPngInWorker } from '../../whiteboard/export/pngWorkerClient';
import type { PlatformLayerDefinition, PlatformPane, PlatformPresentation } from '../../platform/render/attachPlatformPane.types';
import type { Camera } from '../../platform/types';
import { cameraForPagedPosition, fitWidthZ, pagedPosition, surfaceToWorld, type CameraController, type ViewportInsets, type ZoomLimits } from '../../platform/render/camera';
import type { Rect, ViewState } from '../../platform/types';
import type { RenderToken } from '../../platform/render/types';
import { createPlatformCapturer } from '../../platform/render/captureRuntime';
import type { CompositorBackend, CompositorCaptureOptions } from '../../platform/render/compositor.types';
import type { CaptureRequest, CaptureSnapshot } from '../../platform/render/capture';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { recordPdfNavigation } from '../../utils/pdfViewState';
import { auditCount, renderAuditEnabled } from '../../platform/render/renderAudit';
import { getBoardRuntime, type BoardRuntime } from '../../whiteboard/host/runtime';
import { createBoardViewCamera } from '../../whiteboard/host/viewCamera';
import { resetZoomTarget, zoomStepTarget } from '../../whiteboard/host/zoomSteps';
import { recordNativeAgentViewport, snapshotNativeAgentView, type NativeAgentViewInput } from '../../whiteboard/host/nativeAgentView';
import { captureLiveAgentProjection, describeLiveAgentView } from '../../whiteboard/host/agentProjection';
import { registerView, type LiveJob, type NativeLiveView, type ViewReporter } from '../../utils/viewRegistry';
import { createBoardCaptureSnapshot } from '../../whiteboard/export/runtimeSnapshot';
import { createBoardHostImages } from '../../whiteboard/media/hostImages';
import { BoardVideoPlayback } from '../../whiteboard/media/playback';
import { videoFrameOverlay } from '../../whiteboard/media/videoFrames';
import { AnimatedPictureDriver, canAnimatePicture } from '../../whiteboard/media/animatedFrames';
import type { AnimatedPictureDemand } from '../../whiteboard/media/animation';
import { PicturePlayback } from '../../whiteboard/media/picturePlayback';
import { isSheetParent } from '../../whiteboard/model/doc';
import { boardPageStack } from '../../whiteboard/model/pages';
import type { NodeId } from '../../whiteboard/model/ids';
import type { MediaId } from '../../whiteboard/model/media';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import { attachView } from '../../whiteboard/viewer/attachView';
import { createBoardNavigationHost } from '../../whiteboard/viewer/navigationHost';
import type { ViewerEngine, ViewerSnapshot, ViewerViewParams } from '../../whiteboard/viewer/types';
import { paintKey, type BoardViewLease, type BoardViewParameters, type BoardViewSnapshot } from './boardHostRuntime';
import { createNativeViewPlatform } from './nativeViewPlatform';
import { createNativeEditingLease, type NativeEditingToolOptions, type NativeEmbedInfrastructure } from './nativeEditingLease';
import { createBoardAccessibilityDom } from '../../whiteboard/viewer/accessibilityDom';
import { createSelectionHandles } from '../../whiteboard/viewer/selectionHandles';
import type { NativeClipboardService } from './useNativeClipboard';
import { gpuUnavailableText } from '../../utils/renderStatus';

export interface NativePdfBackdrop {
    readonly layers: readonly PlatformLayerDefinition[];
    readonly pages: readonly { readonly width: number; readonly height: number }[];
    captureSnapshot(request: CaptureRequest, memory: MemoryAllocator): CaptureSnapshot;
    assertCaptureCurrent(): void;
    /** Source-bound fields are supplied by the PDF owner; a changed source revokes this backdrop. */
    readonly sourceToken?: RenderToken;
    isCurrentSource?(): boolean;
    setVisible(visible: boolean, focused: boolean): void;
    notePresentation?(backend: CompositorBackend): void;
    dispose(): void;
}

type CameraOwner = ReturnType<typeof createBoardViewCamera>;
type CameraPorts = Parameters<CameraOwner['bind']>[0];
interface CameraHandoffState { readonly owner: CameraOwner; readonly runtime: BoardRuntime; readonly limits: ZoomLimits;
    readonly insets: ViewportInsets; claimed: boolean; closed: boolean }
export interface NativeCameraHandoff { dispose(): void }
const cameraHandoffs = new WeakMap<NativeCameraHandoff, CameraHandoffState>();
function retainCamera(owner: CameraOwner, runtime: BoardRuntime, limits: ZoomLimits, insets: ViewportInsets): NativeCameraHandoff {
    const state: CameraHandoffState = { owner, runtime, limits: { ...limits }, insets: { ...insets }, claimed: false, closed: false };
    const handoff: NativeCameraHandoff = { dispose() {
        if (state.closed) return;
        if (state.claimed) throw new Error('Camera handoff is being adopted');
        state.closed = true; cameraHandoffs.delete(handoff); owner.dispose();
    } };
    cameraHandoffs.set(handoff, state); return handoff;
}
function claimCamera(handoff: NativeCameraHandoff, runtime: BoardRuntime, limits: ZoomLimits, insets: ViewportInsets, ports: CameraPorts) {
    const state = cameraHandoffs.get(handoff);
    if (!state || state.closed || state.claimed || state.runtime !== runtime || state.limits.min !== limits.min || state.limits.max !== limits.max ||
        state.insets.left !== insets.left || state.insets.right !== insets.right || state.insets.top !== insets.top || state.insets.bottom !== insets.bottom) {
        throw new Error('Camera handoff does not belong to this board view');
    }
    state.claimed = true;
    try { state.owner.bind(ports); } catch (error) { state.claimed = false; throw error; }
    return { owner: state.owner,
        commit() { state.closed = true; state.claimed = false; cameraHandoffs.delete(handoff); },
        rollback() { state.owner.unbind(); state.claimed = false; } };
}

export interface NativeNavigationSnapshot { readonly page: number; readonly zoom: number }
/** This view's playback of its video pictures. Playback never dirties the document; only the view's frames carry it. */
export interface NativeVideoPlayback {
    /** True once a drawn frame has shown this picture, so starting playback is offered only after its image is on screen. */
    shown(node: NodeId): boolean;
    playing(node: NodeId): boolean;
    play(node: NodeId): void;
    pause(node: NodeId): void;
}
export interface NativeViewLease extends BoardViewLease<object> {
    readonly runtime: BoardRuntime;
    readonly engine: ViewerEngine;
    readonly camera: CameraController;
    readonly video: NativeVideoPlayback;
    readonly editing: ReturnType<typeof createNativeEditingLease> | null;
    getNavigationSnapshot(): NativeNavigationSnapshot;
    jump(page: number): void;
    zoomBy(factor: number): void;
    zoomAt(point: { x: number; y: number }, factor: number): void;
    /** One rung of the zoom ladder in `direction`, anchored at `anchor` (the view centre when absent). */
    zoomStep(direction: 1 | -1, anchor?: { x: number; y: number }): void;
    /** Zoom to 100%: on a paged host this toggles between natural 1 and fit-width (camera.md F-CAM-008). */
    resetZoom(): void;
    /** The keys a view without editing runs through its own chrome (zoom, fit, sheets); null while it has none. */
    setViewCommands(run: ((id: string) => boolean) | null): void;
    /** A camera glide to `target` over durationMs, in the pane's own motion; zero jumps. */
    glideTo(target: Camera, durationMs: number): void;
    cancelGlide(): void;
    reveal(rect: Rect): void;
    captureRegion(rect: Rect, maxSide: number, signal: AbortSignal): Promise<ImageBitmap>;
    captureBlob(rect: Rect, maxSide: number, signal: AbortSignal): Promise<Blob>;
    changed(): void;
    /** An outer source owner can fence input while its real view is covered or rebinding. */
    setInputPermitted(permitted: boolean): void;
    canMutateView(): boolean;
    isCurrent(): boolean;
    /** Transfer only after the old input and platform have detached. */
    takeCameraForRebind(): NativeCameraHandoff;
    refreshAuthority(): void;
    replaceBackdrop(backdrop: NativePdfBackdrop): void;
}
let serial = 0;
const detached = (): never => { throw new Error('The board platform is not attached'); };
/**
 * The motion of a view with no platform pane: none runs, so cancelling it is done, while starting one still throws. Hiding the
 * view detaches the pane before its tools dispose, and their camera commands cancel any glide as they go: thrown, it cut the
 * select services' dispose short (the camera commands' own surface listeners and everything disposed after them) and put
 * 'The board platform is not attached' on the board after every hide and show (measured: every run, on both backends).
 */
const DETACHED_MOTION = Object.freeze({ cancelMotion() {}, animateZoom: detached, animatePan: detached, glideTo: detached, startFling: detached });

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
    /** A board's read-only view mirrors its objects for screen readers, with the skip link and live region the editing view has. */
    readonlyAccessibility?: boolean;
    cameraHandoff?: NativeCameraHandoff;
    readPdfMedia?(id: MediaId, signal: AbortSignal): Promise<Blob>;
    editing?: {
        readonly clipboard: NativeClipboardService;
        /** Ctrl/Cmd+P's route: the board's Print, which asks Selection or Sheet first. */
        readonly print: () => boolean;
        readonly ui: NativeEditingToolOptions['ui'];
        readonly commands: NativeEditingToolOptions['commands'];
        /** Actual per-view services, not the document-wide promotion, authorize input. */
        canMutate(): boolean;
        onEmbedInfrastructure(value: NativeEmbedInfrastructure | null): void;
        onAttachment(attached: boolean): void;
    };
    onError(error: unknown): void;
    onNotice(message: string): void;
    /** A memory notice describes a state: it is withdrawn (this message) once a sharp frame presents. */
    onNoticeCleared?(message: string): void;
}): NativeViewLease {
    const { board, host, identity, limits, insets } = options;
    if (options.parameters.mode === 'edit' && !options.editing) {
        throw new Error('This canvas does not have an authorized editing host');
    }
    if (board.doc.kind === 'pdf-ink' && (!options.pdfBackdrop || !options.readPdfMedia)) {
        throw new Error('The PDF viewer requires its acquired backdrop and media reader');
    }
    if (board.doc.kind !== 'pdf-ink' && options.pdfBackdrop) throw new Error('A PDF backdrop requires a PDF ink session');
    const runtime = getBoardRuntime(board);
    if (!runtime || runtime.session !== board) throw new Error('Native viewer requires its acquired runtime');
    const boardRuntime = runtime;
    const sourceToken = board.doc.kind === 'pdf-ink' ? options.pdfBackdrop?.sourceToken : undefined;
    if (board.doc.kind === 'pdf-ink' && options.parameters.mode === 'edit' &&
        (!sourceToken || !options.pdfBackdrop?.isCurrentSource?.() || !host.canWriteSource(identity))) {
        throw new Error('PDF editing requires its current acquired source and write policy');
    }
    if (sourceToken && (sourceToken.documentId !== identity.documentId || sourceToken.session !== identity.session ||
        sourceToken.vaultEpoch !== identity.vaultActivation || !options.pdfBackdrop?.isCurrentSource?.() ||
        sourceToken.documentId !== runtime.paintToken.documentId || sourceToken.session !== runtime.paintToken.session ||
        sourceToken.vaultEpoch !== runtime.paintToken.vaultEpoch || sourceToken.bytesGeneration !== runtime.paintToken.bytesGeneration)) {
        throw new Error('PDF view source does not match its acquired owner');
    }
    const token = Object.freeze(sourceToken ? { ...sourceToken } : { vaultEpoch: identity.vaultActivation, documentId: identity.documentId,
        session: identity.session, bytesGeneration: identity.bytesGeneration });
    const viewLease = ++serial, listeners = new Set<(change?: string) => void>();
    let parameters = { ...options.parameters }, disposed = false, platformPane: PlatformPane | null = null;
    // Without editing, the board's input is the navigation host, whose keyboard moves only the camera it holds (pan, pages); the
    // zoom, fit and sheet rows it hands to the view's chrome, which runs them as its zoom panel does. Unbound, "=" and ⌘= did
    // nothing on an old notebook or drawing (measured: camera unchanged for =, -, ⌘=, ⌘-, ⇧0, ⇧1 and ⌥→ on a two-sheet drawing).
    let viewCommands: ((id: string) => boolean) | null = null;
    /** The read-only outline of the chosen object, while this view is attached to an input surface. */
    let readonlyOutline: ReturnType<typeof createSelectionHandles> | null = null;
    let inputPermitted = true;
    let backdrop = options.pdfBackdrop;
    let surface: HTMLElement | null = null;
    function sourceCurrent() {
        if (!backdrop?.sourceToken) return true;
        try { const source = backdrop.sourceToken, paint = boardRuntime.paintToken;
            return backdrop.isCurrentSource?.() === true && source.documentId === paint.documentId && source.session === paint.session &&
                source.vaultEpoch === paint.vaultEpoch && source.bytesGeneration === paint.bytesGeneration &&
                source.documentId === token.documentId && source.session === token.session && source.vaultEpoch === token.vaultEpoch &&
                source.bytesGeneration === token.bytesGeneration; }
        catch (error) { options.onError(error); return false; }
    }
    const current = () => !disposed && host.isCurrent(identity) && sourceCurrent();
    /** The one certificate that a presentation is complete, sharp and belongs to this live view, its platform
     * frame and its PDF source. The backdrop and the embed presentation both act only on it, so neither can
     * accept a frame the other refuses. */
    const certifyPresentation = (presentation: PlatformPresentation): boolean => {
        const source = backdrop?.sourceToken, actualFrame = platformPane?.currentFrameToken();
        return !!actualFrame && presentation.token.deviceGeneration === actualFrame.deviceGeneration &&
            presentation.token.viewLease === actualFrame.viewLease && actualFrame.documentId === token.documentId && actualFrame.session === token.session &&
            actualFrame.vaultEpoch === token.vaultEpoch && actualFrame.bytesGeneration === token.bytesGeneration &&
            presentation.complete && presentation.sharp && !presentation.staleVersion && parameters.visible && current() &&
            presentation.token.viewLease === viewLease && presentation.token.documentId === token.documentId && presentation.token.session === token.session &&
            presentation.token.vaultEpoch === token.vaultEpoch && presentation.token.bytesGeneration === token.bytesGeneration &&
            (!source || (!!backdrop?.isCurrentSource?.() && presentation.token.documentId === source.documentId &&
                presentation.token.session === source.session && presentation.token.vaultEpoch === source.vaultEpoch &&
                presentation.token.bytesGeneration === source.bytesGeneration));
    };
    // The viewer's 'paint' (paint progress) reaches this lease's listeners, and the board's own listener, but it does not redraw
    // the native pane: the pane's picture did not change.
    const publish = (change?: string) => { if (!disposed) for (const listener of [...listeners]) listener(change); };
    // What the platform pane last drew, as the viewer snapshot it was drawn from. A viewer 'state' publish repaints the pane only
    // when a field the pane draws from has moved since then (layers, scene revision, layout, palette, appearance, readiness,
    // backend, paint progress). Selection, accessibility and the read-only reason are state-only: the picture of a selection
    // is drawn by the interaction layers, which invalidate themselves, so a selection publish here repaints nothing new.
    // The viewer is attached below; until then no snapshot exists and every invalidation is taken as a change.
    let snapshotNow: () => ViewerSnapshot | null = () => null;
    let drawn: ViewerSnapshot | null = null;
    const invalidatePane = () => { drawn = snapshotNow(); platformPane?.invalidate('native-view'); };
    const drawsChanged = (): boolean => {
        const next = snapshotNow();
        if (!next || !drawn) { if (renderAuditEnabled()) auditCount('native', `draws-changed:${!next ? 'no-snapshot' : 'no-drawn'}`); return true; }
        // gh14 audit: each field that the pane draws from, counted when it is the reason a publish repaints (draws-changed:<field>).
        const fields: Array<[string, boolean]> = [
            ['state', drawn.state !== next.state], ['scene-revision', drawn.sceneRevision !== next.sceneRevision],
            ['layout', drawn.layout !== next.layout], ['palette', drawn.palette !== next.palette],
            ['background', drawn.appearance.background !== next.appearance.background], ['inverted', drawn.appearance.inverted !== next.appearance.inverted],
            ['layers', drawn.layers !== next.layers], ['backend', drawn.backendPreference !== next.backendPreference],
            ['paint-key', paintKey(drawn.state, drawn.paint) !== paintKey(next.state, next.paint)],
        ];
        let changed = false;
        for (const [name, differs] of fields) {
            if (!differs) continue;
            changed = true;
            if (renderAuditEnabled()) auditCount('native', `draws-changed:${name}`);
        }
        if (!changed && renderAuditEnabled()) auditCount('native', 'draws-unchanged');
        return changed;
    };
    // Direct callers (navigation, camera, the lease's own refreshes) always repaint; only the viewer's state publishes are filtered.
    const invalidate = (change?: string) => { if (change !== 'paint') invalidatePane(); publish(change); };
    const viewerChanged = (change?: string) => { if (change !== 'paint' && drawsChanged()) { if (renderAuditEnabled()) auditCount('native', 'hint:viewer'); invalidatePane(); } publish(change); };
    // gh14 audit: each caller of the unconditional invalidate is named (hint:<source>), so a native-view present is traced to its caller.
    const hintFrom = (source: string) => () => { if (renderAuditEnabled()) auditCount('native', `hint:${source}`); invalidate(); };
    const cameraPorts: CameraPorts = { currentPath: () => current() ? host.identity(identity.documentId)?.path : undefined,
        invalidate: hintFrom('camera'), onError: options.onError };
    const cameraClaim = options.cameraHandoff ? claimCamera(options.cameraHandoff, runtime, limits, insets, cameraPorts) : null;
    const cameraOwner = cameraClaim?.owner ?? createBoardViewCamera({ runtime, ...cameraPorts,
        limits, insets, initialViewport: { width: 0, height: 0, dpr: window.devicePixelRatio || 1 } });
    let cameraTransferred = false;
    try {
    const camera = cameraOwner.camera;
    const markUserNavigation = () => {
        if (board.doc.kind !== 'pdf-ink' || !parameters.visible || !current()) return;
        const path = host.identity(identity.documentId)?.path;
        if (path) recordPdfNavigation(path, 'annotation');
    };
    let viewportKey = '';
    const refreshViewport = () => {
        const viewport = camera.viewport, key = `${viewport.width}:${viewport.height}:${viewport.dpr}`;
        if (key !== viewportKey) { viewportKey = key; cameraOwner.resize(viewport); }
        return camera.viewport;
    };
    // A picture whose file is not in `.Assets` (the board moved without that folder, a sync not finished, a file deleted)
    // keeps its place and its reference; the screen and every export draw its placeholder, and the person is told once per
    // view which file to put back. The bare id read as a fault, and the notice came back on every repaint after Dismiss.
    const toldMissing = new Set<MediaId>();
    const missingPicture = (id: MediaId): MissingMediaError => {
        const entry = board.doc.media.get(id);
        const sentence = entry ? missingPictureSentence({ ...entry, file: runtime.media.currentFile(id) ?? entry.file })
            : 'A picture on this board is missing.';
        return new MissingMediaError(id, `${sentence} The rest of the board can be edited, saved and exported.`);
    };
    const tellMissing = (error: MissingMediaError) => { if (!toldMissing.has(error.id)) { toldMissing.add(error.id); options.onNotice(error.message); } };
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
            if (!found) throw missingPicture(id);
            return found.blob;
        }, invalidate: hintFrom('media'),
        // A picture that cannot be decoded is drawn as a placeholder and named in the app's notice; it is never the board's failure
        // (it was: 'Could not open canvas: Insufficient memory for full-frame image', on every reopen of a board holding the picture).
        // A transient failure (a cancelled or retired decode, a deadline, a memory refusal) is retried by the painter and is not the
        // person's news: naming it said 'could not be shown' over a picture that appeared a moment later.
        onError: error => {
            if (isMissingMedia(error)) tellMissing(error);
            else if (!isTransientPictureFailure(error)) options.onNotice(`A picture could not be shown: ${error instanceof Error ? error.message : String(error)}`);
        } });
    // This view's own playback: it stops when the view hides and when the view is torn down, and it closes its presented frames
    // before the source it came from is released.
    const video = new BoardVideoPlayback({ memory: images.memory, frames: images.frames,
        source(id) {
            const node = board.doc.nodes.get(id);
            if (!node || node.kind !== 'picture' || !node.media) return null;
            const entry = board.doc.media.get(node.media), bytes = runtime.media.get(node.media);
            return entry && bytes && entry.mime.startsWith('video/') ? { entry, blob: new Blob([bytes], { type: entry.mime }) } : null;
        },
        current: () => current() && parameters.visible,
        invalidate: hintFrom('video'),
        error: (_id, message) => options.onNotice(message) });
    // Animated pictures: the picture's own playing choice (its default follows the reduced-motion preference), and one clock
    // that decodes only the frame it is on. Their frames are presented through the same registry as a video's.
    const pictures = new PicturePlayback(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const pictureMedia = (node: NodeId): MediaId | null => {
        const value = board.doc.nodes.get(node);
        return value?.kind === 'picture' && value.media ? value.media : null;
    };
    const isVideo = (node: NodeId): boolean => {
        const media = pictureMedia(node);
        return media !== null && !!board.doc.media.get(media)?.mime.startsWith('video/');
    };
    const animation = new AnimatedPictureDriver({ registry: images.frames,
        source(id) {
            const media = pictureMedia(id), entry = media ? board.doc.media.get(media) : undefined, bytes = media ? runtime.media.get(media) : undefined;
            return entry && bytes && entry.animated && !entry.mime.startsWith('video/') && canAnimatePicture(entry.mime)
                ? { entry, blob: new Blob([bytes], { type: entry.mime }) } : null;
        },
        current: () => current() && parameters.visible,
        invalidate: hintFrom('animation'),
        // The viewer exists once attachView returns; a deadline set before that has no layer to wake yet, and the first paint re-arms it.
        wakeAt: deadline => { if (viewer) viewer.wakeAt(deadline); },
        error: (_id, message) => options.onNotice(message) });
    // The world rectangle this view shows; a sheet's picture counts for its overlap with it, and a picture inside a frame
    // counts for its whole box (its frame's transform is not resolved here, and only the overlap ranks which animate).
    const shownWorld = () => {
        const corner = (x: number, y: number) => surfaceToWorld({ x, y }, camera.camera);
        const a = corner(0, 0), b = corner(camera.viewport.width, camera.viewport.height);
        return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    };
    const animationDemands = (): AnimatedPictureDemand[] => {
        const sheet = runtime.selection.getSnapshot().sheet, shown = shownWorld(), demands: AnimatedPictureDemand[] = [];
        for (const id of board.doc.bySheet.get(sheet) ?? []) {
            const node = board.doc.nodes.get(id);
            if (!node || node.kind !== 'picture' || !node.media) continue;
            const entry = board.doc.media.get(node.media);
            if (!entry?.animated || entry.mime.startsWith('video/') || !canAnimatePicture(entry.mime)) continue;
            const area = isSheetParent(board.doc, node.parent)
                ? Math.max(0, Math.min(node.x + node.w, shown.x1) - Math.max(node.x, shown.x0)) * Math.max(0, Math.min(node.y + node.h, shown.y1) - Math.max(node.y, shown.y0))
                : node.w * node.h;
            demands.push({ node: id, media: node.media, visibleArea: area, playing: pictures.playing(id, node.media) });
        }
        return demands;
    };
    // The view's draw is the animation clock's sync point: it reads what is on the sheet and shown right now.
    const syncAnimation = () => animation.sync(animationDemands(), performance.now());
    const videoPort: NativeVideoPlayback = {
        shown: node => images.frames.drawn(node),
        playing(node) {
            if (isVideo(node)) return video.getState(node).playing;
            const media = pictureMedia(node);
            return media !== null && pictures.playing(node, media);
        },
        play(node) {
            if (isVideo(node)) { video.show(node, true); video.play(node); return; }
            const media = pictureMedia(node);
            if (media) pictures.setPlaying(node, media, true);
            invalidate();
        },
        pause(node) {
            if (isVideo(node)) { video.pause(node); return; }
            const media = pictureMedia(node);
            if (media) pictures.setPlaying(node, media, false);
            invalidate();
        },
    };
    const viewParameters = (): ViewerViewParams => ({ ...parameters, sheetId: runtime.selection.getSnapshot().sheet,
        // attachView owns the notebook's actual paper layer; adding another one
        // here gives the compositor two definitions with the same layer id.
        ...(backdrop ? { backdrops: backdrop.layers, pages: backdrop.pages } : {}) });
    const paneId = `native-${identity.documentId}-${viewLease}`;
    let viewer: ReturnType<typeof attachView>;
    const reveal = (rect: Rect) => { camera.bringIntoView(rect, 24); cameraOwner.changed(); };
    try {
        backdrop?.setVisible(parameters.visible && current(), parameters.focused && parameters.visible && current());
        images.setVisible(parameters.visible && current());
        video.setVisible(parameters.visible && current());
        animation.setVisible(parameters.visible && current(), performance.now());
        viewer = attachView({ session: board, token, view: viewParameters(), images, auditPane: paneId, liveFrames: videoFrameOverlay(images.frames, syncAnimation, keys => images.setDemand(keys)),
            reveal, onError: options.onError });
        snapshotNow = () => viewer.getSnapshot();
    } catch (error) { animation.dispose(); video.dispose(); backdrop?.dispose(); images.dispose(); if (!cameraClaim) cameraOwner.dispose(); throw error; }
    let presentedView: ViewState | null = null, presentedFrame: number | null = null, qualityNotice: string | null = null;
    const edit = options.parameters.mode === 'edit' ? options.editing : undefined;
    const editing = (() => { try { return edit ? createNativeEditingLease({ session: board, runtime, engine: viewer, token,
        framePresented: () => presentedView !== null,
        inputToken: { vaultEpoch: token.vaultEpoch, tabId: token.documentId, sessionGeneration: token.session, viewGeneration: viewLease },
        camera, viewport: refreshViewport, current: candidate => current() && candidate.documentId === token.documentId &&
            candidate.session === token.session && candidate.vaultEpoch === token.vaultEpoch && candidate.bytesGeneration === token.bytesGeneration,
        visible: () => parameters.visible, focused: () => parameters.focused, paged: board.doc.kind !== 'whiteboard',
        host, identity, clipboard: edit.clipboard, onEmbedInfrastructure: edit.onEmbedInfrastructure, certifyPresentation,
        bindClipboard: element => edit.clipboard.attach(element, lease, () => parameters.theme, options.onNotice, true,
            () => inputPermitted && parameters.mode === 'edit' && edit.canMutate(), edit.print),
        toolOptions: { runtime, engine: viewer, images, camera, token, alwaysSnap: () => getBoardPreferences().isSnapMode,
            cropFromHandle: (id, edge, pointer) => edit.clipboard.cropFromHandle(id, edge, pointer), dynamicSize: () => getBoardPreferences().isDynamicResizeMode,
            wrapMode: () => getBoardPreferences().isWrapMode,
            inputToken: { vaultEpoch: token.vaultEpoch, tabId: token.documentId, sessionGeneration: token.session, viewGeneration: viewLease },
            view: () => { if (!presentedView) throw new Error('The board has not presented its input mapping'); return presentedView; },
            viewport: refreshViewport, current: candidate => current() && candidate.documentId === token.documentId &&
                candidate.session === token.session && candidate.vaultEpoch === token.vaultEpoch && candidate.bytesGeneration === token.bytesGeneration,
            editable: () => inputPermitted && parameters.mode === 'edit' && edit.canMutate() && !board.isReadOnly && host.canWrite(identity), visible: () => parameters.visible, focused: () => parameters.focused,
            interaction: { invalidate: hintFrom('interaction'), cameraChanged: () => { markUserNavigation(); cameraOwner.changed(); } },
            platform: () => platformPane ?? DETACHED_MOTION,
            ui: edit.ui, commands: edit.commands }, invalidate: hintFrom('edit'), onError: options.onError }) : null;
        } catch (error) { viewer.dispose(); animation.dispose(); video.dispose(); images.dispose(); if (!cameraClaim) cameraOwner.dispose(); throw error; } })();
    const stopEditingReady = editing && edit ? editing.subscribeAttachment(edit.onAttachment) : undefined;
    if (editing && edit) edit.onAttachment(editing.isAttached());
    const navigation = editing ?? createBoardNavigationHost({ camera, viewport: refreshViewport, platform: () => platformPane,
        visible: () => parameters.visible && !!platformPane, current,
        changed: () => cameraOwner.changed(), onUserNavigation: markUserNavigation, invalidate, onError: options.onError,
        mac: /Mac|iPhone|iPad/.test(navigator.platform), invertMouseZoom: mouseZoomInverted, mouseWheel: mouseInputChosen,
        reducedMotion: () => getBoardPreferences().animationSpeed === 0, keyboard: { command: id => viewCommands?.(id) ?? false } });
    const withCapturer = <T,>(run: (capturer: ReturnType<typeof createPlatformCapturer>) => Promise<T>): Promise<T> => {
        if (!current()) return Promise.reject(new Error('Native view capture is unavailable'));
        const sheetId = runtime.selection.getSnapshot().sheet;
        const blobs = new Map<MediaId, Blob>();
        for (const id of board.doc.media.keys()) { const blob = runtime.media.get(id); if (blob) blobs.set(id, blob); }
        const revision = board.doc.rev;
        const capturer = createPlatformCapturer({ paneId, owner: token,
            encodePngTiles: (width, height, render, encodeOptions) => encodeTiledPngInWorker(width, height, render,
                { session: `view:${token.session}:${revision}`, epoch: token.vaultEpoch, revision }, encodeOptions),
            snapshot: (capture, memory) => {
            if (!current()) throw new DOMException('Native view ended', 'AbortError');
            const captureError = (error: unknown) => { if (isMissingMedia(error)) tellMissing(error); else options.onError(error); };
            const readMedia = async (entry: { readonly id: MediaId; readonly bytes: number }, signal: AbortSignal) => {
                signal.throwIfAborted();
                const blob = blobs.get(entry.id);
                if (!blob && board.doc.kind !== 'pdf-ink') throw missingPicture(entry.id);
                if (!blob || blob.size !== entry.bytes) throw new Error(`Captured board media is unavailable: ${entry.id}`);
                return blob;
            };
            if (board.doc.kind !== 'pdf-ink') return createBoardCaptureSnapshot({ runtime, sheetId, request: capture, memory, onError: captureError, readMedia });
            const pdf = backdrop;
            if (!pdf) throw new Error('PDF backdrop capture is unavailable');
            pdf.assertCaptureCurrent();
            const pdfIds = new Set(pdf.layers.map(layer => layer.id));
            const pdfLayers = capture.layers.filter(id => pdfIds.has(id));
            const boardLayers = capture.layers.filter(id => id === 'board-underlay' || id === 'board-content');
            if (pdfLayers.length + boardLayers.length !== capture.layers.length || !capture.layers.length) throw new Error('PDF capture requested an unavailable layer');
            const children: Array<{ snapshot: CaptureSnapshot; request: CaptureRequest }> = [];
            const releaseChildren = async () => {
                await Promise.all(children.map(async child => {
                    try { await child.snapshot.release(); }
                    catch (error) { try { options.onError(error); } catch { /* Release the other pins too. */ } }
                }));
            };
            let identityPin: ReturnType<NonNullable<BoardRuntime['scene']>['pin']> | undefined;
            try {
                if (pdfLayers.length) {
                    const request = { ...capture, layers: pdfLayers };
                    children.push({ snapshot: pdf.captureSnapshot(request, memory), request });
                }
                if (boardLayers.length) {
                    const request = { ...capture, layers: boardLayers };
                    children.push({ snapshot: createBoardCaptureSnapshot({ runtime, sheetId, request, memory, onError: captureError, readMedia }), request });
                } else {
                    if (!runtime.scene || runtime.scene.revision !== board.doc.rev) throw new Error('Board scene is not ready');
                    identityPin = runtime.scene.pin();
                }
                const root = boardLayers.length ? children[children.length - 1].snapshot : identityPin!;
                const controller = new AbortController();
                let releasing: Promise<void> | undefined;
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
                    // One bounded export tile at a time, so a PNG never holds a whole page of PDF tiles plus a full canvas.
                    async prepareTile(tile, signal) {
                        let result: 'exact' | 'standin' | 'incomplete' = 'exact';
                        for (const child of children) {
                            const part = { ...tile, layers: child.request.layers };
                            const status = child.snapshot.prepareTile ? await child.snapshot.prepareTile(part, signal)
                                : await child.snapshot.prepare(part, '2d', signal);
                            if (status === 'incomplete') return status;
                            if (status === 'standin') result = status;
                        }
                        return result;
                    },
                    release() {
                        if (releasing) return releasing;
                        controller.abort();
                        releasing = releaseChildren().finally(() => identityPin?.release());
                        return releasing;
                    },
                };
            } catch (error) {
                void releaseChildren().finally(() => identityPin?.release()).catch(cleanupError => {
                    try { options.onError(cleanupError); } catch { /* Preserve the acquisition error. */ }
                });
                throw error;
            }
        } });
        try { return run(capturer).finally(() => capturer.dispose()); }
        catch (error) { capturer.dispose(); return Promise.reject(error); }
    };
    const captureRegion = (rect: Rect, maxSide: number, request: CompositorCaptureOptions) =>
        withCapturer(capturer => capturer.captureRegion(rect, maxSide, request));
    // A PNG streams through bounded tiles: one single canvas for a 6x page plus every PDF tile of that page
    // did not fit the memory grant (a one-page agent view of a small PDF failed; the whole view fitted).
    const captureBlob = (rect: Rect, maxSide: number, request: CompositorCaptureOptions) =>
        withCapturer(capturer => capturer.captureExportBlob(rect, maxSide, request));
    const captureLayers = () => board.doc.kind === 'notebook' ? ['notebook-paper', 'board-underlay', 'board-content']
        : board.doc.kind === 'pdf-ink' ? [...(backdrop?.layers.map(layer => layer.id) ?? []), 'board-underlay', 'board-content']
            : ['board-underlay', 'board-content'];
    const services = createNativeViewPlatform({ host, identity, board, viewer, camera, documentToken: token,
        currentSource: sourceCurrent,
        paneId, viewLease,
        captureRegion, captureBlob,
        readSheetId: () => runtime.selection.getSnapshot().sheet,
        ports: { consumeInput: timestamp => navigation.consumeInput(timestamp), isInteracting: () => navigation.isInteracting(),
            setInputEnabled: enabled => navigation.setInputEnabled(enabled && inputPermitted && sourceCurrent() && parameters.visible),
            cancelViewWork: reason => navigation.cancelViewWork(reason),
            writeOverlays: frame => { refreshViewport(); recordViewport(); if (presentedFrame === frame.frameId) presentedView = { ...frame.view,
                camera: { ...frame.view.camera }, viewport: { ...frame.view.viewport } }; navigation.writeOverlays(frame); readonlyOutline?.write(frame); },
            onPresentation: presentation => {
                presentedFrame = presentation && current() && presentation.token.documentId === token.documentId &&
                    presentation.token.session === token.session && presentation.token.vaultEpoch === token.vaultEpoch &&
                    presentation.token.bytesGeneration === token.bytesGeneration ? presentation.frameId : null;
                // A null presentation is pane lifecycle (suspend, dispose, hide), not a new mapping: the last frame shown
                // stays until a frame is presented. Only a presentation this lease refuses clears it (hiding clears it in setView).
                if (presentation && presentedFrame === null) presentedView = null;
                navigation.onPresentation(presentation);
                // Audit only: why a presentation the embeds and backdrop act on was refused.
                if (presentation && renderAuditEnabled() && !certifyPresentation(presentation)) auditCount('embed', 'uncertified:' + (!presentation.complete ? 'incomplete'
                    : !presentation.sharp ? 'not-sharp' : presentation.staleVersion ? 'stale' : 'identity'));
                viewer.presentationAccepted(presentation && certifyPresentation(presentation) ? presentation : null);
                if (presentation && certifyPresentation(presentation)) backdrop?.notePresentation?.(presentation.backend);
                if (presentation && certifyPresentation(presentation)) recordBoardPresentation(performance.now(), presentation.backend);
                // A sharp, complete frame at full quality ends reduced quality: that notice is withdrawn. A refused CPU floor can hold
                // under a sharp frame, so the platform alone withdraws it (cleared here, it flashed for one frame).
                if (qualityNotice === noticeText('memory-pressure') && presentation && presentedFrame !== null && presentation.complete && presentation.sharp
                    && !presentation.staleVersion && certifyPresentation(presentation)) clearQualityNotice();
            }, onError: options.onError,
            onNoticeCleared: (code, cause) => {
                if (code === 'gpu-unavailable') options.onNoticeCleared?.(gpuUnavailableText(cause));
                else if (qualityNotice === noticeText(code)) clearQualityNotice();
            },
            onNotice: (code, cause) => {
                const text = code === 'gpu-unavailable' ? gpuUnavailableText(cause) : noticeText(code);
                if (code !== 'memory-pressure' && code !== 'cpu-floor-denied') { options.onNotice(text); return; }
                // The platform raises a memory notice only once this pane's own grant has kept it below full quality (or refused its
                // floor) for memoryNoticeDelayMs, and withdraws it when that ends; a cache trim is never one.
                if (disposed || qualityNotice === text) return;
                if (qualityNotice) clearQualityNotice();
                qualityNotice = text; options.onNotice(text);
            } } });
    function clearQualityNotice(): void {
        if (!qualityNotice) return;
        const shown = qualityNotice; qualityNotice = null; options.onNoticeCleared?.(shown);
    }
    // The platform receives the same controller as pointer input, including its
    // actual constraints and measured viewport; motion never uses a second pose.
    const platform = { ...services, camera, readCamera: () => { refreshViewport(); return camera.camera; } };
    let snapshot: BoardViewSnapshot<object> | undefined, priorLayers: ReturnType<typeof viewer.getSnapshot>['layers'], priorProgress = '';
    let navigationSnapshot: NativeNavigationSnapshot = { page: 0, zoom: 1 };
    const getNavigationSnapshot = () => {
        const stack = boardPageStack(board.doc.host);
        const pos = stack ? pagedPosition(camera.camera, camera.viewport, stack, insets) : null;
        const page = pos?.page ?? 0, zoom = pos?.zoom ?? camera.camera.z;
        if (page !== navigationSnapshot.page || zoom !== navigationSnapshot.zoom) navigationSnapshot = { page, zoom };
        return navigationSnapshot;
    };
    function recordViewport() {
        if (!parameters.visible || !current() || !platformPane) return;
        recordNativeAgentViewport(boardRuntime, { camera: camera.camera, viewport: camera.viewport, insets, focused: parameters.focused,
            inverted: parameters.inverted });
    }
    const stopViewer = viewer.subscribe(viewerChanged);
    const stopSelection = runtime.selection.subscribe(() => { viewer.setView(viewParameters()); publish(); });
    let resize: ResizeObserver | undefined;
    const detachSurface = () => { resize?.disconnect(); resize = undefined; surface = null; };
    const updateInput = () => {
        navigation.setInputEnabled(inputPermitted && sourceCurrent() && parameters.visible && !!platformPane);
    };
    let unregisterView: (() => void) | null = null;
    const lease: NativeViewLease = {
        runtime, engine: viewer, camera, editing, video: videoPort, getNavigationSnapshot, changed: () => cameraOwner.changed(), reveal,
        setInputPermitted(permitted) { if (!disposed) { inputPermitted = permitted; updateInput(); } },
        canMutateView() { return !disposed && !!editing && !!edit && inputPermitted && sourceCurrent() && parameters.visible && !!platformPane &&
            current() && edit.canMutate() && !board.isReadOnly && host.canWrite(identity); },
        isCurrent() { return current() && sourceCurrent(); },
        takeCameraForRebind() {
            if (disposed || cameraTransferred || platformPane || surface) throw new Error('Detach the old view before transferring its camera');
            cameraOwner.unbind(); cameraTransferred = true;
            const handoff = retainCamera(cameraOwner, runtime, limits, insets);
            try { lease.dispose(); return handoff; }
            catch (error) { handoff.dispose(); throw error; }
        },
        refreshAuthority() { if (!disposed) { updateInput(); viewer.setView(viewParameters()); hintFrom('authority')(); } },
        captureRegion: (rect, maxSide, signal) => captureRegion(rect, maxSide, { signal, theme: 'light', inverted: false, layers: captureLayers() }),
        captureBlob: (rect, maxSide, signal) => captureBlob(rect, maxSide, { signal, theme: 'light', inverted: false, layers: captureLayers() }),
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
            if (next) { markUserNavigation(); platformPane?.cancelMotion(); camera.setCamera(next); cameraOwner.changed(); }
        },
        zoomBy(factor) {
            if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid zoom factor');
            markUserNavigation();
            if (platformPane) platformPane.animateZoom(camera.camera.z * factor);
            else { camera.zoomTo(camera.camera.z * factor, { x: camera.viewport.width / 2, y: camera.viewport.height / 2 }); cameraOwner.changed(); }
        },
        zoomAt(point, factor) {
            if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid zoom anchor');
            markUserNavigation();
            if (platformPane) platformPane.animateZoom(camera.camera.z * factor, point);
            else { camera.zoomTo(camera.camera.z * factor, point); cameraOwner.changed(); }
        },
        glideTo(target, durationMs) {
            if (platformPane) platformPane.glideTo(target, durationMs);
            else { camera.setCamera(target); cameraOwner.changed(); }
        },
        cancelGlide() { platformPane?.cancelMotion(); },
        zoomStep(direction, anchor) {
            // Paged hosts step their ladder from fit-width, so "1" is the page filling the viewport, not 100%.
            const stack = boardPageStack(board.doc.host);
            const base = stack ? fitWidthZ(camera.viewport, stack, insets) : 1;
            if (!(base > 0)) return;
            const point = anchor ?? { x: camera.viewport.width / 2, y: camera.viewport.height / 2 };
            lease.zoomAt(point, zoomStepTarget(camera.camera.z, direction, base) / camera.camera.z);
        },
        setViewCommands(run) { viewCommands = disposed ? null : run; },
        resetZoom() {
            const stack = boardPageStack(board.doc.host);
            const base = stack ? fitWidthZ(camera.viewport, stack, insets) : 1;
            if (!(base > 0)) return;
            const point = { x: camera.viewport.width / 2, y: camera.viewport.height / 2 };
            lease.zoomAt(point, resetZoomTarget(camera.camera.z, base) / camera.camera.z);
        },
        view: {
            sourceToken: token,
            accessibility: viewer.accessibility, subscribe: listener => lease.subscribe(listener),
            setView(next) {
                if (parameters.visible && (!next.visible || (parameters.focused && !next.focused))) recordViewport();
                // The camera may move while hidden; the frame shown before hiding no longer describes it.
                if (parameters.visible && !next.visible) presentedView = null;
                parameters = { ...parameters, ...next };
                backdrop?.setVisible(parameters.visible && current(), parameters.focused && parameters.visible && current());
                images.setVisible(parameters.visible && current());
                video.setVisible(parameters.visible && current());
                animation.setVisible(parameters.visible && current(), performance.now());
                viewer.setView(viewParameters());
                updateInput();
            },
            attachPlatform(next) {
                if (!next) { recordViewport(); navigation.cancelViewWork('platform-detach'); }
                platformPane = next;
                updateInput();
                if (next) { next.beginFreshView(); next.invalidate('native-attachment'); }
            },
            attachInput(interaction, overlay) {
                detachSurface(); surface = interaction;
                // Only a view with no editing lease builds this mirror; editing builds the full one in its own input host.
                // A read-only view has no selection frame of its own (the editing services draw it), so a chosen object gets its outline alone.
                const outline = options.readonlyAccessibility && !edit ? createSelectionHandles({ runtime, overlay, current, visible: () => parameters.visible,
                    invalidate: invalidatePane, error: options.onError, outlineOnly: true }) : null;
                readonlyOutline = outline;
                const mirror = options.readonlyAccessibility && !edit ? createBoardAccessibilityDom({ runtime, engine: viewer, surface: interaction, overlay,
                    current, visible: () => parameters.visible, schedule: callback => { const frame = requestAnimationFrame(() => callback());
                        return () => cancelAnimationFrame(frame); },
                    reveal: id => { if (id) viewer.focusNode(id); }, error: options.onError, readOnly: true }) : null;
                const measure = () => {
                    if (surface !== interaction || disposed) return;
                    // Platform metrics remain authoritative once attached. This
                    // initial measure only lets a pre-frame notebook restore fit.
                    if (camera.viewport.width === 0 || camera.viewport.height === 0) cameraOwner.resize({ width: interaction.clientWidth,
                        height: interaction.clientHeight, dpr: window.devicePixelRatio || 1 });
                };
                resize = new ResizeObserver(measure); resize.observe(interaction); measure();
                const detach = navigation.attachInput(interaction, overlay);
                return () => { mirror?.dispose(); outline?.dispose(); if (readonlyOutline === outline) readonlyOutline = null; detach(); if (surface === interaction) detachSurface(); };
            },
        },
        getSnapshot() {
            const next = viewer.getSnapshot(), progress = paintKey(next.state, next.paint);
            if (!snapshot || priorLayers !== next.layers || snapshot.reason !== next.readOnlyReason || priorProgress !== progress) {
                priorLayers = next.layers; priorProgress = progress;
                snapshot = { layers: next.layers, reason: next.readOnlyReason, platform, readiness: next.state, paint: next.paint };
            }
            return snapshot;
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        dispose() {
            if (disposed) return;
            recordViewport(); disposed = true; unregisterView?.(); stopSelection(); stopViewer(); stopEditingReady?.(); edit?.onAttachment(false); detachSurface();
            navigation.dispose(); if (!cameraTransferred) cameraOwner.dispose(); viewer.dispose(); animation.dispose(); video.dispose(); images.dispose(); backdrop?.dispose(); backdrop = undefined; listeners.clear(); platformPane = null; viewCommands = null;
        },
    };
    // A mounted board answers the agent from its own live camera, inversion and frame, under the path it shows; dispose withdraws it.
    // The App's last real view answers only while this view has no measured viewport (see nativeAgentView).
    const livePath = host.identity(identity.documentId)?.path;
    if (livePath) {
        const live = createNativeLiveView({ runtime: boardRuntime,
            frame() {
                if (disposed || !current()) return null;
                refreshViewport();
                const viewport = camera.viewport;
                return viewport.width > 0 && viewport.height > 0 ? { camera: camera.camera, viewport, insets, inverted: parameters.inverted } : null;
            },
            // The capture contract is canonical light paint only; a view's inversion is reported by describe, never captured.
            captureRect: (rect, maxSide, signal) => captureBlob(rect, maxSide, { signal, theme: 'light', inverted: false, layers: captureLayers() }),
            current });
        // The save boundaries (Save, close, a disk conflict's Reload) ask the view for its unsaved edits. Without
        // these the native board answered "nothing pending" and a completed stroke could be lost (pdf-ink F-PINK-007).
        const reporter: ViewReporter = { kind: board.doc.kind === 'whiteboard' ? 'drawing' : board.doc.kind === 'notebook' ? 'notebook' : 'pdf-annotate',
            describe: () => live.describe({ deadlineMs: 30_000 }), live,
            hasPendingEdits: () => board.hasPendingEdits(),
            flushPending: () => { if (!board.isReadOnly && board.hasPendingEdits()) board.checkpoint(); } };
        unregisterView = registerView(livePath, reporter);
    }
    cameraClaim?.commit();
    return lease;
    } catch (error) { cameraClaim?.rollback(); throw error; }
}

/** The mounted board's answer to the agent: its own live camera, inversion and source, never a second store. The lease
 * supplies the frame it shows and its capture; the runtime supplies the document and the jobs. */
interface NativeLiveSource {
    readonly runtime: BoardRuntime;
    /** The camera this view shows now, or null while its pane has no measured viewport. */
    frame(): NativeAgentViewInput | null;
    /** This view's own capture of `rect`, at its live inversion, long side ≤ maxSide. */
    captureRect(rect: Rect, maxSide: number, signal: AbortSignal): Promise<Blob>;
    current(): boolean;
}

function createNativeLiveView(source: NativeLiveSource): NativeLiveView {
    const { runtime } = source;
    const live = () => {
        const frame = source.frame();
        return frame ? snapshotNativeAgentView(runtime, frame) : null;
    };
    const captureAt = (rect: Rect, maxSide: number, job: LiveJob) => captureLiveAgentProjection({ runtime,
        job: { signal: job.signal, deadlineMs: job.deadlineMs }, maxSide, isCurrent: source.current,
        pin: () => ({ revision: runtime.session.doc.rev, capture: signal => source.captureRect(rect, maxSide, signal), release() {} }) });
    const unlaid = () => new Error('This board is not laid out yet');
    return {
        measured: () => live() !== null,
        async describe(job) {
            const view = live();
            if (!view) throw unlaid();
            return describeLiveAgentView({ runtime, job: { signal: job.signal, deadlineMs: job.deadlineMs }, view: view.view,
                sheet: view.sheet, isCurrent: source.current });
        },
        capture(maxSide, job) {
            const view = live();
            if (!view) return Promise.reject(unlaid());
            return captureAt(view.region, maxSide, job);
        },
        renderPage(page, maxSide, job) {
            const stack = boardPageStack(runtime.session.doc.host), box = stack?.rects[page - 1];
            if (!box || !Number.isSafeInteger(page) || page < 1) return Promise.reject(new RangeError(`page ${page} is not on this board`));
            return captureAt({ x: box.x, y: box.y, width: box.width, height: box.height }, maxSide, job);
        },
    };
}

/** The platform reports codes; the bar shows sentences (the codes reached the owner as raw words). */
function noticeText(code: string): string {
    return code === 'memory-pressure' ? 'Rendering quality was reduced to fit memory.'
        : code === 'cpu-floor-denied' ? 'Rendering is limited by available memory.'
            : code === 'cpu-pinned' ? 'Rendering is using a compatible mode.'
                : gpuUnavailableText(undefined);
}
