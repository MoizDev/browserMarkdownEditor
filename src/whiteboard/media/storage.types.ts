import type { RenderToken } from '../../platform/render/types';
import type { BoardRuntime } from '../host/runtime';
import type { PdfInkSourceLease } from '../host/pdfInkSourceOwner';
import type { MediaEntry, MediaId } from '../model/media';
import type { JobContext } from '../security/admission';
import type { InspectedMedia } from './ingest';

export interface MediaStorageProof {
    readonly runtime: BoardRuntime;
    readonly context: JobContext;
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
    release(): void;
}

export type MediaStorageDestination =
    | Readonly<{
        kind: 'file'; file: string;
        assertWritable(): void;
    }>
    | Readonly<{
        kind: 'embedded'; token: RenderToken;
        source: PdfInkSourceLease;
        assertWritable(): void;
        captureCurrentBytes(signal: AbortSignal): Promise<CurrentDocumentBytes>;
    }>;

export interface MediaStorageReceiptBase {
    readonly id: MediaId;
    readonly owner: Readonly<{ documentId: string; session: number }>;
    assertCurrent(): void;
    committed(): void;
    release(): void;
}
export type MediaStorageReceipt = MediaStorageReceiptBase & (
    | Readonly<{ kind: 'file'; file: string }>
    | Readonly<{ kind: 'embedded'; file: null;
        captureCurrentBytes(signal: AbortSignal): Promise<CurrentDocumentBytes> }>
);
export type MediaStorageResult = MediaStorageReceipt | string | null;
export type StoreMedia = (entry: MediaEntry, blob: Blob, signal: AbortSignal, proof: MediaStorageProof) => Promise<MediaStorageResult>;
export type StoreVerifiedMedia = (entry: MediaEntry, blob: Blob, signal: AbortSignal,
    proof: MediaStorageProof) => Promise<MediaStorageReceipt>;
export type MediaStorageIssuer = (request: MediaStorageRequest, destination: MediaStorageDestination) => MediaStorageReceipt;
