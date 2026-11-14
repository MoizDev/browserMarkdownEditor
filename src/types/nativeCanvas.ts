import type { SessionAdapter } from '../utils/documentSessions';
import type { ContentSource, DeferredSource } from '../utils/documentBuffers';
import type { JournalCapture } from '../utils/recoveryFunnel';
import type { ClipboardCache } from '../utils/clipboardCache';
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
    readonly clipboard: ClipboardCache;
    identity(documentId: string): NativeCanvasIdentity | undefined;
    /** The current outer-file generation, even when a native session retains its source generation. */
    outerIdentity(documentId: string): NativeCanvasIdentity | undefined;
    session(documentId: string): SessionAdapter | undefined;
    isCurrent(identity: NativeCanvasIdentity): boolean;
    acquireBytes(identity: NativeCanvasIdentity, signal: AbortSignal): Promise<Blob>;
    keepConversionBackup(identity: NativeCanvasIdentity, original: Blob, digest: string, signal: AbortSignal): Promise<TrashItem>;
    acceptConvertedSource(identity: NativeCanvasIdentity, source: DeferredSource, originalDigest: string): void;
    appendJournal(identity: NativeCanvasIdentity, source: ContentSource, capture: JournalCapture): Promise<void>;
    readMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia, signal: AbortSignal): Promise<{ name: string; blob: Blob } | null>;
    /** Resolve a local legacy media reference relative to this document's folder. */
    readLegacyAsset(identity: NativeCanvasIdentity, src: string, signal: AbortSignal): Promise<Blob | null>;
    putMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia & { extension: string }, blob: Blob, signal: AbortSignal): Promise<string>;
}
