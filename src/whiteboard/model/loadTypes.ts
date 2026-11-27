import type { PointInspectionHeader } from '../format/points';
import type { ReadIssue, ReadSourceRecord, UnmappedRecord } from '../format/readTypes';
import type { SavedView } from '../format/encode';
import type { BoardDoc, BoardDocInput, BoardKind } from './doc';
import type { JsonObject } from './json';
import type { NodeRecord } from './nodes';
import type { SampleLease, SampleRef, SampleStoreReader } from './samples';

export interface LoadRepairDraft {
    readonly input: BoardDocInput;
    readonly sources: readonly ReadSourceRecord[];
    readonly unmapped: readonly UnmappedRecord[];
    readonly removedSources?: readonly ReadSourceRecord[];
    readonly savedView?: SavedView;
}
export interface LoadRepairOptions {
    readonly samples: SampleStoreReader;
    readonly newId: () => string;
    readonly sampleWire: (ref: SampleRef) => LoadSampleWire;
    readonly rootPlacement: (node: NodeRecord, sheetId: string, sourceOrdinal: number) => { readonly page: number; readonly x: number; readonly y: number };
    readonly cooperate?: () => Promise<void>;
    readonly signal?: AbortSignal;
}
export interface LoadRepairNotice {
    readonly code: string;
    readonly count: number;
    readonly nodeIds: readonly string[];
}
export interface LoadSampleWire {
    readonly workerRef: SampleRef;
    readonly pts: string;
    readonly header: PointInspectionHeader;
}
export interface LoadProjection {
    readonly version: 1;
    readonly kind: BoardKind;
    readonly sheets: readonly JsonObject[];
    readonly nodes: readonly JsonObject[];
    readonly media: readonly JsonObject[];
    readonly ui: JsonObject;
    readonly view: JsonObject;
    readonly host: JsonObject;
    readonly preserved: JsonObject;
    readonly preservedMediaRefs: readonly (readonly [string, number])[];
    readonly samples: readonly LoadSampleWire[];
    readonly sources: readonly ReadSourceRecord[];
    readonly removedSources?: readonly ReadSourceRecord[];
    readonly unmapped: readonly UnmappedRecord[];
    readonly savedView?: SavedView;
}
export interface LoadRepairResult {
    readonly status: 'editable' | 'read-only';
    readonly projection: LoadProjection | null;
    readonly repairs: readonly LoadRepairNotice[];
    readonly issues: readonly ReadIssue[];
}
export interface RehydratedLoad {
    readonly input: BoardDocInput;
    readonly doc: BoardDoc;
    readonly sources: readonly ReadSourceRecord[];
    readonly removedSources: readonly ReadSourceRecord[];
    readonly unmapped: readonly UnmappedRecord[];
    readonly savedView?: SavedView;
    readonly leases: readonly SampleLease[];
    release(): void;
}
export interface LoadRepairPort {
    repair(draft: LoadRepairDraft, options: LoadRepairOptions): Promise<LoadRepairResult>;
    rehydrate(projection: LoadProjection, admit: (pts: string, header: PointInspectionHeader) => SampleLease,
        samples: SampleStoreReader, cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<RehydratedLoad>;
}
