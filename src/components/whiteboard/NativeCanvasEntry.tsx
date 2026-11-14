import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewportInsets, ZoomLimits } from '../../platform/render/camera';
import type { ActiveFile, Theme } from '../../types';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { NativeCanvasReady } from '../../types/reading';
import type { AttachCanvasSession } from '../../utils/canvasSessionBridge';
import { pdfEngineAvailableInBuild } from '../../utils/pdfEngineAvailability';
import { prepareNativeRuntime } from '../../whiteboard/host/prepareNativeRuntime';
import { registerNativeNotebookExporter } from '../../whiteboard/host/registerNativeNotebookExporter';
import { boardPageStack } from '../../whiteboard/model/pages';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import { createNativeAcquisitionOptions } from './nativeAcquisitionOptions';
import { useNativeBoardAcquisition } from './useNativeBoardAcquisition';
import { createNativeViewLease, type NativeViewLease } from './nativeViewLease';
import ViewerHost from './ViewerHost';
import NativeNotebookThumbnails from './NativeNotebookThumbnails';
import './NativeCanvasEntry.css';

const VIEW_REASON = 'This native canvas is currently available in read-only mode.';
const reportThumbnailError = (error: unknown) => { console.error('Notebook thumbnail unavailable:', error); };

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
    return <AttachedViewer props={props} identity={identity} lease={lease} inverted={inverted} setInverted={setInverted} notice={notice} />;
}

function AttachedViewer({ props, identity, lease, inverted, setInverted, notice }: {
    props: NativeCanvasEntryProps; identity: NativeCanvasIdentity; lease: NativeViewLease; inverted: boolean;
    setInverted(value: boolean): void; notice: string | null;
}) {
    const view = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
    const navigation = useSyncExternalStore(lease.subscribe, lease.getNavigationSnapshot, lease.getNavigationSnapshot);
    const selection = lease.runtime.selection;
    const selected = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
    const board = lease.runtime.session;
    const subscribeRevision = useCallback((listener: () => void) => board.subscribe(listener), [board]);
    const getRevision = useCallback(() => board.doc.rev, [board]);
    const revision = useSyncExternalStore(subscribeRevision, getRevision, getRevision);
    const current = useCallback(() => props.nativeCanvasHost.isCurrent(identity), [props.nativeCanvasHost, identity]);
    const capturePng = useCallback((rect: Parameters<NativeViewLease['captureBlob']>[0], maxSide: number, signal: AbortSignal) =>
        lease.captureBlob(rect, maxSide, signal), [lease]);
    const jump = useCallback((page: number) => lease.jump(page), [lease]);
    const stack = board.doc.kind === 'notebook' ? boardPageStack(board.doc.host) : undefined;
    const { onFocusPane, registerKeyboardTarget } = props;
    const path = props.file.path;
    const onFocus = useCallback(() => onFocusPane(path), [onFocusPane, path]);
    const register = useCallback((focus: () => void) => registerKeyboardTarget(path, focus), [registerKeyboardTarget, path]);
    const sheets = board.doc.sheetOrder;
    return <ViewerHost name={props.file.name} documentId={props.documentId} vaultEpoch={props.identity.vaultActivation}
        isVisible={props.isVisible} isFocused={props.isFocused} theme={props.theme} inverted={inverted}
        view={lease.view} layers={view.layers} platform={view.platform} reason={view.reason ?? VIEW_REASON}
        readOnly readOnlyNotice={VIEW_REASON} registerKeyboardTarget={register} onFocus={onFocus}
        chrome={<div className="native-canvas-navigation" role="toolbar" aria-label="Canvas navigation">
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
            {stack && <NativeNotebookThumbnails pages={stack.rects} revision={revision} page={navigation.page} isVisible={props.isVisible}
                current={current} currentRevision={getRevision} capturePng={capturePng} jump={jump} onError={reportThumbnailError} />}
            {notice && <span role="status">{notice}</span>}
        </div>} />;
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
    const onError = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
    const prepare = useCallback((signal: AbortSignal) => {
        if (identity.documentId !== documentId || identity.kind === 'pdfInk') throw new Error('Canvas identity does not match this entry');
        return prepareNativeRuntime({ host: nativeCanvasHost, identity, representation: identity.kind, signal,
            deadlineMs, zMax, readOnlyReason: VIEW_REASON,
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
            registerNativeNotebookExporter({ board, host: nativeCanvasHost, identity, onError,
                writer: revision => {
                    const native = pdfEngineAvailableInBuild();
                    let build: ReturnType<typeof import('../../pdf/writing/notebookClient').createNativeNotebookPdfBuild> | undefined;
                    let classic: Promise<Uint8Array> | undefined;
                    return async (input, options) => {
                        // P1-ship is owner-supplied: a build with no PDF engine still
                        // exports generated pages through the existing display writer.
                        // An eligible native engine failing integrity never takes this path.
                        if (!native) {
                            options.signal?.throwIfAborted();
                            const pending = classic ??= import('../../pdf/writing/client').then(module => {
                                options.signal?.throwIfAborted();
                                return module.buildDisplayPdf(input, options);
                            });
                            try { return await pending; }
                            catch (cause) { if (classic === pending) classic = undefined; throw cause; }
                        }
                        if (!build) {
                            const { createNativeNotebookPdfBuild } = await import('../../pdf/writing/notebookClient');
                            options.signal?.throwIfAborted();
                            build ??= createNativeNotebookPdfBuild(input, { revision });
                        }
                        return build.run(options.signal);
                    };
                } });
        } catch (cause) { onError(cause); }
    }, [acquired, identity, nativeCanvasHost, onError]);
    if (identity.documentId !== incoming.documentId || identity.session !== incoming.session
        || identity.vaultActivation !== incoming.vaultActivation || identity.bytesGeneration !== incoming.bytesGeneration
        || identity.kind !== incoming.kind) return <div role="status">Preparing canvas…</div>;
    if (error) return <div role="alert">Could not open canvas: {error}</div>;
    if (!acquired) return <div role="status">Preparing canvas…</div>;
    if (!acquired.adapter.board.isReadOnly) return <div role="alert">This canvas cannot be opened safely in read-only mode.</div>;
    return <NativeViewer props={props} identity={identity} board={acquired.adapter.board} onError={onError} />;
}
