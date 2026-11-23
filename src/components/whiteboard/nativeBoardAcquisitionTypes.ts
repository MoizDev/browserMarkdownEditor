import type { DeferredSource, SourceOwner } from '../../utils/documentBuffers';
import type { AttachCanvasSession } from '../../utils/canvasSessionBridge';
import type { NativeCanvasReady } from '../../types/reading';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';

/** Preparation owns the original bytes until take transfers them to the App-owned session. */
export interface PreparedNativeBoard<S extends BoardSessionPort> {
    readonly legacyOriginalSha256: string | null;
    readonly conversionPending?: boolean;
    /** The board notice for a converted old board (items left out, repairs worth reading); null when none. */
    readonly importNotice?: string | null;
    /** Commit a captured dirty cold input only after the bridge owns this board. */
    acceptPinnedSource?(source: DeferredSource): boolean;
    take(owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean, readOnlyReason: () => string | null): {
        readonly board: S;
        readonly pdfWriteAuthority?: { canWriteSource(): boolean; canWrite(): boolean };
        dispose(): void | Promise<void>;
    };
    dispose(): void | Promise<void>;
}
export interface NativeBoardAcquisitionOptions<S extends BoardSessionPort> {
    readonly documentId: string;
    readonly vaultActivation: number;
    readonly bytesGeneration: number;
    readonly kind: 'drawing' | 'notebook' | 'pdfInk';
    readonly attachCanvasSession: AttachCanvasSession;
    readonly onNativeCanvasReady: NativeCanvasReady;
    readonly emergencyReadOnlyReason: string;
    currentOwner(): boolean;
    /** The real nonrecursive App source policy, rechecked by every session mutation. */
    sourceAuthorized(): boolean;
    /** Final App authority; checked only after the temporary view guard is lifted. */
    editingAuthorized(): boolean;
    existing?(): AcquiredNativeBoard<S> | undefined;
    prepare(signal: AbortSignal): Promise<PreparedNativeBoard<S>>;
    acceptConvertedSource?: (source: DeferredSource, originalDigest: string) => void;
    onError(error: unknown): void;
}
export interface AcquiredNativeBoard<S extends BoardSessionPort> {
    readonly adapter: HostedBoardAdapter<S>;
    readonly emergencyReadOnly: boolean;
}
