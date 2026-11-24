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

/** An editable copy's content, taken from the old board in memory: its pictures, and the board's bytes once each picture
 *  has a file (built by the serializer, naming every picture by the file that holds it, as a saved board does). */
export interface NativeBoardCopySource {
    readonly media: readonly { readonly hash: string; readonly extension: string; readonly blob: Blob }[];
    build(files: ReadonlyMap<string, string>, signal: AbortSignal): Promise<Blob>;
}

/** Where the person is looking on an old drawing, written into its copy's own view record so the copy opens there. */
export interface NativeCopyView { readonly sheet: string; readonly x: number; readonly y: number; readonly zoom: number }

/** A board read from an old-format file (utils/oldBoards.ts): shown read-only, never written, copied on request. */
export interface NativeOldBoard {
    readonly kind: 'drawing' | 'notebook';
    /** What the import left out or repaired, for the original's pane; null when nothing is worth saying. */
    readonly notice: string | null;
    /** The same, said once in the copy's notice. */
    readonly copyNotice: string | null;
    copySource(signal: AbortSignal, view?: NativeCopyView): Promise<NativeBoardCopySource>;
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
    /** The first refusal that keeps this source from writing, named for the user; null when writable. */
    writeBlockReason(identity: NativeCanvasIdentity): string | null;
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
    /** An old annotated PDF's conversion only (`pdfInk`): a drawing or notebook is never converted in place. */
    keepConversionBackup(identity: NativeCanvasIdentity, original: Blob, digest: string, signal: AbortSignal): Promise<TrashItem>;
    confirmLegacyPdfConversion(identity: NativeCanvasIdentity, request: { originalSha256: string;
        foreign: Extract<import('../utils/pdfWriteMark').PdfWriteMarkCheck, { kind: 'foreign' }> | null }, signal: AbortSignal): Promise<boolean>;
    /** An old annotated PDF's conversion only (`pdfInk`), as keepConversionBackup. */
    acceptConvertedSource(identity: NativeCanvasIdentity, source: DeferredSource, originalDigest: string): void;
    /** Write `source` as a new file in this old board's folder and open it in the board's tab position. Resolves once
     *  the copy is on disk and open; throws a sentence for the person when it could not be made, with nothing left behind.
     *  `focus`: the pane had the keyboard when the copy was asked for, so the copy takes it. */
    makeEditableCopy(identity: NativeCanvasIdentity, copy: { source: NativeBoardCopySource; notice: string | null; focus?: boolean },
        signal: AbortSignal): Promise<void>;
    appendJournal(identity: NativeCanvasIdentity, source: ContentSource, capture: JournalCapture): Promise<void>;
    readMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia, signal: AbortSignal): Promise<{ name: string; blob: Blob } | null>;
    /** Resolve a local legacy media reference relative to this document's folder. */
    readLegacyAsset(identity: NativeCanvasIdentity, src: string, signal: AbortSignal): Promise<Blob | null>;
    putMedia(identity: NativeCanvasIdentity, media: NativeCanvasMedia & { extension: string }, blob: Blob, signal: AbortSignal): Promise<string>;
}
