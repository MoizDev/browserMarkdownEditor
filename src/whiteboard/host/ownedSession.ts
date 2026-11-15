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
        let retiring: Promise<void> | undefined;
        return {
            board,
            dispose() {
                // Pins stay live until the board's tracked builds have settled; cancelling them first would strand those reads.
                retiring ??= (async () => {
                    try { await board.dispose(); } finally { builds.dispose(); }
                })();
                return retiring;
            },
        };
    } catch (error) { builds.dispose(); throw error; }
}
