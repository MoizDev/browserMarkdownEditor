import type { BoardSessionFactoryOptions, ComposedBoardSession } from '../session/factoryTypes';
import type { BoardBuildPorts } from './saveBuildTypes';

export interface OwnedBoardSessionOptions {
    readonly session: Omit<BoardSessionFactoryOptions, 'pinBuild'>;
    readonly builds: BoardBuildPorts;
}
export interface OwnedBoardSession {
    readonly board: ComposedBoardSession;
    dispose(): Promise<void>;
}
