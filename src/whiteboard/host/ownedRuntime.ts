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
    dispose(): Promise<void>;
}

export function createOwnedBoardRuntime(options: OwnedBoardRuntimeOptions): OwnedBoardRuntime {
    const pinning = createBoardBuildPinning(options.builds);
    try {
        const runtime = createBoardRuntime({ ...options.runtime, pinBuild: pinning.pinBuild });
        let retiring: Promise<void> | undefined;
        return { runtime, board: runtime.session, dispose() {
            retiring ??= (async () => {
                try { await runtime.dispose(); } finally { pinning.dispose(); }
            })();
            return retiring;
        } };
    } catch (error) { pinning.dispose(); throw error; }
}
