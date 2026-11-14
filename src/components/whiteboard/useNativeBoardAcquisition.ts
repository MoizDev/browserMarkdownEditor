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
        emergencyReadOnlyReason, prepare, existing, acceptConvertedSource, currentOwner } = options;
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
                    let activated = false, sealed: string | null = null;
                    const conversionPending = !!prepared!.conversionPending, digest = prepared!.legacyOriginalSha256;
                    const owned = prepared!.take(owner, isLiveOwner, () => reason);
                    taken = true;
                    try {
                        policy = onNativeCanvasReady({ owner, vaultActivation, bytesGeneration, kind,
                            legacyOriginalSha256: prepared!.legacyOriginalSha256,
                            ...(owned.pdfWriteAuthority ? { pdfWriteAuthority: owned.pdfWriteAuthority } : {}) });
                        if (!policy || !isLiveOwner(owner)) throw new DOMException('Board session ended', 'AbortError');
                        if (!owned.board.isReadOnly) throw new Error('Board session did not enforce its initial read-only policy');
                        const emergency = policy.emergencyReadOnly;
                        const hosted = createBoardSessionAdapter(owner, owned.board, isLiveOwner, () => owned.dispose());
                        return { ...hosted, activateEditing() {
                            if (!isLiveOwner(owner) || !currentOwner() || getSessionIdentity(documentId) !== identity) throw new DOMException('Board session ended', 'AbortError');
                            if (sealed) throw new Error(sealed);
                            if (activated) return;
                            if (emergency) throw new Error(emergencyReadOnlyReason);
                            reason = null;
                            if (owned.board.isReadOnly) {
                                const denied = owned.board.readOnlyReason ?? 'This board cannot be edited safely.';
                                reason = emergencyReadOnlyReason;
                                throw new Error(denied);
                            }
                            try {
                                if (conversionPending) {
                                    const source = hosted.checkpoint();
                                    if (typeof source === 'string' || !digest || !acceptConvertedSource) throw new Error('Legacy conversion source is unavailable');
                                    acceptConvertedSource(source, digest);
                                }
                                activated = true;
                            } catch (cause) {
                                sealed = 'The converted canvas could not be safely accepted. The original is unchanged; close the document tab and reopen it to retry.';
                                reason = sealed;
                                throw new Error(sealed, { cause });
                            }
                        } };
                    } catch (cause) { failedTakeCleanup = Promise.resolve().then(() => owned.dispose()); throw cause; }
                });
                requireOwner();
                if (adapter.owner?.session !== identity.serial) throw new DOMException('Board session ended', 'AbortError');
                if (!adapter.board || !adapter.owner) throw new Error('Canvas session is not a board session');
                policy ??= onNativeCanvasReady({ owner: adapter.owner, vaultActivation, bytesGeneration, kind,
                    legacyOriginalSha256: prepared.legacyOriginalSha256 });
                if (!policy) throw new DOMException('Board session ended', 'AbortError');
                if (policy.emergencyReadOnly && !adapter.board.isReadOnly) throw new Error('Board session did not enforce read-only policy');
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
    }, [documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady, emergencyReadOnlyReason, prepare, existing, acceptConvertedSource, currentOwner]);
    return entry && entry.documentId === documentId && entry.vaultActivation === vaultActivation
        && entry.bytesGeneration === bytesGeneration && entry.kind === kind ? entry.value : null;
}
