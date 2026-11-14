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
            let released = false;
            return { board: owned.board, dispose() {
                if (released) return;
                released = true;
                try { owned.dispose(); } finally { admitted.dispose(); }
            } };
        },
        dispose() {
            if (disposed || taken) return;
            disposed = true;
            admitted.dispose();
        },
    };
}
