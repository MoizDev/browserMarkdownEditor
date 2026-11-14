import { useEffect, useRef, useState } from 'react';
import { createBoardSessionAdapter } from './boardSessionAdapter';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';
import type { AcquiredNativeBoard, NativeBoardAcquisitionOptions, PreparedNativeBoard } from './nativeBoardAcquisitionTypes';

/** Acquisition precedes attachment; the App bridge admits one shared session and owns it
 * across panes. A hidden/unmounted pane cancels only its own unfinished acquisition. */
export function useNativeBoardAcquisition<S extends BoardSessionPort>(
    options: NativeBoardAcquisitionOptions<S>,
): AcquiredNativeBoard<S> | null {
    const error = useRef(options.onError);
    useEffect(() => { error.current = options.onError; });
    const [entry, setEntry] = useState<{ documentId: string; vaultActivation: number; bytesGeneration: number;
        kind: NativeBoardAcquisitionOptions<S>['kind']; value: AcquiredNativeBoard<S> } | null>(null);
    const { documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady,
        emergencyReadOnlyReason, prepare } = options;
    useEffect(() => {
        const abort = new AbortController();
        let alive = true;
        void (async () => {
            let prepared: PreparedNativeBoard<S> | undefined;
            let taken = false;
            try {
                prepared = await prepare(abort.signal);
                abort.signal.throwIfAborted();
                let policy: { emergencyReadOnly: boolean } | null = null;
                const adapter = attachCanvasSession<HostedBoardAdapter<S>>(documentId, (owner, isLiveOwner) => {
                    let reason: string | null = emergencyReadOnlyReason;
                    const owned = prepared!.take(owner, isLiveOwner, () => reason);
                    taken = true;
                    try {
                        policy = onNativeCanvasReady({ owner, vaultActivation, bytesGeneration, kind,
                            legacyOriginalSha256: prepared!.legacyOriginalSha256 });
                        if (!policy || !isLiveOwner(owner)) throw new DOMException('Board session ended', 'AbortError');
                        reason = policy.emergencyReadOnly ? emergencyReadOnlyReason : null;
                        if (policy.emergencyReadOnly && !owned.board.isReadOnly) throw new Error('Board session did not enforce read-only policy');
                        return createBoardSessionAdapter(owner, owned.board, isLiveOwner, () => owned.dispose());
                    } catch (cause) { owned.dispose(); throw cause; }
                });
                abort.signal.throwIfAborted();
                if (!adapter.board || !adapter.owner) throw new Error('Canvas session is not a board session');
                policy ??= onNativeCanvasReady({ owner: adapter.owner, vaultActivation, bytesGeneration, kind,
                    legacyOriginalSha256: prepared.legacyOriginalSha256 });
                if (!policy) throw new DOMException('Board session ended', 'AbortError');
                if (policy.emergencyReadOnly && !adapter.board.isReadOnly) throw new Error('Board session did not enforce read-only policy');
                if (alive) setEntry({ documentId, vaultActivation, bytesGeneration, kind,
                    value: { adapter, emergencyReadOnly: policy.emergencyReadOnly } });
            } catch (cause) {
                if (alive && !abort.signal.aborted) error.current(cause);
            } finally { if (prepared && !taken) prepared.dispose(); }
        })();
        return () => { alive = false; abort.abort(); };
    }, [documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady, emergencyReadOnlyReason, prepare]);
    return entry && entry.documentId === documentId && entry.vaultActivation === vaultActivation
        && entry.bytesGeneration === bytesGeneration && entry.kind === kind ? entry.value : null;
}
