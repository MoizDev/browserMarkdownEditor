import type { RenderToken } from '../../platform/render/types';
import type { BoardRuntime } from '../host/runtime';
import type { PdfInkSourceLease } from '../host/pdfInkSourceOwner';
import type { MediaEntry, MediaId } from '../model/media';
import type { JobContext } from '../security/admission';
import type { InspectedMedia } from './ingest';

export interface MediaStorageProof {
    readonly runtime: BoardRuntime;
    /** The actual running runtime.jobs context; the issuer calls assertContext. */
    readonly context: JobContext;
    /** Must be the descriptor actually returned by inspectMedia for these bytes and this job. */
    readonly inspection: InspectedMedia;
}
export interface MediaStorageRequest extends MediaStorageProof {
    readonly entry: MediaEntry;
    readonly blob: Blob;
}
export interface CurrentDocumentBytes {
    readonly owner: Readonly<{ documentId: string; session: number }>;
    readonly revision: number;
    readonly bytes: Uint8Array | Blob;
    /** Releases the actual deferred checkpoint/build/source retention. */
    release(): void;
}

export type MediaStorageDestination =
    | Readonly<{
        kind: 'file'; file: string;
        /** Actual App filesystem/source permission and owner validation after the write. */
        assertWritable(): void;
    }>
    | Readonly<{
        kind: 'embedded'; token: RenderToken;
        /** Real current writable PDF source retention, transferred only if issuance succeeds. */
        source: PdfInkSourceLease;
        assertWritable(): void;
        /** board.checkpoint() -> retained deferred read -> actual BuildJob.run(signal).
         * This captures CURRENT full bytes, including unsaved model/media; it does not
         * acknowledge a filesystem write and must never return pristine/outer baseline bytes.
         * Not invoked per image: the same actual source pipeline owns autosave/recovery. */
        captureCurrentBytes(signal: AbortSignal): Promise<CurrentDocumentBytes>;
    }>;

/** Only the real issuer can create an admitted receipt. Structural lookalikes fail its brand check. */
export interface MediaStorageReceipt {
    readonly kind: 'file' | 'embedded';
    readonly id: MediaId;
    readonly file: string | null;
    readonly owner: Readonly<{ documentId: string; session: number }>;
    assertCurrent(): void;
    /** Call only after the same atomic media+node model transaction succeeds. */
    committed(): void;
    /** Embedded capture is available only after commit, while this receipt is retained. */
    captureCurrentBytes(signal: AbortSignal): Promise<CurrentDocumentBytes>;
    /** Before commit: rollback pending retention. After commit: document/history/journal
     * and captured checkpoints retain the canonical MediaStore blob independently. */
    release(): void;
}
export type StoreVerifiedMedia = (entry: MediaEntry, blob: Blob, signal: AbortSignal,
    proof: MediaStorageProof) => Promise<MediaStorageReceipt>;
export type MediaStorageIssuer = (request: MediaStorageRequest, destination: MediaStorageDestination) => MediaStorageReceipt;
