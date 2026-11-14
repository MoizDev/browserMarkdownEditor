import type { BoardSessionFactoryOptions, ComposedBoardSession } from '../session/factoryTypes';
import type { BoardBuildPorts } from './saveBuildTypes';

export interface OwnedBoardSessionOptions {
    /** The acquisition owner supplies admitted doc, serializer, journal and identity ports. */
    readonly session: Omit<BoardSessionFactoryOptions, 'pinBuild'>;
    readonly builds: BoardBuildPorts;
}
export interface OwnedBoardSession {
    readonly board: ComposedBoardSession;
    /** App session release only, never pane detach or hide. */
    dispose(): void;
}
