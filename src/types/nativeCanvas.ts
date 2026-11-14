import type { SessionAdapter } from '../utils/documentSessions';
import type { ContentSource, DeferredSource } from '../utils/documentBuffers';
import type { JournalCapture } from '../utils/recoveryFunnel';
import type { ClipboardCache } from '../utils/clipboardCache';
import type { TrashItem } from './index';
import type { EmbedContainmentApproval, EmbedContainmentFactory, EmbedFrameManifest } from '../platform/embedContainment.types';
import type { NativeEditingCapabilityFactory } from '../components/whiteboard/nativeEditingCapabilities';

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

export interface NativeEmbedHost {
    readonly manifest: EmbedFrameManifest;
    readonly create: EmbedContainmentFactory;
    readonly approved: EmbedContainmentApproval;
}

export interface NativeCanvasHost {
    readonly clipboard: ClipboardCache;
    readonly embeds: NativeEmbedHost;
    readonly createEditingCapabilities: NativeEditingCapabilityFactory;
    identity(documentId: string): NativeCanvasIdentity | undefined;
    /** The current outer-file generation, even when a native session retains its source generation. */
    outerIdentity(documentId: string): NativeCanvasIdentity | undefined;
    session(documentId: string): SessionAdapter | undefined;
    isCurrent(identity: NativeCanvasIdentity): boolean;
    /** Source/owner authority without the board's own read-only guard; safe inside that guard. */
    canWriteSource(identity: NativeCanvasIdentity): boolean;
    /** Live App write authority, including the board's own read-only guard. */
    canWrite(identity: NativeCanvasIdentity): boolean;
    acquireBytes(identity: NativeCanvasIdentity, signal: AbortSignal): Promise<Blob>;
    /** Capture the actual cold buffer before any asynchronous source preparation. */
    pinBoardSource(identity: NativeCanvasIdentity): {
        readonly dirty: boolean;
        read(signal: AbortSignal): Promise<{ readonly input: Blob; readonly diskHash: string }>;
        verify(signal: AbortSignal): Promise<void>;
        isCurrent(): boolean;
        accept(source: DeferredSource): void;
        release(): void;
    };
    keepConversionBackup(identity: NativeCanvasIdentity, original: Blob, digest: string, signal: AbortSignal): Promise<TrashItem>;
    confirmLegacyPdfConversion(identity: NativeCanvasIdentity, request: { originalSha256: string;
        foreign: Extract<import('../utils/pdfWriteMark').PdfWriteMarkCheck, { kind: 'foreign' }> | null }, signal: AbortSignal): Promise<boolean>;
    acceptConvertedSource(identity: NativeCanvasIdentity, source: DeferredSource, originalDigest: string): void;
    appendJournal(identity: NativeCanvasIdentity, source: ContentSource, capture: JournalCapture): Promise<void>;
    readMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia, signal: AbortSignal): Promise<{ name: string; blob: Blob } | null>;
    /** Resolve a local legacy media reference relative to this document's folder. */
    readLegacyAsset(identity: NativeCanvasIdentity, src: string, signal: AbortSignal): Promise<Blob | null>;
    putMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia & { extension: string }, blob: Blob, signal: AbortSignal): Promise<string>;
}
