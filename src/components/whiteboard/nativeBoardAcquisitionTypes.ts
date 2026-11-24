import type { DeferredSource, SourceOwner } from '../../utils/documentBuffers';
import type { AttachCanvasSession } from '../../utils/canvasSessionBridge';
import type { NativeCanvasReady } from '../../types/reading';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';

/** Preparation owns the original bytes until take transfers them to the App-owned session. */
export interface PreparedNativeBoard<S extends BoardSessionPort> {
    readonly legacyOriginalSha256: string | null;
    /** An old annotated PDF converted for editing (`pdfInk` only): its first editing admission installs the converted
     *  source as the clean baseline. A drawing or notebook is never converted in place. */
    readonly conversionPending?: boolean;
    /** The board notice for an imported old board (items left out, repairs worth reading); null when none. */
    readonly importNotice?: string | null;
    /** The board came from an old-format file: read-only for life, copied on request (utils/oldBoards.ts). */
    readonly oldBoard?: import('../../types/nativeCanvas').NativeOldBoard;
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
    /** Why the source is not authorized, in the person's words (App's first failing guard); the board shows it. */
    sourceBlockReason?(): string | null;
    /** Final App authority; checked only after the temporary view guard is lifted. */
    editingAuthorized(): boolean;
    existing?(): AcquiredNativeBoard<S> | undefined;
    prepare(signal: AbortSignal): Promise<PreparedNativeBoard<S>>;
    /** An old annotated PDF's conversion only (see `conversionPending`). */
    acceptConvertedSource?: (source: DeferredSource, originalDigest: string) => void;
    onError(error: unknown): void;
}
export interface AcquiredNativeBoard<S extends BoardSessionPort> {
    readonly adapter: HostedBoardAdapter<S>;
    readonly emergencyReadOnly: boolean;
}
