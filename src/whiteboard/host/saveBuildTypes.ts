import type { PinnedBoardBuild } from '../session/contentSource';
import type { MediaEntry, MediaId } from '../model/media';

export interface PinnedMediaRestore {
    restore(signal: AbortSignal): Promise<'unchanged' | 'changed'>;
    release(): void;
}
export interface PinnedPdfAssembly {
    assemble(board: Uint8Array | Blob, signal: AbortSignal): Promise<Uint8Array | Blob>;
    release(): void;
}
export interface MediaRestorePorts {
    referenced(): Iterable<MediaEntry>;
    isCurrent(revision: number): boolean;
    restore(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
    updateFiles(changes: readonly { id: MediaId; expected: string | null; next: string | null }[], revision: number): boolean;
}
export interface BoardBuildPorts {
    pinMedia(revision: number): PinnedMediaRestore;
    pinPdf?(revision: number, context: unknown): PinnedPdfAssembly;
}
export interface BoardBuildPinning {
    pinBuild(base: PinnedBoardBuild, revision: number, context: unknown): PinnedBoardBuild;
    dispose(): void;
}
