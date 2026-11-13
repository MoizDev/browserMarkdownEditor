// document-model.md §9.3, M-3: preservation is data, never an executable extension.
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

// R-W17: only the native reader brands a validated source slice. Consumers keep
// it opaque and emit it verbatim, never parse/re-stringify unknown values.
declare const rawJsonBrand: unique symbol;
export type RawJson = string & { readonly [rawJsonBrand]: true };

export interface ExtBag {
    readonly fields: ReadonlyMap<string, RawJson>; // Unknown top-level properties of this record.
    readonly raw: ReadonlyMap<string, RawJson>; // Whole known-property values with unknown nested data (R-W20).
}
