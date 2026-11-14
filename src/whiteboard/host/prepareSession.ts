import { createOwnedBoardSession } from './ownedSession';
import type { AdmittedNativeBoard, NativeSessionPreparationPorts, PreparedBoardSession } from './prepareSessionTypes';

/** C5 admission finishes before a session can be constructed; a rejected/aborted acquisition
 * keeps ownership of its original bytes and leases until disposal. */
export async function prepareBoardSession<A extends AdmittedNativeBoard>(
    ports: NativeSessionPreparationPorts<A>, signal: AbortSignal,
): Promise<PreparedBoardSession> {
    signal.throwIfAborted();
    const admitted = await ports.admit(signal);
    if (signal.aborted) { admitted.dispose(); signal.throwIfAborted(); }
    let taken = false, disposed = false;
    return {
        legacyOriginalSha256: admitted.legacyOriginalSha256,
        take(owner, isCurrent, policy) {
            if (taken || disposed) throw new Error('Native acquisition was already consumed');
            const options = ports.session(admitted, owner, isCurrent, policy);
            if (options.owner.documentId !== owner.documentId || options.owner.session !== owner.session) throw new Error('Native session owner mismatch');
            const priorReason = options.readOnlyReason;
            const owned = createOwnedBoardSession({ session: { ...options,
                readOnlyReason: () => admitted.readOnlyReason ?? policy() ?? priorReason() },
                builds: ports.builds(admitted, owner, isCurrent) });
            taken = true;
            // The admitted original bytes and sample leases back the session's builds: release them only after retirement.
            let releasing: Promise<void> | undefined;
            return { board: owned.board, dispose() {
                releasing ??= (async () => {
                    try { await owned.dispose(); } finally { admitted.dispose(); }
                })();
                return releasing;
            } };
        },
        dispose() {
            if (disposed || taken) return;
            disposed = true;
            admitted.dispose();
        },
    };
}
