import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ActiveFile, Theme } from '../../types';
import { createNativeViewLease, type NativePdfBackdrop, type NativeViewLease } from './nativeViewLease';
import type { HostedBoardAdapter } from './boardSessionAdapter';
import { NativeCanvasEditing, type NativeEditingRenderContext, type NativeEditingViewOptions } from './NativeCanvasEditing';
import { createNativePdfEditingLease } from './nativePdfEditingLease';
import ViewerHost from './ViewerHost';
import { useNativeClipboard } from './useNativeClipboard';
import './NativeCanvasEntry.css';

const VIEW_REASON = 'PDF annotation tools are unavailable in this view.';
type ViewOptions = Parameters<typeof createNativeViewLease>[0];
type PdfMediaReader = NonNullable<ViewOptions['readPdfMedia']>;

export interface NativePdfViewerSource {
    getSnapshot(): {
        readonly source: { readonly source: { readonly token: Readonly<{ documentId: string; session: number; vaultEpoch: number; bytesGeneration: number }> }; isCurrent(): boolean; createBackdrop(options: {
            readOnly: boolean; isVisible(): boolean; isFocused(): boolean; emphasisEnabled(): boolean;
            onError(error: unknown): void; onUpdating?(updating: boolean): void; signal?: AbortSignal;
        }): Promise<Omit<NativePdfBackdrop, 'assertCaptureCurrent' | 'sourceToken' | 'isCurrentSource'>> };
        readonly status: 'ready' | 'rebinding' | 'read-only' | 'failed';
        readonly reason?: string;
    };
    subscribe(listener: () => void): () => void;
    readMedia: PdfMediaReader;
}

async function waitWhilePdfRebinding(sourceState: NativePdfViewerSource, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (sourceState.getSnapshot().status !== 'rebinding') return;
    await new Promise<void>((resolve, reject) => {
        let stop = () => {};
        const finish = () => { stop(); signal.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => { stop(); signal.removeEventListener('abort', cancel); reject(signal.reason); };
        stop = sourceState.subscribe(() => { if (sourceState.getSnapshot().status !== 'rebinding') finish(); });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel(); else if (sourceState.getSnapshot().status !== 'rebinding') finish();
    });
}

export interface NativePdfViewerProps {
    readonly board: ViewOptions['board'];
    readonly adapter: HostedBoardAdapter<ViewOptions['board']>;
    readonly identity: ViewOptions['identity'];
    readonly host: ViewOptions['host'];
    readonly sourceState: NativePdfViewerSource;
    readonly file: ActiveFile;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly theme: Theme;
    readonly emphasisEnabled: boolean;
    readonly zoomLimits: ViewOptions['limits'];
    readonly insets: ViewOptions['insets'];
    readonly registerKeyboardTarget: (path: string, focus: () => void) => () => void;
    readonly onFocusPane: (path: string) => void;
    readonly onNotice: (message: string) => void;
    readonly onError: (error: unknown) => void;
}

function PdfView({ props, sourceState }: { props: NativePdfViewerProps; sourceState: NativePdfViewerSource }) {
    const sourceSnapshot = useSyncExternalStore(sourceState.subscribe, sourceState.getSnapshot, sourceState.getSnapshot);
    const latest = useRef(props);
    useLayoutEffect(() => { latest.current = props; }, [props]);
    const [lease, setLease] = useState<NativeViewLease | null>(null);
    const [loading, setLoading] = useState(true), [updating, setUpdating] = useState(false);
    const [error, setError] = useState<string | null>(null), [inverted, setInverted] = useState(false);
    const installed = useRef<typeof sourceSnapshot.source | null>(null), sequence = useRef(0);
    const { board, host, identity, zoomLimits: { min, max }, insets: { left, right, top, bottom } } = props;
    const { documentId, session, vaultActivation, bytesGeneration } = identity;
    const report = useCallback((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        latest.current.onError(cause);
    }, []);
    const readPdfMedia = useCallback<PdfMediaReader>((id, signal) => sourceState.readMedia(id, signal), [sourceState]);
    const currentSource = useCallback((source: ReturnType<NativePdfViewerSource['getSnapshot']>['source']) => {
        const state = sourceState.getSnapshot(), outer = host.outerIdentity(documentId), token = source.source.token;
        return state.status === 'ready' && state.source === source && source.isCurrent() && host.isCurrent(latest.current.identity)
            && !!outer && host.isCurrent(outer) && outer.documentId === token.documentId && outer.session === token.session
            && outer.vaultActivation === token.vaultEpoch && outer.bytesGeneration === token.bytesGeneration;
    }, [sourceState, host, documentId]);
    useEffect(() => {
        let alive = true, view: NativeViewLease | undefined;
        const abort = new AbortController();
        setLoading(true); setError(null);
        void (async () => {
            while (alive) {
                await waitWhilePdfRebinding(sourceState, abort.signal);
                if (!alive || abort.signal.aborted) return;
                const state = sourceState.getSnapshot();
                if (state.status !== 'ready') { report(new Error(state.reason ?? 'The PDF source is unavailable.')); return; }
                const source = state.source, generation = ++sequence.current;
                try {
                    const backdrop = await source.createBackdrop({ readOnly: true,
                        isVisible: () => alive && latest.current.isVisible,
                        isFocused: () => alive && latest.current.isVisible && latest.current.isFocused,
                        emphasisEnabled: () => latest.current.emphasisEnabled,
                        onError: report, onUpdating: value => { if (alive && sequence.current === generation) setUpdating(value); }, signal: abort.signal });
                    if (!alive || abort.signal.aborted) { backdrop.dispose(); return; }
                    if (!currentSource(source)) {
                        backdrop.dispose();
                        if (sourceState.getSnapshot().source !== source || sourceState.getSnapshot().status === 'rebinding') continue;
                        throw new Error('The PDF backdrop no longer matches its source.');
                    }
                    const current = latest.current;
                    const paired: NativePdfBackdrop & { readonly sourceToken: typeof source.source.token; isCurrentSource(): boolean } = {
                        ...backdrop, sourceToken: source.source.token, isCurrentSource: () => currentSource(source),
                        assertCaptureCurrent() { if (!currentSource(source)) throw new Error('PDF backdrop source is updating'); },
                    };
                    try {
                        view = createNativeViewLease({ board, host, identity: current.identity, pdfBackdrop: paired, readPdfMedia,
                            parameters: { mode: 'view', visible: current.isVisible, focused: current.isFocused, theme: current.theme, inverted: false },
                            limits: { min, max }, insets: { left, right, top, bottom }, onError: report, onNotice: message => latest.current.onNotice(message) });
                    } catch (cause) { backdrop.dispose(); throw cause; }
                    installed.current = source; setLease(view); setLoading(false); return;
                } catch (cause) {
                    if (!alive || abort.signal.aborted) return;
                    if (sourceState.getSnapshot().source !== source) continue;
                    report(cause); return;
                }
            }
        })().catch(cause => { if (alive && !abort.signal.aborted) report(cause); });
        return () => { alive = false; abort.abort(); installed.current = null;
            if (view) { setLease(previous => previous === view ? null : previous); view.dispose(); } };
    }, [board, host, documentId, session, vaultActivation, bytesGeneration, min, max, left, right, top, bottom, sourceState, readPdfMedia, report, currentSource]);
    useEffect(() => {
        const source = sourceSnapshot.source;
        if (!lease || sourceSnapshot.status !== 'ready' || installed.current === source) return;
        let alive = true, adopted = false;
        const abort = new AbortController(), generation = ++sequence.current;
        setLoading(true); setUpdating(false); setError(null);
        void source.createBackdrop({ readOnly: true,
            isVisible: () => alive && latest.current.isVisible,
            isFocused: () => alive && latest.current.isVisible && latest.current.isFocused,
            emphasisEnabled: () => latest.current.emphasisEnabled,
            onError: report, onUpdating: value => { if (alive && sequence.current === generation) setUpdating(value); }, signal: abort.signal,
        }).then(backdrop => {
            if (!alive || abort.signal.aborted || !currentSource(source)) { backdrop.dispose(); return; }
            const paired: NativePdfBackdrop & { readonly sourceToken: typeof source.source.token; isCurrentSource(): boolean } = {
                ...backdrop, sourceToken: source.source.token, isCurrentSource: () => currentSource(source),
                assertCaptureCurrent() { if (!currentSource(source)) throw new Error('PDF backdrop source is updating'); },
            };
            try { lease.replaceBackdrop(paired); adopted = true; installed.current = source; setLoading(false); }
            catch (cause) { backdrop.dispose(); report(cause); }
        }, cause => { if (alive && !abort.signal.aborted) report(cause); });
        return () => { alive = false; if (!adopted) abort.abort(); };
    }, [lease, sourceSnapshot.source, sourceSnapshot.status, sourceState, host, report, currentSource]);
    useLayoutEffect(() => { lease?.refreshAuthority(); }, [lease, sourceSnapshot.status, sourceSnapshot.source]);
    useEffect(() => { lease?.changed(); }, [lease, props.emphasisEnabled]);
    const path = props.file.path, { onFocusPane, registerKeyboardTarget } = props;
    const onFocus = useCallback(() => onFocusPane(path), [onFocusPane, path]);
    const register = useCallback((focus: () => void) => registerKeyboardTarget(path, focus), [registerKeyboardTarget, path]);
    if (!lease) return <div role={error ? 'alert' : 'status'}>{error ?? 'Preparing PDF view…'}</div>;
    return <PdfAttached props={props} lease={lease} onFocus={onFocus} register={register} inverted={inverted} setInverted={setInverted}
        cover={loading || updating || sourceSnapshot.status !== 'ready'} reason={error ?? sourceSnapshot.reason} />;
}

function PdfAttached({ props, lease, onFocus, register, inverted, setInverted, cover, reason }: {
    props: NativePdfViewerProps; lease: NativeViewLease; onFocus(): void; register(focus: () => void): () => void;
    inverted: boolean; setInverted(value: boolean): void; cover: boolean; reason?: string | null;
}) {
    const latest = useRef(props);
    useLayoutEffect(() => { latest.current = props; }, [props]);
    const theme = useCallback(() => latest.current.theme, []);
    const notice = useCallback((message: string) => latest.current.onNotice(message), []);
    const viewer = useNativeClipboard(lease, props.host, props.identity, theme, notice);
    return <PdfAttachedFrame props={props} lease={lease} viewer={viewer} onFocus={onFocus} register={register}
        inverted={inverted} setInverted={setInverted} cover={cover} reason={reason} readOnly />;
}

function PdfAttachedFrame({ props, lease, viewer, onFocus, register, inverted, setInverted, cover, reason, readOnly, editingChrome, detach }: {
    props: NativePdfViewerProps; lease: NativeViewLease; viewer: NativeViewLease['view']; onFocus(): void; register(focus: () => void): () => void;
    inverted: boolean; setInverted(value: boolean): void; cover: boolean; reason?: string | null; readOnly: boolean; editingChrome?: ReactNode; detach?: boolean;
}) {
    const view = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
    const navigation = useSyncExternalStore(lease.subscribe, lease.getNavigationSnapshot, lease.getNavigationSnapshot);
    const pages = lease.runtime.session.doc.host.kind === 'pdf-ink' ? lease.runtime.session.doc.host.pages.length : 0;
    return <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {!detach && <ViewerHost name={props.file.name} documentId={props.identity.documentId} vaultEpoch={props.identity.vaultActivation}
            isVisible={props.isVisible} isFocused={props.isFocused} theme={props.theme} inverted={inverted}
            view={viewer} layers={view.layers} platform={view.platform} reason={view.reason ?? VIEW_REASON}
            readOnly={readOnly} externalAccessibility={editingChrome !== undefined} readOnlyNotice={VIEW_REASON} registerKeyboardTarget={register} onFocus={onFocus}
            chrome={<>{editingChrome}<div className="native-canvas-navigation" role="toolbar" aria-label="PDF navigation">
                <label>Page <input type="number" min={1} max={pages} value={navigation.page + 1} onChange={event => {
                    const page = event.currentTarget.valueAsNumber;
                    if (Number.isFinite(page) && pages) lease.jump(Math.max(0, Math.min(pages - 1, Math.floor(page) - 1)));
                }} /> / {pages}</label>
                <button type="button" onClick={() => lease.zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
                <span>{Math.round(navigation.zoom * 100)}%</span>
                <button type="button" onClick={() => lease.zoomBy(1.2)} aria-label="Zoom in">+</button>
                <button type="button" aria-pressed={inverted} onClick={() => setInverted(!inverted)}>Invert</button>
            </div></>} />}
        {cover && <div className="native-pdf-updating" role={reason ? 'alert' : 'status'} style={{ position: 'absolute', inset: 0,
            zIndex: 10, display: 'grid', placeItems: 'center', background: props.theme === 'dark' ? '#181818' : '#fff',
            color: props.theme === 'dark' ? '#fff' : '#111' }}>{reason ?? 'Updating PDF view…'}</div>}
    </div>;
}

function PdfEditingView({ props, onUnavailable }: { props: NativePdfViewerProps; onUnavailable(error: unknown): void }) {
    const latest = useRef(props);
    useLayoutEffect(() => { latest.current = props; }, [props]);
    const [updating, setUpdating] = useState(false), [viewGeneration, setViewGeneration] = useState(0);
    const [awaitingPresentation, setAwaitingPresentation] = useState(false);
    const handoff = useRef<ReturnType<NativeViewLease['takeCameraForRebind']> | null>(null);
    useEffect(() => () => { handoff.current?.dispose(); handoff.current = null; }, []);
    const createLease = useCallback(async (editing: NativeEditingViewOptions, signal: AbortSignal, notice: (message: string) => void) => {
        while (true) {
            const value = latest.current;
            await waitWhilePdfRebinding(value.sourceState, signal);
            signal.throwIfAborted();
            const before = value.sourceState.getSnapshot();
            if (before.status !== 'ready') throw new Error(before.reason ?? 'The PDF source is unavailable.');
            try {
                const capturedHandoff = handoff.current;
                const view = await createNativePdfEditingLease({ board: value.board, host: value.host, identity: value.identity,
                    sourceState: value.sourceState, editing, signal, ...(capturedHandoff ? { cameraHandoff: capturedHandoff } : {}),
                    limits: value.zoomLimits, insets: value.insets,
                    parameters: { visible: value.isVisible, focused: value.isFocused, theme: value.theme, inverted: false },
                    isVisible: () => latest.current.isVisible, isFocused: () => latest.current.isVisible && latest.current.isFocused,
                    emphasisEnabled: () => latest.current.emphasisEnabled, onUpdating: setUpdating,
                    onPresented: () => setAwaitingPresentation(false), onError: value.onError, onNotice: notice });
                if (handoff.current === capturedHandoff) handoff.current = null;
                return view;
            } catch (error) {
                signal.throwIfAborted();
                const after = value.sourceState.getSnapshot();
                if (after.status === 'rebinding' || after.source !== before.source) continue;
                throw error;
            }
        }
    }, []);
    const rebind = useCallback((lease: NativeViewLease, source: ReturnType<NativePdfViewerSource['getSnapshot']>['source']) => {
        const value = latest.current, state = value.sourceState.getSnapshot(), outer = value.host.outerIdentity(value.identity.documentId);
        const token = source.source.token, paint = lease.runtime.paintToken, old = lease.view.sourceToken;
        const same = (a: typeof token, b: typeof token) => a.documentId === b.documentId && a.session === b.session
            && a.vaultEpoch === b.vaultEpoch && a.bytesGeneration === b.bytesGeneration;
        if (handoff.current || !value.isVisible || state.status !== 'ready' || state.source !== source || !source.isCurrent()
            || !value.host.isCurrent(value.identity) || !value.host.canWriteSource(value.identity) || !outer || !value.host.isCurrent(outer)
            || outer.documentId !== token.documentId || outer.session !== token.session || outer.vaultActivation !== token.vaultEpoch
            || outer.bytesGeneration !== token.bytesGeneration || !same(paint, token) || !same(lease.runtime.paintBinding.token, token)
            || !old || same(old, token)) return;
        const captured = lease.takeCameraForRebind();
        handoff.current = captured;
        setAwaitingPresentation(true); setUpdating(false);
        setViewGeneration(generation => generation + 1);
    }, []);
    const editingUnavailable = useCallback((error: unknown) => {
        handoff.current?.dispose(); handoff.current = null;
        onUnavailable(error);
    }, [onUnavailable]);
    const renderView = useCallback((context: NativeEditingRenderContext) => <PdfEditingAttached props={latest.current}
        context={context} updating={updating || awaitingPresentation} rebind={rebind} />, [updating, awaitingPresentation, rebind]);
    return <NativeCanvasEditing key={viewGeneration} props={{ identity: props.identity, nativeCanvasHost: props.host, isVisible: props.isVisible,
        isFocused: props.isFocused, theme: props.theme }} board={props.board} adapter={props.adapter}
        factory={props.host.createEditingCapabilities} createLease={createLease} renderView={renderView}
        onError={props.onError} onUnavailable={editingUnavailable} />;
}

function PdfEditingAttached({ props, context, updating, rebind }: { props: NativePdfViewerProps; context: NativeEditingRenderContext;
    updating: boolean; rebind(lease: NativeViewLease, source: ReturnType<NativePdfViewerSource['getSnapshot']>['source']): void }) {
    const { lease } = context, source = useSyncExternalStore(props.sourceState.subscribe, props.sourceState.getSnapshot, props.sourceState.getSnapshot);
    const navigation = useSyncExternalStore(lease.subscribe, lease.getNavigationSnapshot, lease.getNavigationSnapshot);
    const [minimapOpen, setMinimapOpen] = useState(false);
    const token = lease.view.sourceToken, actual = source.source.source.token, outer = props.host.outerIdentity(props.identity.documentId);
    const paired = !!token && token.documentId === actual.documentId && token.session === actual.session
        && token.vaultEpoch === actual.vaultEpoch && token.bytesGeneration === actual.bytesGeneration
        && source.source.isCurrent() && props.host.isCurrent(props.identity) && !!outer && props.host.isCurrent(outer)
        && outer.documentId === actual.documentId && outer.session === actual.session
        && outer.vaultActivation === actual.vaultEpoch && outer.bytesGeneration === actual.bytesGeneration;
    const sourceAuthorized = props.host.canWriteSource(props.identity);
    const cover = updating || source.status !== 'ready' || !paired;
    useLayoutEffect(() => {
        lease.setInputPermitted(!cover && props.isVisible);
        if (cover) lease.editing?.cancelViewWork('pdf-source-updating');
        lease.refreshAuthority();
    }, [lease, cover, source, props.isVisible]);
    const { onError } = props;
    useEffect(() => {
        if (!paired && source.status === 'ready' && sourceAuthorized) {
            try { rebind(lease, source.source); }
            catch (error) { onError(error); }
        }
    }, [lease, paired, source, sourceAuthorized, rebind, onError]);
    const path = props.file.path, { onFocusPane, registerKeyboardTarget } = props;
    const onFocus = useCallback(() => onFocusPane(path), [onFocusPane, path]);
    const register = useCallback((focus: () => void) => registerKeyboardTarget(path, focus), [registerKeyboardTarget, path]);
    const chrome = context.chrome({ minimapOpen, setMinimapOpen, inverted: context.inverted,
        setInverted: context.setInverted, zoom: navigation.zoom });
    return <PdfAttachedFrame props={props} lease={lease} viewer={lease.view} onFocus={onFocus} register={register}
        inverted={context.inverted} setInverted={context.setInverted} cover={cover} reason={source.reason}
        readOnly={!context.editable} editingChrome={chrome} detach={!paired} />;
}

export default function NativePdfViewer(props: NativePdfViewerProps) {
    // This is the view route, not write authority; a rebind must not unmount
    // the editing view and discard its camera while its source is covered.
    const [openedAsEditing] = useState(() => props.identity.kind === 'pdfInk' && props.host.canWriteSource(props.identity)
        && typeof props.adapter.activateEditing === 'function');
    const [unavailable, setUnavailable] = useState(false), { onNotice } = props;
    const onUnavailable = useCallback((error: unknown) => {
        setUnavailable(true);
        if (!(error instanceof DOMException && error.name === 'AbortError')) onNotice(error instanceof Error ? error.message : String(error));
    }, [onNotice]);
    if (props.identity.kind !== 'pdfInk') return <div role="alert">The PDF ink source is unavailable.</div>;
    if (!unavailable && openedAsEditing) {
        return <PdfEditingView props={props} onUnavailable={onUnavailable} />;
    }
    return <PdfView props={props} sourceState={props.sourceState} />;
}
