// document-model.md §9.3, M-3: preservation is data, never an executable extension.
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

export type ExtBag = JsonObject & { readonly raw?: JsonObject };
