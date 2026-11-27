import type { DeferredSource, SourceOwner } from '../../utils/documentBuffers';
import type { AttachCanvasSession } from '../../utils/canvasSessionBridge';
import type { NativeCanvasReady } from '../../types/reading';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';

export interface PreparedNativeBoard<S extends BoardSessionPort> {
    readonly legacyOriginalSha256: string | null;
    readonly conversionPending?: boolean;
    readonly importNotice?: string | null;
    readonly oldBoard?: import('../../types/nativeCanvas').NativeOldBoard;
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
    sourceAuthorized(): boolean;
    sourceBlockReason?(): string | null;
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
