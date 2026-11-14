import type { SourceOwner } from '../../utils/documentBuffers';
import type { AttachCanvasSession } from '../../utils/canvasSessionBridge';
import type { NativeCanvasReady } from '../../types/reading';
import type { BoardSessionPort, HostedBoardAdapter } from './boardSessionAdapter';

/** Preparation owns the original bytes until take transfers them to the App-owned session. */
export interface PreparedNativeBoard<S extends BoardSessionPort> {
    readonly legacyOriginalSha256: string | null;
    take(owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean, readOnlyReason: () => string | null): {
        readonly board: S;
        dispose(): void;
    };
    dispose(): void;
}
export interface NativeBoardAcquisitionOptions<S extends BoardSessionPort> {
    readonly documentId: string;
    readonly vaultActivation: number;
    readonly bytesGeneration: number;
    readonly kind: 'drawing' | 'notebook' | 'pdfInk';
    readonly attachCanvasSession: AttachCanvasSession;
    readonly onNativeCanvasReady: NativeCanvasReady;
    readonly emergencyReadOnlyReason: string;
    prepare(signal: AbortSignal): Promise<PreparedNativeBoard<S>>;
    onError(error: unknown): void;
}
export interface AcquiredNativeBoard<S extends BoardSessionPort> {
    readonly adapter: HostedBoardAdapter<S>;
    readonly emergencyReadOnly: boolean;
}
