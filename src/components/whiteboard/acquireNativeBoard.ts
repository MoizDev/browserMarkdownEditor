import { getSessionIdentity } from '../../utils/sessionIdentity';
import { createBoardSessionAdapter, type BoardSessionPort, type HostedBoardAdapter } from './boardSessionAdapter';
import type { AcquiredNativeBoard, NativeBoardAcquisitionOptions, PreparedNativeBoard } from './nativeBoardAcquisitionTypes';

interface Flight { controller: AbortController; waiters: number; settled: boolean; result: Promise<AcquiredNativeBoard<BoardSessionPort>> }
// This is only an in-flight lock. The CanvasSessionBridge owns the resulting board.
const flights = new Map<string, Flight>();

async function acquire<S extends BoardSessionPort>(options: NativeBoardAcquisitionOptions<S>, signal: AbortSignal): Promise<AcquiredNativeBoard<S>> {
    const { documentId, vaultActivation, bytesGeneration, kind, attachCanvasSession, onNativeCanvasReady,
        emergencyReadOnlyReason, prepare, acceptConvertedSource, currentOwner, sourceAuthorized, editingAuthorized } = options;
    const identity = getSessionIdentity(documentId);
    if (!identity) throw new DOMException('Board session ended', 'AbortError');
    const requireOwner = () => {
        signal.throwIfAborted();
        if (getSessionIdentity(documentId) !== identity || !currentOwner()) throw new DOMException('Board session ended', 'AbortError');
    };
    requireOwner();
    const existing = options.existing?.();
    if (existing) {
        if (existing.adapter.owner.session !== identity.serial) throw new DOMException('Board session ended', 'AbortError');
        return existing;
    }
    if (identity.bytesGeneration !== bytesGeneration) throw new DOMException('Board session ended', 'AbortError');
    let prepared: PreparedNativeBoard<S> | undefined, taken = false, failedTakeCleanup: Promise<void> | undefined;
    try {
        const ready = options.existing?.();
        if (ready) return ready;
        prepared = await prepare(signal);
        requireOwner();
        if (prepared.conversionPending && (!prepared.legacyOriginalSha256 || !/^[a-f0-9]{64}$/.test(prepared.legacyOriginalSha256))) {
            throw new Error('Legacy conversion requires a verified original digest');
        }
        if (prepared.conversionPending && !acceptConvertedSource) throw new Error('Legacy conversion has no source acceptance port');
        let policy: { emergencyReadOnly: boolean } | null = null;
        let sourceAccepted = false;
        const adapter = attachCanvasSession<HostedBoardAdapter<S>>(documentId, (owner, isLiveOwner) => {
            requireOwner();
            if (owner.session !== identity.serial || !isLiveOwner(owner)) throw new DOMException('Board session ended', 'AbortError');
            let reason: string | null = emergencyReadOnlyReason;
            let activated = false, sealed: string | null = null;
            const conversionPending = !!prepared!.conversionPending, digest = prepared!.legacyOriginalSha256;
            let noticeDismissed = false;
            const importNotice = prepared!.importNotice ? { text: prepared!.importNotice,
                isDismissed: () => noticeDismissed, dismiss() { noticeDismissed = true; } } : undefined;
            const owned = prepared!.take(owner, isLiveOwner, () => reason ??
                (sourceAuthorized() ? null : 'Canvas source is not currently authorized for editing.'));
            taken = true;
            try {
                policy = onNativeCanvasReady({ owner, vaultActivation, bytesGeneration, kind,
                    legacyOriginalSha256: prepared!.legacyOriginalSha256,
                    ...(owned.pdfWriteAuthority ? { pdfWriteAuthority: owned.pdfWriteAuthority } : {}) });
                if (!policy || !isLiveOwner(owner)) throw new DOMException('Board session ended', 'AbortError');
                if (!owned.board.isReadOnly) throw new Error('Board session did not enforce its initial read-only policy');
                const emergency = policy.emergencyReadOnly;
                const hosted = createBoardSessionAdapter(owner, owned.board, isLiveOwner, () => owned.dispose());
                return { ...hosted, ...(importNotice ? { importNotice } : {}), activateEditing() {
                    // A versioned PDF save advances bytes, not the retained board/undo owner.
                    if (!isLiveOwner(owner) || !currentOwner() || getSessionIdentity(documentId)?.serial !== owner.session) throw new DOMException('Board session ended', 'AbortError');
                    if (sealed) throw new Error(sealed);
                    if (activated) {
                        try { if (!editingAuthorized()) throw new Error('Canvas editing is no longer authorized.'); }
                        catch (cause) { reason = emergencyReadOnlyReason; activated = false; throw cause; }
                        return;
                    }
                    if (emergency) throw new Error(emergencyReadOnlyReason);
                    reason = null;
                    if (owned.board.isReadOnly) {
                        const denied = owned.board.readOnlyReason ?? 'This board cannot be edited safely.';
                        reason = emergencyReadOnlyReason;
                        throw new Error(denied);
                    }
                    try {
                        if (!editingAuthorized()) throw new Error('Canvas editing is no longer authorized.');
                    } catch (cause) {
                        reason = emergencyReadOnlyReason;
                        throw cause;
                    }
                    try {
                        if (conversionPending && !sourceAccepted) {
                            const source = hosted.checkpoint();
                            if (typeof source === 'string' || !digest || !acceptConvertedSource) throw new Error('Legacy conversion source is unavailable');
                            acceptConvertedSource(source, digest);
                            sourceAccepted = true;
                        }
                        activated = true;
                    } catch (cause) {
                        sealed = 'The converted canvas could not be safely accepted. The original is unchanged; close the document tab and reopen it to retry.';
                        reason = sealed;
                        throw new Error(sealed, { cause });
                    }
                } };
            } catch (cause) { failedTakeCleanup = Promise.resolve().then(() => owned.dispose()); throw cause; }
        }, (staged, owner) => {
            requireOwner();
            if (staged.owner.documentId !== owner.documentId || staged.owner.session !== owner.session) throw new DOMException('Board session ended', 'AbortError');
            if (prepared!.acceptPinnedSource) {
                const source = staged.checkpoint();
                if (typeof source === 'string') throw new Error('Native checkpoint is unavailable');
                sourceAccepted = prepared!.acceptPinnedSource(source);
            }
        });
        requireOwner();
        if (adapter.owner?.session !== identity.serial) throw new DOMException('Board session ended', 'AbortError');
        if (!adapter.board || !adapter.owner) throw new Error('Canvas session is not a board session');
        policy ??= onNativeCanvasReady({ owner: adapter.owner, vaultActivation, bytesGeneration, kind,
            legacyOriginalSha256: prepared.legacyOriginalSha256 });
        if (!policy) throw new DOMException('Board session ended', 'AbortError');
        if (policy.emergencyReadOnly && !adapter.board.isReadOnly) throw new Error('Board session did not enforce read-only policy');
        return { adapter, emergencyReadOnly: policy.emergencyReadOnly };
    } finally {
        try { if (failedTakeCleanup) await failedTakeCleanup; } catch (cause) { options.onError(cause); }
        try { if (prepared && !taken) await prepared.dispose(); } catch (cause) { options.onError(cause); }
    }
}

/** A pane abort cannot cancel another waiter; the final waiter cancels preparation. */
export async function ensureNativeBoard<S extends BoardSessionPort>(options: NativeBoardAcquisitionOptions<S>, signal: AbortSignal): Promise<AcquiredNativeBoard<S>> {
    signal.throwIfAborted();
    const identity = getSessionIdentity(options.documentId);
    if (!identity || !options.currentOwner()) throw new DOMException('Board session ended', 'AbortError');
    const existing = options.existing?.();
    if (existing) {
        if (existing.adapter.owner.session !== identity.serial) throw new DOMException('Board session ended', 'AbortError');
        return existing;
    }
    if (identity.bytesGeneration !== options.bytesGeneration) throw new DOMException('Board session ended', 'AbortError');
    const key = JSON.stringify([options.documentId, identity.serial, options.vaultActivation, options.bytesGeneration, options.kind]);
    let flight = flights.get(key);
    if (flight?.controller.signal.aborted) {
        let abort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason ?? new DOMException('Board acquisition cancelled', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        });
        try { await Promise.race([flight.result.catch(() => {}), cancelled]); }
        finally { signal.removeEventListener('abort', abort); }
        signal.throwIfAborted();
        return ensureNativeBoard(options, signal);
    }
    if (!flight) {
        const controller = new AbortController();
        const created: Flight = { controller, waiters: 0, settled: false, result: acquire(options, controller.signal) };
        flight = created;
        flights.set(key, created);
        void created.result.finally(() => { created.settled = true; if (flights.get(key) === created) flights.delete(key); }).catch(() => {});
    }
    const selected = flight;
    selected.waiters++;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Board acquisition cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
    try { return await Promise.race([selected.result as Promise<AcquiredNativeBoard<S>>, cancelled]); }
    finally {
        signal.removeEventListener('abort', abort);
        if (--selected.waiters === 0 && !selected.settled && flights.get(key) === selected) selected.controller.abort();
    }
}
