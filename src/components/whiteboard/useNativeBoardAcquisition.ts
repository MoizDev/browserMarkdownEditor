import { useEffect, useRef, useState } from 'react';
import type { BoardSessionPort } from './boardSessionAdapter';
import { ensureNativeBoard } from './acquireNativeBoard';
import type { AcquiredNativeBoard, NativeBoardAcquisitionOptions } from './nativeBoardAcquisitionTypes';

/** The bridge owns the board; a pane cancels only its own acquisition wait. */
export function useNativeBoardAcquisition<S extends BoardSessionPort>(
    options: NativeBoardAcquisitionOptions<S>,
): AcquiredNativeBoard<S> | null {
    const error = useRef(options.onError);
    useEffect(() => { error.current = options.onError; });
    const [entry, setEntry] = useState<{ documentId: string; vaultActivation: number; bytesGeneration: number;
        kind: NativeBoardAcquisitionOptions<S>['kind']; value: AcquiredNativeBoard<S> } | null>(null);
    const { documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady,
        emergencyReadOnlyReason, prepare, existing, acceptConvertedSource, currentOwner, editingAuthorized } = options;
    useEffect(() => {
        const abort = new AbortController();
        let alive = true;
        void ensureNativeBoard({ documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady,
            emergencyReadOnlyReason, prepare, existing, acceptConvertedSource, currentOwner, editingAuthorized, onError: cause => error.current(cause) }, abort.signal)
            .then(value => { if (alive) setEntry({ documentId, vaultActivation, bytesGeneration, kind, value }); })
            .catch(cause => { if (alive && !abort.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) error.current(cause); });
        return () => { alive = false; abort.abort(); };
    }, [documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady,
        emergencyReadOnlyReason, prepare, existing, acceptConvertedSource, currentOwner, editingAuthorized]);
    return entry && entry.documentId === documentId && entry.vaultActivation === vaultActivation
        && entry.bytesGeneration === bytesGeneration && entry.kind === kind ? entry.value : null;
}
