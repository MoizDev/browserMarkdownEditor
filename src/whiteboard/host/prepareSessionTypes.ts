import type { SourceOwner } from '../../utils/documentBuffers';
import type { BoardSessionFactoryOptions, ComposedBoardSession } from '../session/factoryTypes';
import type { BoardBuildPorts } from './saveBuildTypes';

/** Admission owns original and sample leases until the one session takes them. */
export interface AdmittedNativeBoard {
    readonly readOnlyReason: string | null;
    readonly legacyOriginalSha256: string | null;
    dispose(): void;
}
export interface NativeSessionPreparationPorts<A extends AdmittedNativeBoard> {
    /** Parse and C5 repair/validate before the draft becomes a BoardDoc. */
    admit(signal: AbortSignal): Promise<A>;
    session(admitted: A, owner: SourceOwner, isCurrent: (owner: SourceOwner) => boolean,
        readOnlyReason: () => string | null): Omit<BoardSessionFactoryOptions, 'pinBuild'>;
    builds(admitted: A, owner: SourceOwner, isCurrent: (owner: SourceOwner) => boolean): BoardBuildPorts;
}
export interface PreparedBoardSession {
    readonly legacyOriginalSha256: string | null;
    take(owner: SourceOwner, isCurrent: (owner: SourceOwner) => boolean, readOnlyReason: () => string | null): {
        readonly board: ComposedBoardSession;
        dispose(): void;
    };
    dispose(): void;
}
