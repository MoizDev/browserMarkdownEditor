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
    dispose(): void;
}

/** The runtime owns the scene and its one session; pinned builds live beside them. */
export function createOwnedBoardRuntime(options: OwnedBoardRuntimeOptions): OwnedBoardRuntime {
    const pinning = createBoardBuildPinning(options.builds);
    try {
        const runtime = createBoardRuntime({ ...options.runtime, pinBuild: pinning.pinBuild });
        let disposed = false;
        return { runtime, board: runtime.session, dispose() {
            if (disposed) return;
            disposed = true;
            try { runtime.dispose(); } finally { pinning.dispose(); }
        } };
    } catch (error) { pinning.dispose(); throw error; }
}
