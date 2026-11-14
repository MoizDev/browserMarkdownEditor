import type { PinnedBoardBuild } from '../session/contentSource';
import type { MediaEntry, MediaId } from '../model/media';

export interface PinnedMediaRestore {
    /** 'changed' means set-file applied a new revision: this build must not save old names. */
    restore(signal: AbortSignal): Promise<'unchanged' | 'changed'>;
    release(): void;
}
export interface PinnedPdfAssembly {
    /** Snapshot-owned page lists, source PDF and attachment set; no live reads. */
    assemble(board: Uint8Array | Blob, signal: AbortSignal): Promise<Uint8Array | Blob>;
    release(): void;
}
/** Called only when the currently live entry still matches the pinned filename/revision. */
export interface MediaRestorePorts {
    referenced(): Iterable<MediaEntry>;
    isCurrent(revision: number): boolean;
    restore(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null>;
    updateFiles(changes: readonly { id: MediaId; expected: string | null; next: string | null }[], revision: number): boolean;
}
export interface BoardBuildPorts {
    pinMedia(revision: number): PinnedMediaRestore;
    pinPdf?(revision: number): PinnedPdfAssembly;
}
export interface BoardBuildPinning {
    pinBuild(base: PinnedBoardBuild, revision: number): PinnedBoardBuild;
    /** App session release cancels and releases all still-retained snapshots. */
    dispose(): void;
}
