import type { BoardDocInput, BoardKind } from '../model/doc';
import type { RawJson } from '../model/json';
import type { NodeId } from '../model/ids';
import type { SampleRef } from '../model/samples';
import type { Bounds, RecordCategory } from './schema';
import type { PointInspectionHeader } from './points';
import type { SavedView } from './encode';

export interface ReadPosition {
    readonly ordinal: number;
    readonly line: number;
    readonly byteOffset: number;
    readonly byteLength: number;
}
export interface ReadIssue {
    readonly code: 'syntax' | 'limit' | 'header' | 'fence' | 'version' | 'kind' | 'points' | 'model' | 'bounds' | 'repair' | 'approximation' | 'io';
    readonly reason: string;
    readonly readOnly: boolean;
    readonly position?: ReadPosition;
}
export interface ReadOptions {
    readonly byteLength?: number;
    readonly signal?: AbortSignal;
    readonly cooperate?: () => Promise<void>;
    readonly expectedKind?: BoardKind;
    readonly pdfPages?: readonly (readonly [number, number])[];
    readonly admitEncoded: (pts: string, header: PointInspectionHeader) => SampleRef;
}
export interface ReadSourceRecord {
    readonly category: RecordCategory;
    readonly type: string;
    readonly id?: string;
    readonly position: ReadPosition;
    readonly nodeBounds?: Bounds;
    readonly reencode: boolean; // Never prime a repaired line as clean original source (RV-6).
}
export interface UnmappedRecord { readonly raw: RawJson; readonly position: ReadPosition; readonly reason: string; }
export interface ReadDraft {
    // NOT an admitted document: W-C5 repairs/validates the ordered arrays before createBoardDoc.
    // In particular createBoardDoc would deduplicate ids, so the reader never calls it.
    readonly input: BoardDocInput;
    readonly sources: readonly ReadSourceRecord[];
    readonly unmapped: readonly UnmappedRecord[];
    readonly coldBounds: ReadonlyMap<NodeId, Bounds>;
    readonly savedView?: SavedView;
}
export interface NativeReadResult {
    readonly format: 'native' | 'empty' | 'other';
    readonly readOnly: boolean;
    readonly draft: ReadDraft | null;
    readonly issues: readonly ReadIssue[];
    readonly issueCount: number;
    readonly recordsSeen: number;
    readonly recordsRecovered: number;
    readonly bytesRead: number;
    readonly complete: boolean;
    readonly reformatted: boolean;
}
export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;
