import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPdfInkHost, pinPdfInkHostForSave, readPdfInkLegacyDigest, rebindPdfInkSource, validateLoadedPdfInkHost } from '../../pdf/session/inkHost';
import { prepareOwnedPdfInk } from '../../pdf/session/ownedInkAcquisition';
import { getPdfInkSourceState, preparePdfInkSession } from '../../whiteboard/host/preparePdfInkSession';
import { prepareLegacyPdfInkSession } from '../../whiteboard/host/prepareLegacyPdfInkSession';
import type { ComposedBoardSession } from '../../whiteboard/session/factoryTypes';
import type { NativeCanvasEntryProps } from './NativeCanvasEntry';
import { createNativeAcquisitionOptions } from './nativeAcquisitionOptions';
import { useNativeBoardAcquisition } from './useNativeBoardAcquisition';
import NativePdfViewer from './NativePdfViewer';

const VIEW_REASON = 'PDF annotation tools are unavailable in this view.';
export interface NativePdfEntryProps extends NativeCanvasEntryProps {
    /** Only an explicit legacy-conversion route may set this. */
    readonly legacyConversion?: boolean;
    readonly onLegacyConversionRefused?: (message: string) => void;
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
    const onError = useCallback((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        // Once the session owns a PDF source, rebind/view errors belong to
        // that mounted view; dropping it would also drop its camera and cover.
        if (getPdfInkSourceState(documentId)) { latest.current.onNotice(message); return; }
        if (latest.current.legacyConversion && latest.current.onLegacyConversionRefused) {
            latest.current.onLegacyConversionRefused(message); return;
        }
        setError(message);
    }, [documentId]);
    // This view wrapper stays inline on purpose. Its prepare feeds a render-time useMemo, and React Compiler
    // reports "Cannot access refs during render" when that prepare calls any imported preparer. App's cold
    // path (preparePdfInkAttempt) calls the SAME canonical preparePdfInkSession from an async job instead.
    const prepare = useCallback(async (signal: AbortSignal) => {
        if (identity.documentId !== documentId || identity.kind !== 'pdfInk') throw new Error('PDF identity does not match this entry');
        const create = props.legacyConversion ? prepareLegacyPdfInkSession : preparePdfInkSession;
        const result = await create({ host: nativeCanvasHost, identity, signal, deadlineMs, zMax,
            prepareOwned: prepareOwnedPdfInk, createHost: createPdfInkHost, validateLoadedHost: validateLoadedPdfInkHost,
            readLegacyDigest: readPdfInkLegacyDigest, pinHost: pinPdfInkHostForSave, rebind: rebindPdfInkSource,
            // The acquisition adapter owns the temporary viewing seal. Source,
            // emergency and C5/D10 restrictions remain independent of that seal.
            currentReadOnly: () => null, onReadOnly: reason => latest.current.onNotice(reason), onError,
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
    }, [identity, documentId, nativeCanvasHost, deadlineMs, zMax, onError, props.legacyConversion]);
    const emergencyReadOnly = props.emergencyReadOnly;
    const emergencyPolicy = useCallback(() => emergencyReadOnly, [emergencyReadOnly]);
    const acquisition = useMemo(() => createNativeAcquisitionOptions<ComposedBoardSession>({ host: nativeCanvasHost,
        identity, attachCanvasSession, onNativeCanvasReady, prepare, onError,
        emergencyReadOnly: emergencyPolicy, emergencyReadOnlyReason: VIEW_REASON,
    }), [nativeCanvasHost, identity, attachCanvasSession, onNativeCanvasReady, prepare, onError, emergencyPolicy]);
    const acquired = useNativeBoardAcquisition(acquisition);
    const source = acquired ? getPdfInkSourceState(documentId) : undefined;
    if (error || acquired && !source) {
        return <div role="alert">{error ?? 'The PDF ink source is unavailable.'}
            <button type="button" onClick={props.onViewOriginal}>Back to view</button></div>;
    }
    if (!acquired || !source) return <div role="status">Preparing PDF annotations…</div>;
    return <NativePdfViewer adapter={acquired.adapter} board={acquired.adapter.board} identity={identity} host={nativeCanvasHost} sourceState={source}
        file={props.file} isVisible={props.isVisible} isFocused={props.isFocused} theme={props.theme}
        emphasisEnabled={props.emphasisEnabled} zoomLimits={props.zoomLimits} insets={props.insets}
        registerKeyboardTarget={props.registerKeyboardTarget} onFocusPane={props.onFocusPane} onNotice={props.onNotice} onError={onError} />;
}
