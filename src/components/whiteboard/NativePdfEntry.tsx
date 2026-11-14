import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPdfInkHost, pinPdfInkHostForSave, readPdfInkLegacyDigest, rebindPdfInkSource, validateLoadedPdfInkHost } from '../../pdf/session/inkHost';
import { prepareOwnedPdfInk } from '../../pdf/session/ownedInkAcquisition';
import { getPdfInkSourceState, preparePdfInkSession } from '../../whiteboard/host/preparePdfInkSession';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import type { NativeCanvasEntryProps } from './NativeCanvasEntry';
import { createNativeAcquisitionOptions } from './nativeAcquisitionOptions';
import { useNativeBoardAcquisition } from './useNativeBoardAcquisition';
import NativePdfViewer from './NativePdfViewer';

const VIEW_REASON = 'PDF annotation tools are unavailable in this view.';
export interface NativePdfEntryProps extends NativeCanvasEntryProps {
    readonly emphasisEnabled: boolean;
    readonly onViewOriginal: () => void;
    readonly onNotice: (message: string) => void;
    readonly onOpenNotebookSource: (path: string) => void | Promise<void>;
}

/** Acquires the real document-owned PDF ink session; this host exposes viewing only. */
export default function NativePdfEntry(props: NativePdfEntryProps) {
    const latest = useRef(props);
    useLayoutEffect(() => { latest.current = props; }, [props]);
    const { identity: incoming, nativeCanvasHost, documentId, attachCanvasSession, onNativeCanvasReady, deadlineMs, zMax } = props;
    const { session, vaultActivation, bytesGeneration, kind, path, name } = incoming;
    const identity = useMemo(() => ({ documentId, session, vaultActivation, bytesGeneration, kind, path, name }),
        [documentId, session, vaultActivation, bytesGeneration, kind, path, name]);
    const [error, setError] = useState<string | null>(null);
    const onError = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
    const prepare = useCallback(async (signal: AbortSignal) => {
        if (identity.documentId !== documentId || identity.kind !== 'pdfInk') throw new Error('PDF identity does not match this entry');
        const result = await preparePdfInkSession({ host: nativeCanvasHost, identity, signal, deadlineMs, zMax,
            prepareOwned: prepareOwnedPdfInk, createHost: createPdfInkHost, validateLoadedHost: validateLoadedPdfInkHost,
            readLegacyDigest: readPdfInkLegacyDigest, pinHost: pinPdfInkHostForSave, rebind: rebindPdfInkSource,
            currentReadOnly: () => VIEW_REASON, onReadOnly: reason => setError(reason), onError,
            onHistoryLimit: () => setError('The board history limit was reached.') });
        if (result.kind === 'read-only') {
            try {
                signal.throwIfAborted();
                if (result.notebookSource && result.isCurrent?.() && latest.current.isVisible && latest.current.isFocused) {
                    await latest.current.onOpenNotebookSource(result.notebookSource.path);
                    signal.throwIfAborted();
                    if (!result.isCurrent() || !latest.current.isVisible || !latest.current.isFocused) {
                        throw new DOMException('PDF notebook handoff ended', 'AbortError');
                    }
                }
                throw new Error(result.reason);
            } finally { await result.dispose(); }
        }
        return result;
    }, [identity, documentId, nativeCanvasHost, deadlineMs, zMax, onError]);
    const emergencyReadOnly = props.emergencyReadOnly;
    const emergencyPolicy = useCallback(() => emergencyReadOnly, [emergencyReadOnly]);
    const acquisition = useMemo(() => createNativeAcquisitionOptions<ComposedBoardSession>({ host: nativeCanvasHost,
        identity, attachCanvasSession, onNativeCanvasReady, prepare, onError,
        emergencyReadOnly: emergencyPolicy, emergencyReadOnlyReason: VIEW_REASON,
    }), [nativeCanvasHost, identity, attachCanvasSession, onNativeCanvasReady, prepare, onError, emergencyPolicy]);
    const acquired = useNativeBoardAcquisition(acquisition);
    const source = acquired ? getPdfInkSourceState(documentId) : undefined;
    if (error || acquired && (!source || !acquired.adapter.board.isReadOnly)) {
        return <div role="alert">{error ?? 'This PDF cannot be opened safely in read-only mode.'}
            <button type="button" onClick={props.onViewOriginal}>Back to view</button></div>;
    }
    if (!acquired || !source) return <div role="status">Preparing PDF annotations…</div>;
    return <NativePdfViewer board={acquired.adapter.board} identity={identity} host={nativeCanvasHost} sourceState={source}
        file={props.file} isVisible={props.isVisible} isFocused={props.isFocused} theme={props.theme}
        emphasisEnabled={props.emphasisEnabled} zoomLimits={props.zoomLimits} insets={props.insets}
        registerKeyboardTarget={props.registerKeyboardTarget} onFocusPane={props.onFocusPane} onNotice={props.onNotice} onError={onError} />;
}
