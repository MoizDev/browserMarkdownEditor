import type { BoardKind } from '../model/doc';
import type { JsonObject, JsonValue } from '../model/json';

// The worker sends no Map, model instance or sample lease across this boundary.
export interface LegacySampleDTO {
    readonly workerRef: number;
    readonly pts: string;
    readonly header: {
        readonly count: number;
        readonly k: number;
        readonly hasPressure: boolean;
        readonly runCount: number;
        readonly localBounds: readonly [number, number, number, number];
        readonly maxPressure: number | null;
    };
}
export interface LegacyImportDTO {
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
    readonly samples: readonly LegacySampleDTO[];
    readonly repairs: readonly JsonObject[];
    readonly unrepresentable: readonly JsonObject[];
    readonly counts: JsonObject;
    readonly converted: false;
}
export interface LegacyAdmissionPort {
    // SEC-W1 validates an inert DTO and issues a one-shot, job-bound capability.
    prepare(value: unknown): { readonly ok: true; readonly token: object } | { readonly ok: false; readonly reason: string };
    take(token: object): JsonValue;
}
