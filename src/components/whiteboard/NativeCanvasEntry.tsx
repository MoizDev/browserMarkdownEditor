import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ViewportInsets, ZoomLimits } from '../../platform/render/camera';
import type { ActiveFile, Theme } from '../../types';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { NativeCanvasReady } from '../../types/reading';
import type { AttachCanvasSession } from '../../utils/canvasSessionBridge';
import { prepareNativeRuntime } from '../../whiteboard/host/prepareNativeRuntime';
import { registerNativeNotebookExporter } from '../../whiteboard/host/registerNativeNotebookExporter';
import { pinNativeSheetThumbnailBounds } from '../../whiteboard/host/sheetThumbnailBounds';
import { boardPageStack } from '../../whiteboard/model/pages';
import { useNativeClipboard } from './useNativeClipboard';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import { createNativeAcquisitionOptions } from './nativeAcquisitionOptions';
import { useNativeBoardAcquisition } from './useNativeBoardAcquisition';
import { createNativeViewLease, type NativeViewLease } from './nativeViewLease';
import ViewerHost from './ViewerHost';
import NativeNotebookThumbnails from './NativeNotebookThumbnails';
import NativeMinimap, { type NativeMinimapThumbnail } from './NativeMinimap';
import { NativeCanvasEditing, type NativeEditingViewOptions, type NativeEditingRenderContext } from './NativeCanvasEditing';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import './NativeCanvasEntry.css';

const VIEW_REASON = 'This native canvas is currently available in read-only mode.';
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

function NativeViewer({ props, identity, board, onError }: {
    props: NativeCanvasEntryProps; identity: NativeCanvasIdentity; board: ComposedBoardSession; onError(error: unknown): void;
}) {
    const latest = useRef(props);
    useLayoutEffect(() => { latest.current = props; }, [props]);
    const [inverted, setInverted] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [lease, setLease] = useState<NativeViewLease | null>(null);
    const { nativeCanvasHost, zoomLimits: { min, max }, insets: { left, right, top, bottom } } = props;
    useEffect(() => {
        let view: NativeViewLease;
        try {
            const current = latest.current;
            view = createNativeViewLease({ host: nativeCanvasHost, identity, board,
                parameters: { mode: 'view', visible: current.isVisible, focused: current.isFocused, theme: current.theme, inverted: false },
                limits: { min, max }, insets: { left, right, top, bottom }, onError, onNotice: setNotice });
        } catch (error) { onError(error); return; }
        setLease(view);
        return () => { setLease(previous => previous === view ? null : previous); view.dispose(); };
    }, [board, identity, nativeCanvasHost, min, max, left, right, top, bottom, onError]);
    if (!lease) return <div role="status">Preparing canvas view…</div>;
    return <AttachedViewer props={props} identity={identity} lease={lease} inverted={inverted} setInverted={setInverted} notice={notice} setNotice={setNotice} />;
}

export interface NativeEditingChromeContext {
    readonly minimapOpen: boolean;
    readonly setMinimapOpen: (value: boolean) => void;
    readonly inverted: boolean;
    readonly setInverted: (value: boolean) => void;
    readonly zoom: number;
}
export function AttachedViewer({ props, identity, lease, inverted, setInverted, notice, setNotice, editingChrome, editingWritable }: {
    props: NativeCanvasEntryProps; identity: NativeCanvasIdentity; lease: NativeViewLease; inverted: boolean;
    setInverted(value: boolean): void; notice: string | null; setNotice(message: string): void;
    editingChrome?: (context: NativeEditingChromeContext) => ReactNode;
    editingWritable?: boolean;
}) {
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
    const capturePng = useCallback((rect: Parameters<NativeViewLease['captureBlob']>[0], maxSide: number, signal: AbortSignal) =>
        lease.captureBlob(rect, maxSide, signal), [lease]);
    const jump = useCallback((page: number) => lease.jump(page), [lease]);
    const stack = board.doc.kind === 'notebook' ? boardPageStack(board.doc.host) : undefined;
    const [minimapOpen, setMinimapOpen] = useState(false);
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
    const navigateMinimap = useCallback((centre: { x: number; y: number }) => {
        if (!minimapCurrent()) return;
        const camera = lease.camera.camera, viewport = lease.camera.viewport;
        lease.camera.setCamera({ x: centre.x - viewport.width / (2 * camera.z), y: centre.y - viewport.height / (2 * camera.z), z: camera.z });
        lease.changed();
    }, [lease, minimapCurrent]);
    const { onFocusPane, registerKeyboardTarget } = props;
    const path = props.file.path;
    const onFocus = useCallback(() => onFocusPane(path), [onFocusPane, path]);
    const register = useCallback((focus: () => void) => registerKeyboardTarget(path, focus), [registerKeyboardTarget, path]);
    const sheets = board.doc.sheetOrder;
    const currentTheme = useRef(props.theme);
    useLayoutEffect(() => { currentTheme.current = props.theme; }, [props.theme]);
    const readTheme = useCallback(() => currentTheme.current, []);
    const viewer = useNativeClipboard(lease, props.nativeCanvasHost, identity, readTheme, setNotice);
    return <ViewerHost name={props.file.name} documentId={props.documentId} vaultEpoch={props.identity.vaultActivation}
        isVisible={props.isVisible} isFocused={props.isFocused} theme={props.theme} inverted={inverted}
        view={editingChrome ? lease.view : viewer} layers={view.layers} platform={view.platform} readiness={view.readiness} paint={view.paint} reason={view.reason ?? (editingChrome ? '' : VIEW_REASON)}
        readOnly={editingChrome ? board.isReadOnly || !editingWritable : true} externalAccessibility={!!editingChrome}
        readOnlyNotice={editingChrome ? (board.readOnlyReason ?? VIEW_REASON) : VIEW_REASON} registerKeyboardTarget={register} onFocus={onFocus}
        chrome={<>{editingChrome ? editingChrome({ minimapOpen, setMinimapOpen, inverted, setInverted, zoom: navigation.zoom }) : <div className="native-canvas-navigation" role="toolbar" aria-label="Canvas navigation">
            {sheets.length > 1 && <label>Sheet <select value={selected.sheet} onChange={event => {
                const sheet = sheets.find(item => item.id === event.currentTarget.value);
                if (sheet) selection.setSheet(sheet.id);
            }}>{sheets.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}</select></label>}
            {board.doc.kind === 'notebook' && board.doc.host.kind === 'notebook' && <label>Page <input type="number" min={1}
                max={board.doc.host.paper.pageCount} value={navigation.page + 1} onChange={event => {
                    const page = event.currentTarget.valueAsNumber;
                    if (Number.isFinite(page)) lease.jump(Math.max(0, Math.min(board.doc.host.kind === 'notebook' ? board.doc.host.paper.pageCount - 1 : 0, Math.floor(page) - 1)));
                }} /> / {board.doc.host.paper.pageCount}</label>}
            <button type="button" onClick={() => lease.zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
            <span>{Math.round(navigation.zoom * 100)}%</span>
            <button type="button" onClick={() => lease.zoomBy(1.2)} aria-label="Zoom in">+</button>
            <button type="button" aria-pressed={inverted} onClick={() => setInverted(!inverted)}>Invert</button>
            {board.doc.kind === 'whiteboard' && <button type="button" aria-pressed={minimapOpen} onClick={() => setMinimapOpen(!minimapOpen)}>Minimap</button>}
            {stack && <NativeNotebookThumbnails pages={stack.rects} revision={revision} page={navigation.page} isVisible={props.isVisible}
                current={current} currentRevision={getRevision} capturePng={capturePng} jump={jump} onError={reportThumbnailError} />}
            {notice && <span role="status">{notice}</span>}
        </div>}
        {editingChrome && notice && <span role="status">{notice}</span>}
        {board.doc.kind === 'whiteboard' && <NativeMinimap thumbnail={thumbnail?.key === thumbnailKey ? thumbnail : null} currentCamera={cameraState.camera} viewport={cameraState.viewport}
            isVisible={props.isVisible && minimapOpen} currentOwner={minimapCurrent} onNavigate={navigateMinimap} onFocus={onFocus} />}
        {minimapOpen && minimapNotice && <div className="board-viewer-notice" role="status">{minimapNotice}</div>}</>} />;
}

function NativeDrawingEditing({ props, board, adapter, onError, onUnavailable }: {
    readonly props: NativeCanvasEntryProps; readonly board: ComposedBoardSession;
    readonly adapter: HostedBoardAdapter<BoardSessionPort>; readonly onError: (error: unknown) => void;
    readonly onUnavailable: (error: unknown) => void;
}) {
    const latest = useRef(props); useLayoutEffect(() => { latest.current = props; }, [props]);
    const { identity, nativeCanvasHost: host, zoomLimits: { min, max }, insets: { left, right, top, bottom } } = props;
    const createLease = useCallback(async (editing: NativeEditingViewOptions, signal: AbortSignal, notice: (message: string) => void) => {
        signal.throwIfAborted(); const now = latest.current;
        return createNativeViewLease({ host, identity, board, parameters: { mode: 'edit', visible: now.isVisible,
            focused: now.isFocused, theme: now.theme, inverted: false }, limits: { min, max }, insets: { left, right, top, bottom },
            editing, onError, onNotice: notice });
    }, [host, identity, board, min, max, left, right, top, bottom, onError]);
    const renderView = useCallback((context: NativeEditingRenderContext) => <AttachedViewer props={props} identity={identity}
        lease={context.lease} inverted={context.inverted} setInverted={context.setInverted} notice={context.notice}
        setNotice={context.setNotice} editingChrome={context.chrome} editingWritable={context.editable} />, [props, identity]);
    return <NativeCanvasEditing props={props} board={board} adapter={adapter} factory={host.createEditingCapabilities}
        createLease={createLease} renderView={renderView} onError={onError} onUnavailable={onUnavailable} />;
}

export default function NativeCanvasEntry(props: NativeCanvasEntryProps) {
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
            onError, onHistoryLimit: () => setError('The board history limit was reached.') });
    }, [identity, documentId, nativeCanvasHost, deadlineMs, zMax, onError]);
    const acquisition = useMemo(() => createNativeAcquisitionOptions<ComposedBoardSession>({ host: nativeCanvasHost,
        identity, attachCanvasSession: attach, onNativeCanvasReady: ready, prepare, onError,
        emergencyReadOnly: emergencyPolicy, emergencyReadOnlyReason: VIEW_REASON,
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
    if (identity.documentId !== incoming.documentId || identity.session !== incoming.session
        || identity.vaultActivation !== incoming.vaultActivation || identity.bytesGeneration !== incoming.bytesGeneration
        || identity.kind !== incoming.kind) return <div role="status">Preparing canvas…</div>;
    if (error) return <div role="alert">Could not open canvas: {error}</div>;
    if (!acquired) return <div role="status">Preparing canvas…</div>;
    if (emergencyReadOnly || (editingFailure?.documentId === identity.documentId && editingFailure.session === identity.session)) {
        return <><NativeViewer props={props} identity={identity} board={acquired.adapter.board} onError={onError} />
            {editingFailure && <div role="status">Editing unavailable: {editingFailure.reason}</div>}</>;
    }
    return <NativeDrawingEditing props={{ ...props, identity }} board={acquired.adapter.board} adapter={acquired.adapter}
        onError={onError} onUnavailable={editingUnavailable} />;
}
