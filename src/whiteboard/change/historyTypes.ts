import type { MediaId } from '../model/media';
import type { NodeId, ParentId, SheetId } from '../model/ids';
import type { SampleRef } from '../model/samples';
import type { Applied, Transaction } from './ops';

export interface TextSelectionSnapshot {
    readonly node: NodeId;
    readonly anchor: number;
    readonly head: number;
}
export interface HistorySnapshot {
    readonly sheet: SheetId;
    readonly focus: ParentId;
    readonly selected: readonly NodeId[];
    readonly active: NodeId | null;
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
export interface HistoryPorts {
    snapshot(): HistorySnapshot;
    switchSheet(sheet: SheetId): void;
    sheetExists(sheet: SheetId): boolean;
    nodeExists(id: NodeId): boolean;
    restoreSelection(snapshot: HistorySnapshot): void;
    revealTouched(ids: ReadonlySet<NodeId>): void;
    apply(transaction: Transaction): Applied;
    revert(receipts: readonly Applied[]): Applied;
    retainMedia(id: MediaId): HistoryLease;
    retainSample(ref: SampleRef): HistoryLease;
    sampleBytes(ref: SampleRef): number;
    historyLimitReached(): void;
    reportFailure(error: unknown): void;
    beforeReplay?(step: HistoryStepInfo, direction: 'undo' | 'redo'): boolean;
}
export interface HistoryController {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly isOpen: boolean;
    open(label: string): void;
    close(): number | null;
    cancel(): void;
    clearRedo(): void;
    record(applied: Applied, transaction: Transaction): void;
    mark(): number;
    rollbackTo(mark: number): void;
    reopenLast(expected: number): boolean;
    forgetCreatedNode(node: NodeId, creationToken: number, ownedStepTokens: readonly number[]): boolean;
    undo(): void;
    redo(): void;
    clear(): void;
    dispose(): void;
}
