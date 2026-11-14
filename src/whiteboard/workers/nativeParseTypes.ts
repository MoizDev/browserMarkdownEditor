import type { Bounds } from '../format/schema';
import type { ReadIssue, ReadSourceRecord, UnmappedRecord } from '../format/readTypes';
import type { SavedView } from '../format/encode';
import type { BoardKind } from '../model/doc';
import type { JsonObject } from '../model/json';
import type { LoadSampleWire } from '../model/loadTypes';

/** The Blob is copied from opened bytes, never a disk-backed File. */
export interface ParseNativeRequest {
    readonly bytes: Blob;
    readonly expectedKind?: BoardKind;
    readonly pdfPages?: readonly (readonly [number, number])[];
}
/** Unrepaired, non-authoritative worker data; only C5 repair can admit it to a session. */
export interface ParsedNativeDraft {
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
    readonly unmapped: readonly UnmappedRecord[];
    readonly coldBounds: readonly (readonly [string, Bounds])[];
    readonly savedView?: SavedView;
}
export interface ParseNativeReply {
    readonly format: 'native' | 'empty' | 'other';
    readonly readOnly: boolean;
    readonly draft: ParsedNativeDraft | null;
    readonly issues: readonly ReadIssue[];
    readonly issueCount: number;
    readonly recordsSeen: number;
    readonly recordsRecovered: number;
    readonly bytesRead: number;
    readonly complete: boolean;
    readonly reformatted: boolean;
}
