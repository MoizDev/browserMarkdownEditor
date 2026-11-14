import type { Applied, TouchedSet, Transaction, TransactionOrigin, TxBuilder } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import type { SampleStoreReader } from '../model/samples';
import type { SessionGestureQueue } from './gestureQueue';

// contracts C7.0: no path or diskRev is a session identity. The App store owns the serial.
export interface SessionOwner {
    readonly documentId: string;
    readonly session: number;
}

// Structural C7 source types; the session implementation integrates core's canonical types.
// A checkpoint pins one revision synchronously; a job must never read the live doc.
export interface BuildJob {
    readonly kind: 'build';
    readonly revision: number;
    run(signal: AbortSignal): Promise<Uint8Array | Blob>;
}
export interface BoardContentSource {
    readonly kind: 'deferred';
    readonly owner: SessionOwner;
    readonly revision: number;
    read(): string | Uint8Array | Blob | BuildJob;
}
export type SaveOutcome = 'written' | 'conflict' | 'failed';

// change-and-history.md §3, H-4: delivered outside apply, at most once per frame.
export interface ChangeNotice {
    readonly rev: number;
    readonly touched: TouchedSet;
    readonly sheetChanged: boolean;
    readonly selectionChanged: boolean;
}

export interface BoardHistory {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    undo(): void;
    redo(): void;
    clearRedo(): void; // R-19: admitted pen/highlighter down, no step or content write.
    open(label: string): void;
    close(): void;
}

// Interface only: the apply/history/save packages supply the single implementation.
export interface BoardSession extends Pick<SessionGestureQueue, 'enqueueAfterGesture' | 'beginGesture' | 'isGestureActive'> {
    readonly owner: SessionOwner;
    readonly doc: BoardDoc;
    readonly samples: SampleStoreReader;
    readonly history: BoardHistory;
    readonly isReadOnly: boolean; // Admission safety OR apply's D-10 seal; save must honor it too.
    apply(transaction: Transaction): Applied;
    begin(origin: TransactionOrigin, label: string): TxBuilder;
    subscribe(listener: (notice: ChangeNotice) => void): () => void;
    hasPendingEdits(): boolean;
    checkpoint(): BoardContentSource;
    acknowledge(revision: number, outcome: SaveOutcome): void;
    drain?(): Promise<void>;
    onChange(listener: (source: BoardContentSource) => void): () => void;
}
