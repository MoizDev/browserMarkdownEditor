import type { SourceOwner } from '../../utils/documentBuffers';
import type { SessionAdapter } from '../../utils/documentSessions';
import type { JournalCapture } from '../../utils/recoveryFunnel';
import type { Applied, TouchedSet, Transaction } from '../change/ops';
import type { ChangeGeometry } from '../change/coordinates';
import type { HistoryController, HistorySnapshot, HistoryStepInfo } from '../change/historyTypes';
import type { NoticeDispatcher } from '../change/notices';
import type { EncoderContext } from '../format/encode';
import type { RecordChanges } from '../format/recordChanges';
import type { SerializerCheckpoint, SerializerSession } from '../format/serializerClient';
import type { MediaStore } from '../media/store';
import type { BoardDoc } from '../model/doc';
import type { NodeId } from '../model/ids';
import type { MediaId } from '../model/media';
import type { SampleStoreReader } from '../model/samples';
import type { SelectionState } from '../selection';
import type { PinnedBoardBuild } from './contentSource';
import type { BoardSession } from './BoardSession';

/** Recovery owns its journal transport and retained media/sample payloads; callbacks are synchronous
 * until the returned append or drain, so pagehide captures a fixed revision without waiting. */
export interface BoardJournalPort {
    record(applied: Applied, revision: number): void;
    capture(): () => void | Promise<void>;
    delta(): JournalCapture | undefined;
    recover(payload: unknown, apply: (transaction: Transaction) => Applied): void | Promise<void>;
    acknowledge(revision: number): void;
    drain(): Promise<void>;
    dispose(): void;
}
export interface BoardSessionFactoryOptions {
    readonly owner: SourceOwner;
    readonly doc: BoardDoc;
    readonly samples: SampleStoreReader;
    readonly media: MediaStore;
    readonly selection: SelectionState;
    readonly notices: NoticeDispatcher;
    readonly serializer: SerializerSession;
    readonly records: RecordChanges;
    readonly encoder: EncoderContext;
    readonly journal: BoardJournalPort;
    readonly geometry?: ChangeGeometry;
    readonly isCurrent: (owner: SourceOwner) => boolean;
    readonly readOnlyReason: () => string | null;
    readonly sceneChanged: (applied: Applied, impacts: ReadonlyMap<NodeId, number>) => void;
    readonly historySnapshot: () => HistorySnapshot;
    readonly restoreHistorySelection: (snapshot: HistorySnapshot) => void;
    readonly beforeHistoryReplay?: (step: HistoryStepInfo, direction: 'undo' | 'redo') => boolean;
    readonly revealTouched: (nodes: ReadonlySet<NodeId>) => void;
    readonly historyLimitReached: () => void;
    readonly finishGesture: () => void;
    readonly finishComposition: () => void;
    /** Pin media restoration and, for PDF ink, display lists against the same revision synchronously. */
    readonly pinBuild: (base: SerializerCheckpoint, revision: number) => PinnedBoardBuild;
    readonly onFailure: (error: unknown) => void;
}

/** O(changed) record-set union; the factory owns the mutable instance. */
export interface PendingRecordChanges {
    readonly touched: TouchedSet;
    readonly revision: number;
}
export type ComposedBoardSession = BoardSession & SessionAdapter & {
    readonly history: HistoryController;
    readonly readOnlyReason: string | null;
    mediaReferences(): readonly string[];
    mediaReferenceIssues(): readonly MediaId[];
    flushNow(): void;
    pageHide(): void;
    hidden(): void;
    setComposition(active: boolean): void;
    dispose(): void;
};
export type CreateBoardSession = (options: BoardSessionFactoryOptions) => ComposedBoardSession;
