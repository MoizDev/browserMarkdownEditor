// Native-format §3.6, F-10. Fact source: formats/corpus/received/failure-results.json
// (newer-schema/newer-sequences refuse; empty-object/malformed did not protect content).
// Data only: no package constructs or validates this stub, and no user content belongs in it.
export const COMPATIBILITY_FENCE = 'compat-1' as const;
export const FENCE_SCHEMA_VERSION = 999;
const STUB = '{"document":{"schema":{"schemaVersion":999},"store":{}},"fence":"compat-1"}';

export interface FenceDocument { readonly schema: { readonly schemaVersion: 999; }; readonly store: Record<string, never>; }
export function fenceDocument(): FenceDocument {
    return { schema: { schemaVersion: 999 }, store: {} };
}
export function fenceBytes(): Uint8Array {
    // A fresh array prevents a PDF attachment consumer from corrupting the next save's fence.
    return new TextEncoder().encode(STUB);
}
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function own(value: Record<string, unknown>, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
export function isCompatibilityFence(value: unknown): boolean {
    // Do not misclassify an envelope carrying paper, native records or future content as an inert stub.
    if (!object(value) || Object.keys(value).length !== 2 || own(value, 'fence') !== COMPATIBILITY_FENCE) return false;
    const document = own(value, 'document');
    if (!object(document) || Object.keys(document).length !== 2) return false;
    const schema = own(document, 'schema'), store = own(document, 'store');
    return object(schema) && Object.keys(schema).length === 1 && own(schema, 'schemaVersion') === FENCE_SCHEMA_VERSION
        && object(store) && Object.keys(store).length === 0;
}
export function isCompatibilityFenceBytes(bytes: Uint8Array): boolean {
    if (bytes.byteLength !== STUB.length) return false;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== STUB.charCodeAt(i)) return false;
    return true;
}
