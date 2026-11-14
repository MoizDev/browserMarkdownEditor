import type { SessionAdapter } from '../utils/documentSessions';
import type { ContentSource } from '../utils/documentBuffers';
import type { JournalCapture } from '../utils/recoveryFunnel';
import type { TrashItem } from './index';

export interface NativeCanvasIdentity {
    readonly documentId: string;
    readonly session: number;
    readonly vaultActivation: number;
    readonly bytesGeneration: number;
    readonly kind: 'drawing' | 'notebook' | 'pdfInk';
    readonly path: string;
    readonly name: string;
}

export interface NativeCanvasMedia {
    readonly hash: string;
    readonly preferredName?: string | null;
}

export interface NativeCanvasHost {
    identity(documentId: string): NativeCanvasIdentity | undefined;
    session(documentId: string): SessionAdapter | undefined;
    isCurrent(identity: NativeCanvasIdentity): boolean;
    acquireBytes(identity: NativeCanvasIdentity, signal: AbortSignal): Promise<Blob>;
    keepConversionBackup(identity: NativeCanvasIdentity, original: Blob, digest: string, signal: AbortSignal): Promise<TrashItem>;
    appendJournal(identity: NativeCanvasIdentity, source: ContentSource, capture: JournalCapture): Promise<void>;
    readMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia, signal: AbortSignal): Promise<{ name: string; blob: Blob } | null>;
    putMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia & { extension: string }, blob: Blob, signal: AbortSignal): Promise<string>;
}
