import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useBoardNotices, type BoardNotices } from './boardNotices';
import { BoardNoticeStack } from './BoardNoticeStack';
import type { ViewportInsets, ZoomLimits } from '../../platform/render/camera';
import type { ActiveFile, Theme } from '../../types';
import type { NativeCanvasHost, NativeCanvasIdentity, NativeCopyView } from '../../types/nativeCanvas';
import type { NativeCanvasReady } from '../../types/reading';
import type { AttachCanvasSession } from '../../utils/canvasSessionBridge';
import { prepareNativeRuntime } from '../../whiteboard/host/prepareNativeRuntime';
import { legacyLoadPhase, showLegacyLoadTarget, subscribeLegacyLoadPhase } from '../../whiteboard/host/legacyLoadQueue';
import { registerNativeNotebookExporter } from '../../whiteboard/host/registerNativeNotebookExporter';
import { pinNativeSheetThumbnailBounds } from '../../whiteboard/host/sheetThumbnailBounds';
import { contentBounds, type ContentRect } from '../../whiteboard/commands/contentBounds';
import type { Camera } from '../../platform/types';
import { boardPageStack } from '../../whiteboard/model/pages';
import { useDocumentClipboard, useNativeClipboard } from './useNativeClipboard';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import { createNativeAcquisitionOptions } from './nativeAcquisitionOptions';
import { useNativeBoardAcquisition } from './useNativeBoardAcquisition';
import { createNativeViewLease, type NativeViewLease } from './nativeViewLease';
import { createNativeCameraOperations } from './nativeCameraOperations';
import { ReadOnlyBoardChrome } from './ReadOnlyBoardChrome';
import { isEditableCopyRequested, requestEditableCopy, subscribeEditableCopyRequests, takeCopyNotice, takeEditableCopyRequest } from '../../utils/oldBoards';
import ViewerHost from './ViewerHost';
import NativeNotebookThumbnails from './NativeNotebookThumbnails';
import NativeMinimap, { type NativeMinimapBox, type NativeMinimapThumbnail } from './NativeMinimap';
import { getBoardPreferences, subscribeBoardPreferences, updateBoardPreferences } from '../../utils/boardPreferences';
import { NativeCanvasEditing, type NativeEditingViewOptions, type NativeEditingRenderContext } from './NativeCanvasEditing';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import './NativeCanvasEntry.css';
import { yieldToHost } from '../../platform/yieldToHost';

/** A board that opened in the view route although it is not old (the developer's emergency switch, a failed editing
 * chunk), named as the person names it: it said "This native canvas…" for a notebook as for a drawing. */
const viewOnlyReason = (kind: NativeCanvasIdentity['kind']) => `This ${kind === 'notebook' ? 'notebook' : 'drawing'} is open for viewing only.`;
const reportThumbnailError = (error: unknown) => { console.error('Notebook thumbnail unavailable:', error); };

function cameraSnapshotReader(lease: NativeViewLease) {
    let value = { camera: { ...lease.camera.camera }, viewport: { ...lease.camera.viewport } };
    return () => {
        const camera = lease.camera.camera, viewport = lease.camera.viewport, old = value;
        if (old.camera.x !== camera.x || old.camera.y !== camera.y || old.camera.z !== camera.z ||
            old.viewport.width !== viewport.width || old.viewport.height !== viewport.height || old.viewport.dpr !== viewport.dpr) {
            value = { camera: { ...camera }, viewport: { ...viewport } };
        }
        return value;
    };
}

/** Selected shapes the minimap paints; a larger selection shows its first shapes' boxes. */
const MINIMAP_HIGHLIGHT_LIMIT = 64;
/** A bounds query that the scene's rebuild aborts is retried this many times, this many milliseconds apart. */
const MINIMAP_BOUNDS_ATTEMPTS = 5, MINIMAP_BOUNDS_RETRY_MS = 60;

function readMinimapOpen(): boolean {
    return getBoardPreferences().minimapOpen;
}

export interface NativeCanvasEntryProps {
    readonly file: ActiveFile;
    readonly documentId: string;
    readonly identity: NativeCanvasIdentity;
    readonly nativeCanvasHost: NativeCanvasHost;
    readonly attachCanvasSession: AttachCanvasSession;
    readonly onNativeCanvasReady: NativeCanvasReady;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly theme: Theme;
    readonly emergencyReadOnly: boolean;
    readonly zoomLimits: ZoomLimits;
    readonly insets: ViewportInsets;
    readonly zMax: number;
    readonly deadlineMs: number;
    readonly registerKeyboardTarget: (path: string, focus: () => void) => () => void;
    readonly onFocusPane: (path: string) => void;
}

/** An old-format board's copy, run by the pane that holds the board (utils/oldBoards.ts): one at a time, from a request
 * the open dialog, the strip's button or a tree row made. The copy is App's to finish once started — it replaces this
 * pane's tab — so it is never aborted from here; a failure is told by App and leaves the original as it was. */
function useEditableCopy(adapter: HostedBoardAdapter<BoardSessionPort>, host: NativeCanvasHost, identity: NativeCanvasIdentity,
    view: () => NativeCopyView | undefined) {
    const oldBoard = adapter.oldBoard, documentId = identity.documentId;
    const requested = useSyncExternalStore(subscribeEditableCopyRequests, () => isEditableCopyRequested(documentId), () => false);
    const [copying, setCopying] = useState(false);
    const mounted = useRef(true);
    // The strip's button had the keyboard when it asked: it goes with the pane, so the copy that replaces the pane takes the
    // keyboard instead of leaving it on the page (a column reached by Tab is not the focused pane, so App cannot tell).
    const keyboardHere = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        if (!oldBoard || !requested || copying || !takeEditableCopyRequest(documentId)) return;
        setCopying(true);
        const signal = new AbortController().signal, focus = keyboardHere.current;
        keyboardHere.current = false;
        void (async () => {
            try {
                const source = await oldBoard.copySource(signal, view());
                await host.makeEditableCopy(identity, { source, notice: oldBoard.copyNotice, focus }, signal);
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('Could not make an editable copy:', error);
            } finally { if (mounted.current) setCopying(false); }
        })();
    }, [oldBoard, requested, copying, documentId, host, identity, view]);
    const onCopy = useCallback((trigger: HTMLElement) => {
        keyboardHere.current = trigger === document.activeElement;
        requestEditableCopy(documentId);
    }, [documentId]);
    return oldBoard ? { kind: oldBoard.kind, copying: copying || requested, onCopy } : undefined;
}

function NativeViewer({ props, identity, board, adapter, onError }: {
    props: NativeCanvasEntryProps; identity: NativeCanvasIdentity; board: ComposedBoardSession;
    adapter: HostedBoardAdapter<BoardSessionPort>; onError(error: unknown): void;
}) {
    const latest = useRef(props);
    useLayoutEffect(() => { latest.current = props; }, [props]);
    const [inverted, setInverted] = useState(false);
    const importNotice = adapter.importNotice;
    // As the editing view does: dismissed, an import's notice is done for this session, a remounted pane included.
    const dismissImport = useCallback((message: string) => { if (importNotice && message === importNotice.text) importNotice.dismiss(); }, [importNotice]);
    const notices = useBoardNotices(importNotice && !importNotice.isDismissed() ? [importNotice.text] : [], dismissImport);
    const { show: setNotice, clear: clearNotice } = notices;
    // Where the person is looking, read when the copy is made: the copy opens there.
    const leaseRef = useRef<NativeViewLease | null>(null);
    const copyView = useCallback((): NativeCopyView | undefined => {
        const view = leaseRef.current;
        if (!view || view.camera.viewport.width <= 0) return undefined;
        const { x, y, z } = view.camera.camera;
        return { sheet: view.runtime.selection.getSnapshot().sheet, x, y, zoom: z };
    }, []);
    const oldBoard = useEditableCopy(adapter, props.nativeCanvasHost, identity, copyView);
    const [lease, setLease] = useState<NativeViewLease | null>(null);
    const { nativeCanvasHost, zoomLimits: { min, max }, insets: { left, right, top, bottom } } = props;
    useEffect(() => {
        let view: NativeViewLease;
        try {
            const current = latest.current;
            view = createNativeViewLease({ host: nativeCanvasHost, identity, board,
                parameters: { mode: 'view', visible: current.isVisible, focused: current.isFocused, theme: current.theme, inverted: false },
                limits: { min, max }, insets: { left, right, top, bottom }, readonlyAccessibility: true, onError, onNotice: setNotice,
                onNoticeCleared: clearNotice });
        } catch (error) { onError(error); return; }
        setLease(view);
        leaseRef.current = view;
        return () => {
            if (leaseRef.current === view) leaseRef.current = null;
            setLease(previous => previous === view ? null : previous); view.dispose();
        };
    }, [board, identity, nativeCanvasHost, min, max, left, right, top, bottom, onError, setNotice, clearNotice]);
    if (!lease) return <div className="canvas-pane-message is-waiting" role="status">Preparing {identity.kind === 'notebook' ? 'notebook' : 'drawing'} view…</div>;
    return <AttachedViewer props={props} identity={identity} lease={lease} inverted={inverted} setInverted={setInverted} notices={notices}
        oldBoard={oldBoard} viewNotice={oldBoard ? null : viewOnlyReason(identity.kind)} />;
}

export interface NativeEditingChromeContext {
    readonly minimapOpen: boolean;
    readonly setMinimapOpen: (value: boolean) => void;
    readonly inverted: boolean;
    readonly setInverted: (value: boolean) => void;
    readonly zoom: number;
}
export function AttachedViewer({ props, identity, lease, inverted, setInverted, notices, editingChrome, editingWritable, editingAdmitting, oldBoard, viewNotice = viewOnlyReason(identity.kind) }: {
    props: NativeCanvasEntryProps; identity: NativeCanvasIdentity; lease: NativeViewLease; inverted: boolean;
    setInverted(value: boolean): void; notices: BoardNotices;
    editingChrome?: (context: NativeEditingChromeContext) => ReactNode;
    editingWritable?: boolean;
    editingAdmitting?: boolean;
    /** An old-format board's copy, for the read-only strip. */
    oldBoard?: { readonly kind: 'drawing' | 'notebook'; readonly copying: boolean; readonly onCopy: (trigger: HTMLElement) => void };
    /** What a read-only view says it is, at the bottom; null when its own strip already says so (an old board). */
    viewNotice?: string | null;
}) {
    const setNotice = notices.show;
    const view = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
    const navigation = useSyncExternalStore(lease.subscribe, lease.getNavigationSnapshot, lease.getNavigationSnapshot);
    const selection = lease.runtime.selection;
    const selected = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
    const board = lease.runtime.session;
    const subscribeRevision = useCallback((listener: () => void) => board.subscribe(listener), [board]);
    const getRevision = useCallback(() => board.doc.rev, [board]);
    const revision = useSyncExternalStore(subscribeRevision, getRevision, getRevision);
    const getSceneRevision = useCallback(() => lease.runtime.scene?.ready ? lease.runtime.scene.revision : -1, [lease]);
    const sceneRevision = useSyncExternalStore(lease.subscribe, getSceneRevision, getSceneRevision);
    const current = useCallback(() => props.nativeCanvasHost.isCurrent(identity), [props.nativeCanvasHost, identity]);
    // Thumbnails read the document's all-sheet print source, so they wait for the same command service the view uses.
    const clipboard = useDocumentClipboard(lease.runtime, props.nativeCanvasHost, identity, setNotice);
    const capturePage = useCallback((index: number, maxSide: number, signal: AbortSignal) => clipboard
        ? clipboard.pagePng(index, maxSide, signal) : Promise.reject(new Error('The board is not ready to show its pages.')), [clipboard]);
    const jump = useCallback((page: number) => lease.jump(page), [lease]);
    const stack = board.doc.kind === 'notebook' ? boardPageStack(board.doc.host) : undefined;
    // The minimap's open state is one shared preference (collapsed by default), so every board and tab agrees.
    const minimapOpen = useSyncExternalStore(subscribeBoardPreferences, readMinimapOpen, readMinimapOpen);
    const setMinimapOpen = useCallback((open: boolean) => { updateBoardPreferences({ minimapOpen: open }); }, []);
    const [thumbnail, setThumbnail] = useState<NativeMinimapThumbnail | null>(null);
    const [minimapNotice, setMinimapNotice] = useState('');
    const fonts = lease.runtime.render.text.fonts;
    const subscribeFonts = useCallback((listener: () => void) => fonts.subscribe(listener), [fonts]);
    const getFontEpoch = useCallback(() => fonts.epoch, [fonts]);
    const fontEpoch = useSyncExternalStore(subscribeFonts, getFontEpoch, getFontEpoch);
    const cameraStore = useMemo(() => cameraSnapshotReader(lease), [lease]);
    const cameraState = useSyncExternalStore(lease.subscribe, cameraStore, cameraStore);
    const sheet = selected.sheet;
    const thumbnailKey = JSON.stringify([identity.documentId, identity.session, revision, fontEpoch, sheet]);
    const minimapCurrent = useCallback(() => current() && board.doc.rev === revision && fonts.epoch === fontEpoch &&
        selection.getSnapshot().sheet === sheet, [current, board, revision, fonts, fontEpoch, selection, sheet]);
    useEffect(() => {
        setThumbnail(null); setMinimapNotice('');
        if (!minimapOpen || !props.isVisible || board.doc.kind !== 'whiteboard' || sceneRevision !== revision || !minimapCurrent()) return;
        const controller = new AbortController();
        void (async () => {
            try {
                await lease.runtime.ready;
                controller.signal.throwIfAborted();
                const result = await pinNativeSheetThumbnailBounds({ runtime: lease.runtime, sheet, revision, fontEpoch,
                    current: minimapCurrent, signal: controller.signal,
                    capture: (rect, signal) => lease.captureBlob(rect, 512, signal) });
                if (!controller.signal.aborted && minimapCurrent()) setThumbnail({ key: thumbnailKey, blob: result.blob, worldBounds: result.bounds, revision });
            } catch (error) {
                if (!controller.signal.aborted && minimapCurrent()) setMinimapNotice(error instanceof Error ? error.message : 'Minimap is unavailable.');
            }
        })();
        return () => controller.abort();
    }, [minimapOpen, props.isVisible, board, lease, sheet, revision, sceneRevision, fontEpoch, minimapCurrent, thumbnailKey]);
    // One glide at a time: a newer map move (a click, a drag's first step) replaces the one in flight, in the pane's motion.
    useEffect(() => () => { lease.cancelGlide(); }, [lease]);
    const navigateMinimap = useCallback((centre: { x: number; y: number }, mode: 'glide' | 'jump') => {
        if (!minimapCurrent()) return;
        const from = lease.camera.camera, viewport = lease.camera.viewport;
        const target = { x: centre.x - viewport.width / (2 * from.z), y: centre.y - viewport.height / (2 * from.z), z: from.z };
        // 320 ms is tldraw's medium animation (options.ts animationMediumMs), scaled by the board's motion setting: zero jumps.
        lease.glideTo(target, mode === 'jump' ? 0 : 320 * getBoardPreferences().animationSpeed);
    }, [lease, minimapCurrent]);
    // The selection's exact boxes, so the map can paint them. Read per shape with the scene's cached bounds, capped so a
    // huge selection cannot queue an unbounded walk.
    const [highlights, setHighlights] = useState<readonly NativeMinimapBox[]>([]);
    const selectedIds = selected.selected;
    useEffect(() => {
        setHighlights([]);
        if (!minimapOpen || !props.isVisible || board.doc.kind !== 'whiteboard' || !selectedIds.length) return;
        const controller = new AbortController();
        const ids = selectedIds.slice(0, MINIMAP_HIGHLIGHT_LIMIT);
        void (async () => {
            try {
                await lease.runtime.ready;
                const boxes: NativeMinimapBox[] = [];
                const fence = () => { if (controller.signal.aborted || !minimapCurrent()) throw new DOMException('Minimap selection changed', 'AbortError'); };
                const cooperate = yieldToHost;
                for (const id of ids) {
                    // The scene rebuilds as the selection settles, and contentBounds then aborts with "Scene geometry changed".
                    // That abort is a retry, not a failure: the query runs again once the scene is quiet, and only a map
                    // that keeps losing the race reports it.
                    let box: ContentRect | null = null;
                    for (let attempt = 1; ; attempt++) {
                        try { box = await contentBounds(lease.runtime, [id], { signal: controller.signal, fence, cooperate }); break; }
                        catch (error) {
                            const retry = error instanceof DOMException && error.name === 'AbortError' && attempt < MINIMAP_BOUNDS_ATTEMPTS;
                            if (!retry || controller.signal.aborted) throw error;
                            await new Promise<void>(resolve => setTimeout(resolve, MINIMAP_BOUNDS_RETRY_MS));
                        }
                    }
                    if (box) boxes.push(box);
                }
                if (!controller.signal.aborted && minimapCurrent()) setHighlights(boxes);
            } catch (error) {
                if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
                    setMinimapNotice(error instanceof Error ? error.message : 'Minimap is unavailable.');
                }
            }
        })();
        return () => controller.abort();
    }, [minimapOpen, props.isVisible, board, lease, selectedIds, revision, minimapCurrent]);
    const { onFocusPane, registerKeyboardTarget } = props;
    const path = props.file.path;
    const onFocus = useCallback(() => onFocusPane(path), [onFocusPane, path]);
    const register = useCallback((focus: () => void) => registerKeyboardTarget(path, focus), [registerKeyboardTarget, path]);
    const sheets = board.doc.sheetOrder;
    const currentTheme = useRef(props.theme);
    useLayoutEffect(() => { currentTheme.current = props.theme; }, [props.theme]);
    const readTheme = useCallback(() => currentTheme.current, []);
    const viewer = useNativeClipboard(lease, props.nativeCanvasHost, identity, readTheme, setNotice);
    // The view's zoom panel runs the editing view's own camera operations (one fit, contentBounds.ts), over this lease.
    const [viewCamera, setViewCamera] = useState<ReturnType<typeof createNativeCameraOperations> | null>(null);
    const minimapOpenRef = useRef(minimapOpen);
    useLayoutEffect(() => { minimapOpenRef.current = minimapOpen; }, [minimapOpen]);
    useEffect(() => {
        if (editingChrome) return;
        const lifetime = new AbortController();
        setViewCamera(createNativeCameraOperations({ runtime: lease.runtime, lease, current, signal: lifetime.signal,
            minimapVisible: () => minimapOpenRef.current, setMinimapVisible: setMinimapOpen }));
        return () => { lifetime.abort(); setViewCamera(null); };
    }, [editingChrome, lease, current, setMinimapOpen]);
    const pageCount = board.doc.kind === 'notebook' && board.doc.host.kind === 'notebook' ? board.doc.host.paper.pageCount : 0;
    // An old board's own read-only reason is written for the agent and the write seams; its strip says it to the person.
    const viewReason = oldBoard && view.reason === board.readOnlyReason ? null : view.reason;
    return <ViewerHost name={props.file.name} noun={board.doc.kind === 'notebook' ? 'notebook' : 'drawing'} documentId={props.documentId} vaultEpoch={props.identity.vaultActivation}
        isVisible={props.isVisible} isFocused={props.isFocused} theme={props.theme} inverted={inverted}
        view={editingChrome ? lease.view : viewer} layers={view.layers} platform={view.platform} readiness={view.readiness} paint={view.paint} reason={viewReason ?? (editingChrome ? '' : viewNotice)}
        readOnly={editingChrome ? board.isReadOnly || !editingWritable : true} admitting={!!editingChrome && !!editingAdmitting} externalAccessibility
        readOnlyNotice={editingChrome ? (board.readOnlyReason ?? viewOnlyReason(identity.kind)) : viewNotice ?? ''} registerKeyboardTarget={register} onFocus={onFocus}
        chrome={<>{editingChrome ? editingChrome({ minimapOpen, setMinimapOpen, inverted, setInverted, zoom: navigation.zoom })
            : viewCamera && <ReadOnlyBoardChrome camera={viewCamera} zoom={navigation.zoom} minimapOpen={minimapOpen} kind={board.doc.kind}
                sheets={sheets} sheet={selected.sheet} setSheet={id => { const target = sheets.find(item => item.id === id); if (target) selection.setSheet(target.id); }} inverted={inverted} setInverted={setInverted}
                output={clipboard} oldBoard={oldBoard} thumbnails={stack && pageCount > 1 ? (open, setOpen) => <NativeNotebookThumbnails open={open} onOpenChange={setOpen}
                    pages={stack.rects} revision={revision} page={navigation.page} isVisible={props.isVisible}
                    current={current} currentRevision={getRevision} capturePage={capturePage} jump={jump} onError={reportThumbnailError} /> : undefined} />}
        {/* The board's notices (a picture that could not be shown, no usable GPU, what an old board's import left out): a bare
            span sat unstyled in the chrome fragment and never appeared on screen. They persist until the person puts each away. */}
        <BoardNoticeStack notices={notices} />
        {board.doc.kind === 'whiteboard' && <NativeMinimap thumbnail={thumbnail?.key === thumbnailKey ? thumbnail : null} currentCamera={cameraState.camera} viewport={cameraState.viewport}
            isVisible={props.isVisible && minimapOpen} currentOwner={minimapCurrent} highlights={highlights} onNavigate={navigateMinimap} onFocus={onFocus} />}
        {minimapOpen && minimapNotice && <div className="board-viewer-notice" role="status">{minimapNotice}</div>}</>} />;
}

function NativeDrawingEditing({ props, board, adapter, onError, onUnavailable }: {
    readonly props: NativeCanvasEntryProps; readonly board: ComposedBoardSession;
    readonly adapter: HostedBoardAdapter<BoardSessionPort>; readonly onError: (error: unknown) => void;
    readonly onUnavailable: (error: unknown) => void;
}) {
    const latest = useRef(props); useLayoutEffect(() => { latest.current = props; }, [props]);
    const { identity, nativeCanvasHost: host, zoomLimits: { min, max }, insets: { left, right, top, bottom } } = props;
    const createLease = useCallback(async (editing: NativeEditingViewOptions, signal: AbortSignal, notice: (message: string) => void,
        clearNotice: (message: string) => void) => {
        signal.throwIfAborted(); const now = latest.current;
        return createNativeViewLease({ host, identity, board, parameters: { mode: 'edit', visible: now.isVisible,
            focused: now.isFocused, theme: now.theme, inverted: false }, limits: { min, max }, insets: { left, right, top, bottom },
            editing, onError, onNotice: notice, onNoticeCleared: clearNotice });
    }, [host, identity, board, min, max, left, right, top, bottom, onError]);
    const renderView = useCallback((context: NativeEditingRenderContext) => <AttachedViewer props={props} identity={identity}
        lease={context.lease} inverted={context.inverted} setInverted={context.setInverted} notices={context.notices}
        editingChrome={context.chrome} editingWritable={context.editable} editingAdmitting={context.admitting} />, [props, identity]);
    return <NativeCanvasEditing props={props} board={board} adapter={adapter} factory={host.createEditingCapabilities}
        createLease={createLease} renderView={renderView} onError={onError} onUnavailable={onUnavailable} />;
}

/** Every wait before the board ends in the board or in an error that can be retried: a retry remounts the acquisition, whose
 * failed flight is already gone (acquireNativeBoard.ts), so it starts over with fresh workers (platform/workers/client.ts). */
export default function NativeCanvasEntry(props: NativeCanvasEntryProps) {
    const [attempt, setAttempt] = useState(0);
    const retry = useCallback(() => setAttempt(value => value + 1), []);
    return <NativeCanvasAcquisition key={attempt} props={props} onRetry={retry} />;
}

/** What the pane says while a tldraw-format file waits for, or goes through, its load (whiteboard/host/legacyLoadQueue.ts). */
function useLegacyLoadStatus(documentId: string, kind: NativeCanvasIdentity['kind'], isVisible: boolean): string | null {
    useEffect(() => isVisible ? showLegacyLoadTarget(documentId) : undefined, [documentId, isVisible]);
    const phase = useSyncExternalStore(subscribeLegacyLoadPhase, () => legacyLoadPhase(documentId), () => null);
    const noun = kind === 'notebook' ? 'notebook' : 'drawing';
    return phase === 'loading' ? `Opening ${noun}…`
        : phase === 'waiting' ? `Opening ${noun}: waiting for another document to finish opening…` : null;
}

function NativeCanvasAcquisition({ props, onRetry }: { props: NativeCanvasEntryProps; onRetry: () => void }) {
    const { identity: incoming, nativeCanvasHost, documentId, attachCanvasSession: attach,
        onNativeCanvasReady: ready, deadlineMs, zMax } = props;
    const [identity, setIdentity] = useState(() => incoming);
    useLayoutEffect(() => {
        if (identity.documentId !== incoming.documentId || identity.session !== incoming.session
            || identity.vaultActivation !== incoming.vaultActivation || identity.bytesGeneration !== incoming.bytesGeneration
            || identity.kind !== incoming.kind) setIdentity(incoming);
    }, [identity, incoming]);
    const [emergencyReadOnly] = useState(() => props.emergencyReadOnly);
    const emergencyPolicy = useCallback(() => emergencyReadOnly, [emergencyReadOnly]);
    const [error, setError] = useState<string | null>(null);
    const [editingFailure, setEditingFailure] = useState<{ documentId: string; session: number; reason: string } | null>(null);
    const editingUnavailable = useCallback((cause: unknown) => setEditingFailure({ documentId: identity.documentId, session: identity.session,
        reason: cause instanceof Error ? cause.message : String(cause) }), [identity.documentId, identity.session]);
    const onError = useCallback((cause: unknown) => {
        console.error('Native canvas acquisition failed:', cause);
        setError(cause instanceof Error ? cause.message : String(cause));
    }, []);
    const prepare = useCallback((signal: AbortSignal) => {
        if (identity.documentId !== documentId || identity.kind === 'pdfInk') throw new Error('Canvas identity does not match this entry');
        return prepareNativeRuntime({ host: nativeCanvasHost, identity, representation: identity.kind, signal,
            deadlineMs, zMax,
            onError, onHistoryLimit: () => setError('The board history limit was reached.') }).then(prepared => {
            // An editable copy of an old board opens with what that board's import left out, said once (utils/oldBoards.ts).
            const handed = takeCopyNotice(identity.documentId);
            return handed && !prepared.importNotice ? { ...prepared, importNotice: handed } : prepared;
        });
    }, [identity, documentId, nativeCanvasHost, deadlineMs, zMax, onError]);
    const acquisition = useMemo(() => createNativeAcquisitionOptions<ComposedBoardSession>({ host: nativeCanvasHost,
        identity, attachCanvasSession: attach, onNativeCanvasReady: ready, prepare, onError,
        emergencyReadOnly: emergencyPolicy, emergencyReadOnlyReason: viewOnlyReason(identity.kind),
    }), [nativeCanvasHost, identity, attach, ready, prepare, onError, emergencyPolicy]);
    const acquired = useNativeBoardAcquisition(acquisition);
    useEffect(() => {
        const board = acquired?.adapter.board;
        if (!board || identity.kind !== 'notebook') return;
        try {
            // The exporter streams every page into the incremental writer, which selects
            // the native or generated-only route by build availability before any work.
            registerNativeNotebookExporter({ board, host: nativeCanvasHost, identity, onError });
        } catch (cause) { onError(cause); }
    }, [acquired, identity, nativeCanvasHost, onError]);
    const opening = useLegacyLoadStatus(documentId, identity.kind, props.isVisible);
    // A copy asked for from the tree before the file's bytes were read (a `.tldraw` an earlier build already converted in
    // place) finds a board that is editable as it is: there is nothing to copy, and the request must not wait for a reload.
    useEffect(() => { if (acquired && !acquired.adapter.oldBoard) takeEditableCopyRequest(documentId); }, [acquired, documentId]);
    // A copy is made from the board in memory, so one that did not open has none to make. The request is taken, not left
    // for a later load to run unasked, and the person who pressed "Make a copy" is told (measured: a board whose
    // picture file was missing answered that button with nothing at all).
    const [copyAbandoned, setCopyAbandoned] = useState(false);
    useEffect(() => { if (error && takeEditableCopyRequest(documentId)) setCopyAbandoned(true); }, [error, documentId]);
    if (identity.documentId !== incoming.documentId || identity.session !== incoming.session
        || identity.vaultActivation !== incoming.vaultActivation || identity.bytesGeneration !== incoming.bytesGeneration
        || identity.kind !== incoming.kind) return <div className="canvas-pane-message is-waiting" role="status">Preparing canvas…</div>;
    if (error) return <div className="canvas-pane-message" role="alert">
        <span>Could not open canvas: {error}{copyAbandoned && `${/[.!?…]$/.test(error) ? '' : '.'} No copy was made, because it did not open.`}</span>
        <button type="button" className="pdf-pane-action" onClick={onRetry}>Try again</button>
    </div>;
    if (!acquired) return <div className={`canvas-pane-message${opening ? '' : ' is-waiting'}`} role="status">{opening ?? 'Preparing canvas…'}</div>;
    // An old-format board is only ever viewed: the viewer route, with no editing capabilities loaded at all (utils/oldBoards.ts).
    if (acquired.adapter.oldBoard || emergencyReadOnly || (editingFailure?.documentId === identity.documentId && editingFailure.session === identity.session)) {
        return <><NativeViewer props={props} identity={identity} board={acquired.adapter.board} adapter={acquired.adapter} onError={onError} />
            {editingFailure && <div role="status">Editing unavailable: {editingFailure.reason}</div>}</>;
    }
    return <NativeDrawingEditing props={{ ...props, identity }} board={acquired.adapter.board} adapter={acquired.adapter}
        onError={onError} onUnavailable={editingUnavailable} />;
}
