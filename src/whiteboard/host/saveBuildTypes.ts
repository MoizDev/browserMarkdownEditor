import type { PinnedBoardBuild } from '../session/contentSource';

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
export interface BoardBuildPorts {
    pinMedia(revision: number): PinnedMediaRestore;
    pinPdf?(revision: number): PinnedPdfAssembly;
}
export interface BoardBuildPinning {
    pinBuild(base: PinnedBoardBuild, revision: number): PinnedBoardBuild;
    /** App session release cancels and releases all still-retained snapshots. */
    dispose(): void;
}
