import type { ComposedBoardSession } from '../session/factoryTypes';
import { createBoardBuildPinning } from './saveBuild';
import type { BoardBuildPorts } from './saveBuildTypes';
import { createBoardRuntime, type BoardRuntime, type BoardRuntimeOptions } from './runtime';

export interface OwnedBoardRuntimeOptions {
    runtime: Omit<BoardRuntimeOptions, 'pinBuild'>;
    builds: BoardBuildPorts;
}
export interface OwnedBoardRuntime {
    runtime: BoardRuntime;
    board: ComposedBoardSession;
    /** Revokes at once; resolves only after the runtime, its session and the pinned builds have retired. */
    dispose(): Promise<void>;
}

/** The runtime owns the scene and its one session; pinned builds live beside them. */
export function createOwnedBoardRuntime(options: OwnedBoardRuntimeOptions): OwnedBoardRuntime {
    const pinning = createBoardBuildPinning(options.builds);
    try {
        const runtime = createBoardRuntime({ ...options.runtime, pinBuild: pinning.pinBuild });
        let retiring: Promise<void> | undefined;
        return { runtime, board: runtime.session, dispose() {
            // Revoke now; pinned builds are cancelled only after the runtime and its session have actually retired.
            retiring ??= (async () => {
                try { await runtime.dispose(); } finally { pinning.dispose(); }
            })();
            return retiring;
        } };
    } catch (error) { pinning.dispose(); throw error; }
}
