import type { RecordIntegrity } from './lineTable';
import type { RecordIdentity, WriteRefusal } from './writeTypes';

/** Offsets refer to the exact bytes consumed by the native reader, not a later File read. */
export interface BaselineLine {
    readonly identity: RecordIdentity;
    readonly offset: number;
    readonly length: number;
    readonly revision: number;
}
export interface SerializerPrime {
    readonly revision: number;
    readonly baseline: Blob;
    readonly header: string;
    readonly lines?: readonly BaselineLine[];
    readonly index?: Blob;
    readonly overrides?: readonly SerializerChange[];
}
export interface SerializerChange {
    readonly identity: RecordIdentity;
    readonly revision: number;
    readonly bytes: Uint8Array;
}
export interface SerializerRecordOverride {
    readonly identity: RecordIdentity;
    readonly bytes: Uint8Array;
}
export interface SerializerDelta {
    readonly revision: number;
    readonly previous: number;
    readonly header?: string;
    readonly changed: readonly SerializerChange[];
    readonly removed: readonly RecordIdentity[];
}
export interface SerializerBuild {
    readonly revision: number;
    readonly expected: RecordIntegrity;
    readonly endFields: readonly (readonly [string, string])[];
    readonly overrides?: readonly SerializerRecordOverride[];
}
export interface SerializerProduct {
    readonly revision: number;
    readonly blob: Blob;
    readonly sha256: string;
    readonly index: Blob;
    readonly integrity: RecordIntegrity;
}
export type SerializerReply<T> = { readonly ok: true; readonly value: T; }
    | { readonly ok: false; readonly error: WriteRefusal; };
