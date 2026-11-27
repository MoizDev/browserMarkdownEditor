export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

declare const rawJsonBrand: unique symbol;
export type RawJson = string & { readonly [rawJsonBrand]: true };

export interface ExtBag {
    readonly fields: ReadonlyMap<string, RawJson>;
    readonly raw: ReadonlyMap<string, RawJson>;
}
