import type { MediaId } from '../model/media';
import type { NodeId, SheetId } from '../model/ids';
import type { SampleRef } from '../model/samples';
import type { Applied, Transaction } from './ops';

export interface TextSelectionSnapshot {
    readonly node: NodeId;
    readonly anchor: number;
    readonly head: number;
}
/** Selection is session state, never part of a document transaction. */
export interface HistorySnapshot {
    readonly sheet: SheetId;
    readonly selected: readonly NodeId[];
    readonly text?: TextSelectionSnapshot;
}
export interface HistoryStepInfo {
    readonly label: string;
    readonly sheet: SheetId;
    readonly touched: ReadonlySet<NodeId>;
    readonly before: HistorySnapshot;
    readonly after: HistorySnapshot;
    readonly bytes: number;
}
export interface HistoryLease { release(): void }
/** All methods are synchronous; history's record callback runs inside apply. */
export interface HistoryPorts {
    snapshot(): HistorySnapshot;
    switchSheet(sheet: SheetId): void;
    nodeExists(id: NodeId): boolean;
    restoreSelection(snapshot: HistorySnapshot): void;
    /** The pane's existing CameraController owns the pan; history stores no camera. */
    revealTouched(ids: ReadonlySet<NodeId>): void;
    /** Undo/redo apply projects media through the session's MediaLocations; rollback stays exact. */
    apply(transaction: Transaction): Applied;
    retainMedia(id: MediaId): HistoryLease;
    retainSample(ref: SampleRef): HistoryLease;
    sampleBytes(ref: SampleRef): number;
    /** The host combines this with the journal-cap notice for one session notice. */
    historyLimitReached(): void;
    reportFailure(error: unknown): void;
    /** False means an IME composition owns undo; close a non-matching text editor here. */
    beforeReplay?(step: HistoryStepInfo, direction: 'undo' | 'redo'): boolean;
}
export interface HistoryController {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    /** Captures sheet and selection before a gesture or command changes the document. */
    open(label: string): void;
    /** The final selection/text caret is captured here. */
    close(): void;
    /** Restore and discard an open non-ink gesture; no older step is undone. */
    cancel(): void;
    /** Pen/highlighter admission clears prior redo immediately (R-19). */
    clearRedo(): void;
    /** Called by the apply consumer, while apply owns the borrowed receipt. */
    record(applied: Applied, transaction: Transaction): void;
    /** A barrier inside an open step; typing rules can undo just their transformation. */
    mark(): number;
    /** Replay and discard only work after a mark, retaining the earlier typing burst. */
    rollbackTo(mark: number): void;
    /** Join a leave-empty deletion to the immediately preceding typing step (WB-D16). */
    reopenLast(): boolean;
    undo(): void;
    redo(): void;
    clear(): void;
    dispose(): void;
}
