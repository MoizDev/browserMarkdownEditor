import { createBoardSession } from '../session/createBoardSession';
import { createBoardBuildPinning } from './saveBuild';
import type { OwnedBoardSession, OwnedBoardSessionOptions } from './ownedSessionTypes';

/** The one session factory is shared by drawing, notebook and PDF ink; only the injected
 * pinned-build ports differ. App releases this owner after its save barrier, not on hide. */
export function createOwnedBoardSession(options: OwnedBoardSessionOptions): OwnedBoardSession {
    // C-19 calls its creator before registering the owner; liveness is checked on use.
    const builds = createBoardBuildPinning(options.builds);
    try {
        const board = createBoardSession({ ...options.session, pinBuild: builds.pinBuild });
        let disposed = false;
        return {
            board,
            dispose() {
                if (disposed) return;
                disposed = true;
                try { board.dispose(); } finally { builds.dispose(); }
            },
        };
    } catch (error) { builds.dispose(); throw error; }
}
