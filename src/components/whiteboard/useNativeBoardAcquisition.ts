import { useEffect, useRef, useState } from 'react';
import { createBoardSessionAdapter } from './boardSessionAdapter';
import { awaitSessionDisposals, getSessionIdentity } from '../../utils/sessionIdentity';
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
        emergencyReadOnlyReason, prepare, existing, acceptConvertedSource } = options;
    useEffect(() => {
        const abort = new AbortController();
        let alive = true;
        try {
            const value = existing?.();
            if (value) {
                const identity = getSessionIdentity(documentId);
                if (!identity || value.adapter.owner.documentId !== documentId
                    || value.adapter.owner.session !== identity.serial) throw new DOMException('Board session ended', 'AbortError');
                setEntry({ documentId, vaultActivation, bytesGeneration, kind, value });
                return () => { alive = false; abort.abort(); };
            }
        } catch (cause) {
            if (!(cause instanceof DOMException && cause.name === 'AbortError')) error.current(cause);
            return () => { alive = false; abort.abort(); };
        }
        void (async () => {
            let prepared: PreparedNativeBoard<S> | undefined;
            let taken = false, failedTakeCleanup: Promise<void> | undefined;
            try {
                const identity = getSessionIdentity(documentId);
                if (!identity || identity.bytesGeneration !== bytesGeneration) throw new DOMException('Board session ended', 'AbortError');
                const requireOwner = () => {
                    abort.signal.throwIfAborted();
                    if (!alive || getSessionIdentity(documentId) !== identity) throw new DOMException('Board session ended', 'AbortError');
                };
                await awaitSessionDisposals(documentId);
                requireOwner();
                prepared = await prepare(abort.signal);
                requireOwner();
                if (prepared.conversionPending && (!prepared.legacyOriginalSha256 || !/^[a-f0-9]{64}$/.test(prepared.legacyOriginalSha256))) {
                    throw new Error('Legacy conversion requires a verified original digest');
                }
                if (prepared.conversionPending && !acceptConvertedSource) throw new Error('Legacy conversion has no source acceptance port');
                let policy: { emergencyReadOnly: boolean } | null = null;
                const adapter = attachCanvasSession<HostedBoardAdapter<S>>(documentId, (owner, isLiveOwner) => {
                    requireOwner();
                    if (owner.session !== identity.serial || !isLiveOwner(owner)) throw new DOMException('Board session ended', 'AbortError');
                    let reason: string | null = emergencyReadOnlyReason;
                    const owned = prepared!.take(owner, isLiveOwner, () => reason);
                    taken = true;
                    try {
                        policy = onNativeCanvasReady({ owner, vaultActivation, bytesGeneration, kind,
                            legacyOriginalSha256: prepared!.legacyOriginalSha256,
                            ...(owned.pdfWriteAuthority ? { pdfWriteAuthority: owned.pdfWriteAuthority } : {}) });
                        if (!policy || !isLiveOwner(owner)) throw new DOMException('Board session ended', 'AbortError');
                        reason = policy.emergencyReadOnly ? emergencyReadOnlyReason : null;
                        if (policy.emergencyReadOnly && !owned.board.isReadOnly) throw new Error('Board session did not enforce read-only policy');
                        return createBoardSessionAdapter(owner, owned.board, isLiveOwner, () => owned.dispose());
                    } catch (cause) { failedTakeCleanup = Promise.resolve().then(() => owned.dispose()); throw cause; }
                });
                requireOwner();
                if (adapter.owner?.session !== identity.serial) throw new DOMException('Board session ended', 'AbortError');
                if (!adapter.board || !adapter.owner) throw new Error('Canvas session is not a board session');
                policy ??= onNativeCanvasReady({ owner: adapter.owner, vaultActivation, bytesGeneration, kind,
                    legacyOriginalSha256: prepared.legacyOriginalSha256 });
                if (!policy) throw new DOMException('Board session ended', 'AbortError');
                if (policy.emergencyReadOnly && !adapter.board.isReadOnly) throw new Error('Board session did not enforce read-only policy');
                if (taken && prepared.conversionPending && !policy.emergencyReadOnly && !adapter.board.isReadOnly) {
                    const source = adapter.checkpoint();
                    if (typeof source === 'string') throw new Error('Legacy conversion did not produce a deferred source');
                    acceptConvertedSource!(source, prepared.legacyOriginalSha256!);
                }
                if (alive) setEntry({ documentId, vaultActivation, bytesGeneration, kind,
                    value: { adapter, emergencyReadOnly: policy.emergencyReadOnly } });
            } catch (cause) {
                if (alive && !abort.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) error.current(cause);
            } finally {
                try { if (failedTakeCleanup) await failedTakeCleanup; } catch (cause) { error.current(cause); }
                try { if (prepared && !taken) await prepared.dispose(); } catch (cause) { error.current(cause); }
            }
        })();
        return () => { alive = false; abort.abort(); };
    }, [documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady, emergencyReadOnlyReason, prepare, existing, acceptConvertedSource]);
    return entry && entry.documentId === documentId && entry.vaultActivation === vaultActivation
        && entry.bytesGeneration === bytesGeneration && entry.kind === kind ? entry.value : null;
}
