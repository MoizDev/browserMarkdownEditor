import type { ExtBag, RawJson } from '../model/json';
import type { RecordIntegrity } from './lineTable';
import { createSerializerSession } from './serializerClient';
import type { BaselineLine, SerializerChange, SerializerDelta, SerializerPrime } from './serializerProtocol';
import type { RecordIdentity, StoredRecordCategory } from './writeTypes';

/** A dirty recipe is relative to the pinned parsed-byte baseline, not a live board session. */
export interface BoardRecoveryRecipe {
    readonly version: 1;
    readonly prime: SerializerPrime;
    readonly delta: SerializerDelta | null;
    readonly expected: RecordIntegrity;
    readonly endFields: readonly (readonly [string, string])[];
}

const categories = new Set(['pen', 'view', 'paper', 'host', 'media', 'sheet', 'node', 'opaque']);
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError('Invalid board recovery recipe');
    return value as Record<string, unknown>;
}
function revision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid recovery revision');
    return value;
}
function blob(value: unknown): Blob {
    if (!(value instanceof Blob) || (typeof File !== 'undefined' && value instanceof File)) throw new TypeError('Recovery baseline must be a Blob, not a File');
    return value;
}
function identity(value: unknown): RecordIdentity {
    const input = record(value);
    if (typeof input.category !== 'string' || !categories.has(input.category) || typeof input.type !== 'string'
        || (input.id !== undefined && typeof input.id !== 'string')) throw new TypeError('Invalid recovery record identity');
    return { category: input.category as StoredRecordCategory, type: input.type, ...(input.id === undefined ? {} : { id: input.id }) };
}

export async function materializeBoardRecoveryRecipe(payload: unknown, signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted();
    const recipe = record(payload);
    if (recipe.version !== 1) throw new TypeError('Unsupported board recovery recipe');
    const source = record(recipe.prime), baseRevision = revision(source.revision);
    if (typeof source.header !== 'string') throw new TypeError('Invalid recovery header');
    const baseline = blob(source.baseline);
    if ((source.lines === undefined) === (source.index === undefined)) throw new TypeError('Recovery requires exactly one baseline index');
    let lines: BaselineLine[] | undefined;
    if (source.lines !== undefined) {
        if (!Array.isArray(source.lines)) throw new TypeError('Invalid recovery baseline lines');
        lines = [];
        for (const value of source.lines) {
            signal.throwIfAborted();
            const line = record(value), offset = revision(line.offset), length = revision(line.length);
            if (offset + length > baseline.size) throw new TypeError('Invalid recovery baseline line range');
            lines.push({ identity: identity(line.identity), offset, length, revision: revision(line.revision) });
        }
    }
    const prime: SerializerPrime = { revision: baseRevision, baseline, header: source.header,
        ...(lines ? { lines } : { index: blob(source.index) }) };
    // A baseline alone is not evidence of the unsaved revision.
    if (recipe.delta === null || recipe.delta === undefined) throw new TypeError('Dirty board recovery requires a cumulative delta');
    const rawDelta = record(recipe.delta), nextRevision = revision(rawDelta.revision);
    if (revision(rawDelta.previous) !== baseRevision || nextRevision <= baseRevision
        || (rawDelta.header !== undefined && typeof rawDelta.header !== 'string')
        || !Array.isArray(rawDelta.changed) || !Array.isArray(rawDelta.removed)) throw new TypeError('Invalid cumulative recovery delta');
    const changed: SerializerChange[] = [];
    for (const value of rawDelta.changed) {
        signal.throwIfAborted();
        const change = record(value);
        if (!(change.bytes instanceof Uint8Array)) throw new TypeError('Invalid recovery record bytes');
        changed.push({ identity: identity(change.identity), revision: revision(change.revision), bytes: change.bytes.slice() });
    }
    const removed: RecordIdentity[] = [];
    for (const value of rawDelta.removed) { signal.throwIfAborted(); removed.push(identity(value)); }
    const delta: SerializerDelta = { revision: nextRevision, previous: baseRevision, changed, removed,
        ...(rawDelta.header === undefined ? {} : { header: rawDelta.header as string }) };
    const expected = record(recipe.expected);
    if (typeof expected.digest !== 'string' || !/^[0-9a-f]{32}$/.test(expected.digest)) throw new TypeError('Invalid recovery integrity');
    const integrity: RecordIntegrity = { count: revision(expected.count), digest: expected.digest };
    if (!Array.isArray(recipe.endFields)) throw new TypeError('Invalid recovery footer');
    const fields = new Map<string, RawJson>();
    for (const entry of recipe.endFields) {
        signal.throwIfAborted();
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
            || fields.has(entry[0])) throw new TypeError('Invalid recovery footer field');
        fields.set(entry[0], entry[1] as RawJson);
    }
    const end: ExtBag = { fields, raw: new Map() };
    const session = createSerializerSession(prime, () => { /* build observes serializer failures */ });
    try {
        session.update(delta);
        const checkpoint = session.checkpoint(integrity, end);
        const result = await checkpoint.build(signal);
        signal.throwIfAborted();
        if (!(result instanceof Blob) || (typeof File !== 'undefined' && result instanceof File)) throw new TypeError('Invalid recovered board bytes');
        return result;
    } finally { session.dispose(); }
}
