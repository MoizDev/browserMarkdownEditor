import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewportInsets, ZoomLimits } from '../../platform/render/camera';
import type { ActiveFile, Theme } from '../../types';
import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { getPdfInkSourceState, type PdfInkSourceState } from '../../whiteboard/host/preparePdfInkSession';
import { mediaExtension } from '../../whiteboard/media/ingest';
import { MEDIA_MIMES, type MediaId } from '../../whiteboard/model/media';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import { createNativeViewLease, type NativeViewLease } from './nativeViewLease';
import ViewerHost from './ViewerHost';
import './NativeCanvasEntry.css';

const VIEW_REASON = 'PDF annotation tools are unavailable in this view.';

export interface NativePdfViewerProps {
    readonly board: ComposedBoardSession;
    readonly identity: NativeCanvasIdentity;
    readonly host: NativeCanvasHost;
    readonly file: ActiveFile;
    readonly isVisible: boolean;
    readonly isFocused: boolean;
    readonly theme: Theme;
    readonly emphasisEnabled: boolean;
    readonly zoomLimits: ZoomLimits;
    readonly insets: ViewportInsets;
    readonly registerKeyboardTarget: (path: string, focus: () => void) => () => void;
    readonly onFocusPane: (path: string) => void;
    readonly onNotice: (message: string) => void;
    readonly onError: (error: unknown) => void;
}

function PdfView({ props, sourceState }: { props: NativePdfViewerProps; sourceState: PdfInkSourceState }) {
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
    const readPdfMedia = useCallback(async (id: MediaId, signal: AbortSignal) => {
        const entry = board.doc.media.get(id);
        const mime = MEDIA_MIMES.find(value => value === entry?.mime);
        if (!entry || entry.file !== null || !mime || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`Invalid embedded PDF media: ${id}`);
        return sourceState.getSnapshot().source.readMedia(`board-media/${id.slice(7)}.${mediaExtension(mime)}`, signal);
    }, [board, sourceState]);
    useEffect(() => {
        let alive = true, view: NativeViewLease | undefined;
        const abort = new AbortController();
        setLoading(true); setError(null);
        void (async () => {
            while (alive) {
                const source = sourceState.getSnapshot().source, generation = ++sequence.current;
                try {
                    const backdrop = await source.createBackdrop({ readOnly: true,
                        isVisible: () => alive && latest.current.isVisible,
                        isFocused: () => alive && latest.current.isVisible && latest.current.isFocused,
                        emphasisEnabled: () => latest.current.emphasisEnabled,
                        onError: report, onUpdating: value => { if (alive && sequence.current === generation) setUpdating(value); }, signal: abort.signal });
                    if (!alive || abort.signal.aborted) { backdrop.dispose(); return; }
                    if (sourceState.getSnapshot().source !== source) { backdrop.dispose(); continue; }
                    const current = latest.current;
                    try {
                        view = createNativeViewLease({ board, host, identity: current.identity, pdfBackdrop: backdrop, readPdfMedia,
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
        })();
        return () => { alive = false; abort.abort(); installed.current = null;
            if (view) { setLease(previous => previous === view ? null : previous); view.dispose(); } };
    }, [board, host, documentId, session, vaultActivation, bytesGeneration, min, max, left, right, top, bottom, sourceState, readPdfMedia, report]);
    useEffect(() => {
        const source = sourceSnapshot.source;
        if (!lease || installed.current === source) return;
        let alive = true, adopted = false;
        const abort = new AbortController(), generation = ++sequence.current;
        setLoading(true); setUpdating(false); setError(null);
        void source.createBackdrop({ readOnly: true,
            isVisible: () => alive && latest.current.isVisible,
            isFocused: () => alive && latest.current.isVisible && latest.current.isFocused,
            emphasisEnabled: () => latest.current.emphasisEnabled,
            onError: report, onUpdating: value => { if (alive && sequence.current === generation) setUpdating(value); }, signal: abort.signal,
        }).then(backdrop => {
            if (!alive || abort.signal.aborted || sourceState.getSnapshot().source !== source || !host.isCurrent(latest.current.identity)) { backdrop.dispose(); return; }
            try { lease.replaceBackdrop(backdrop); adopted = true; installed.current = source; setLoading(false); }
            catch (cause) { backdrop.dispose(); report(cause); }
        }, cause => { if (alive && !abort.signal.aborted) report(cause); });
        return () => { alive = false; if (!adopted) abort.abort(); };
    }, [lease, sourceSnapshot.source, sourceState, host, report]);
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
    const view = useSyncExternalStore(lease.subscribe, lease.getSnapshot, lease.getSnapshot);
    const navigation = useSyncExternalStore(lease.subscribe, lease.getNavigationSnapshot, lease.getNavigationSnapshot);
    const pages = lease.runtime.session.doc.host.kind === 'pdf-ink' ? lease.runtime.session.doc.host.pages.length : 0;
    return <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <ViewerHost name={props.file.name} documentId={props.identity.documentId} vaultEpoch={props.identity.vaultActivation}
            isVisible={props.isVisible} isFocused={props.isFocused} theme={props.theme} inverted={inverted}
            view={lease.view} layers={view.layers} platform={view.platform} reason={view.reason ?? VIEW_REASON}
            readOnly readOnlyNotice={VIEW_REASON} registerKeyboardTarget={register} onFocus={onFocus}
            chrome={<div className="native-canvas-navigation" role="toolbar" aria-label="PDF navigation">
                <label>Page <input type="number" min={1} max={pages} value={navigation.page + 1} onChange={event => {
                    const page = event.currentTarget.valueAsNumber;
                    if (Number.isFinite(page) && pages) lease.jump(Math.max(0, Math.min(pages - 1, Math.floor(page) - 1)));
                }} /> / {pages}</label>
                <button type="button" onClick={() => lease.zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
                <span>{Math.round(navigation.zoom * 100)}%</span>
                <button type="button" onClick={() => lease.zoomBy(1.2)} aria-label="Zoom in">+</button>
                <button type="button" aria-pressed={inverted} onClick={() => setInverted(!inverted)}>Invert</button>
            </div>} />
        {cover && <div className="native-pdf-updating" role={reason ? 'alert' : 'status'} style={{ position: 'absolute', inset: 0,
            zIndex: 10, display: 'grid', placeItems: 'center', background: props.theme === 'dark' ? '#181818' : '#fff',
            color: props.theme === 'dark' ? '#fff' : '#111' }}>{reason ?? 'Updating PDF view…'}</div>}
    </div>;
}

export default function NativePdfViewer(props: NativePdfViewerProps) {
    const sourceState = getPdfInkSourceState(props.identity.documentId);
    if (!sourceState || props.identity.kind !== 'pdfInk') return <div role="alert">The PDF ink source is unavailable.</div>;
    return <PdfView props={props} sourceState={sourceState} />;
}
