import type { RecoveryMediaAsset } from '../../utils/recoveryCopy';
import type { ExtBag, RawJson } from '../model/json';
import { isSafeMediaFile, type MediaEntry, type MediaId } from '../model/media';
import { encodeMedia } from './encode';
import { parseJsonIncremental, type JsonSpan } from './jsonRead';
import { RecordKeyDigest, type RecordIntegrity } from './lineTable';
import { readNative } from './read';
import { extRawValues, hostRawValues, nodeRawValues, preservedRawValues } from '../model/rawMedia';
import { createSerializerSession } from './serializerClient';
import type { BaselineLine, SerializerChange, SerializerDelta, SerializerPrime, SerializerRecordOverride } from './serializerProtocol';
import { FORMAT_LIMITS } from './schema';
import type { RecordIdentity, StoredRecordCategory } from './writeTypes';
import { yieldToHost } from '../../platform/yieldToHost';

/** A dirty recipe is relative to the pinned parsed-byte baseline, not a live board session. */
export interface BoardRecoveryRecipe {
    readonly version: 1;
    readonly prime: SerializerPrime;
    readonly delta: SerializerDelta | null;
    readonly expected: RecordIntegrity;
    readonly endFields: readonly (readonly [string, string])[];
    readonly retainedMedia: readonly RecoveryMediaAsset[];
    readonly mediaRecords: readonly MediaEntry[];
    /** Snapshot-only existing-row values, e.g. the PDF outer build's exact
     * write mark. They do not change model/content or record-key revisions. */
    readonly overrides?: readonly SerializerRecordOverride[];
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

export function boardRecoveryMedia(payload: unknown): readonly RecoveryMediaAsset[] {
    const recipe = record(payload);
    if (recipe.version !== 1 || !Array.isArray(recipe.retainedMedia)) throw new TypeError('Invalid board recovery media');
    const ids = new Set<string>(), output: RecoveryMediaAsset[] = [];
    for (const value of recipe.retainedMedia) {
        const asset = record(value);
        if (typeof asset.id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(asset.id) || asset.hash !== asset.id.slice(7)
            || typeof asset.extension !== 'string' || !/^[a-z0-9]{1,10}$/.test(asset.extension)
            || !isSafeMediaFile(asset.file) || ids.has(asset.id)) throw new TypeError('Invalid board recovery asset');
        ids.add(asset.id);
        output.push(Object.freeze({ id: asset.id, hash: asset.hash as string, extension: asset.extension, file: asset.file, blob: blob(asset.blob) }));
    }
    return Object.freeze(output);
}

async function* bytesOf(blobValue: Blob): AsyncIterable<Uint8Array> {
    const reader = blobValue.stream().getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } }
    finally { reader.releaseLock(); }
}

// Re-admit only the immutable assembled copy, never the live session. Unknown
// raw JSON may name an old physical file even when its hash remains unchanged.
async function refusePreservedFilenames(board: Blob, names: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    let count = 0, started = performance.now();
    const tick = async () => {
        signal.throwIfAborted(); await yieldToHost();
        signal.throwIfAborted(); count = 0; started = performance.now();
    };
    const due = () => ++count >= 256 || performance.now() - started >= 3;
    const read = await readNative(bytesOf(board), { byteLength: board.size, signal, cooperate: tick, admitEncoded: () => 0 });
    signal.throwIfAborted();
    if (!read.complete || read.readOnly || !read.draft || read.draft.unmapped.length) {
        throw new Error('Cannot safely inspect preserved recovery references');
    }
    const matches = (value: string) => {
        for (const name of names) if (value === name || value === `.Assets/${name}` || value.endsWith(`/.Assets/${name}`)) return true;
        return false;
    };
    const inspect = async (raw: RawJson) => {
        const root = await parseJsonIncremental(raw, tick), stack: JsonSpan[] = [root];
        while (stack.length) {
            if (due()) await tick();
            const span = stack.pop()!;
            if (span.kind === 'string') {
                // A larger opaque string cannot be certified as independent of a
                // nested physical path without retaining an unbounded copy.
                if (span.stringLength(4096) > 4096) throw new Error('Preserved recovery string is too long to inspect safely');
                if (matches(await span.stringIncremental(4096, tick))) throw new Error('Preserved content refers to a media filename that must be renamed');
            } else if (span.kind === 'array') {
                for await (const item of span.itemsIncremental(tick)) { if (due()) await tick(); stack.push(item); }
            } else if (span.kind === 'object') {
                for await (const [key, item] of span.fieldsIncremental(tick)) {
                    if (due()) await tick();
                    if (matches(key)) throw new Error('Preserved content refers to a media filename that must be renamed');
                    stack.push(item);
                }
            }
        }
    };
    const scan = async (raws: Iterable<RawJson | null>) => {
        for (const raw of raws) { if (due()) await tick(); if (raw !== null) await inspect(raw); }
    };
    const input = read.draft.input;
    await scan(preservedRawValues(input.preserved)); await scan(hostRawValues(input.host));
    await scan(extRawValues(input.ui.ext)); await scan(extRawValues(input.view.ext));
    for (const sheet of input.sheets) { if (due()) await tick(); await scan(extRawValues(sheet.ext)); }
    for (const media of input.media ?? []) { if (due()) await tick(); await scan(extRawValues(media.ext)); }
    for (const node of input.nodes ?? []) { if (due()) await tick(); await scan(nodeRawValues(node)); }
    signal.throwIfAborted();
}

async function remapRecoveryMedia(baseline: Blob, index: Blob, header: string, baseRevision: number,
    expected: RecordIntegrity, end: ExtBag, remaps: ReadonlyMap<string, MediaEntry>, signal: AbortSignal): Promise<Blob> {
    const digest = new RecordKeyDigest(), originalDigest = new RecordKeyDigest(), overrides: SerializerChange[] = [], seen = new Set<string>();
    const reader = index.stream().getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', count = 0, started = performance.now();
    const tick = async () => { signal.throwIfAborted(); await yieldToHost(); signal.throwIfAborted(); started = performance.now(); count = 0; };
    try {
        for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            pending += decoder.decode(part.value, { stream: !part.done });
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
                if (!line || line.length > 4096) throw new TypeError('Invalid recovery record index');
                const item = record(JSON.parse(line)), id = identity(item.identity), before = revision(item.revision);
                const key = JSON.stringify([id.type, id.id ?? null]);
                if (seen.has(key)) throw new TypeError('Duplicate recovery record index');
                seen.add(key);
                const initial = digest.replace(id, null, before), original = originalDigest.replace(id, null, before);
                if (!initial.ok) throw new Error(initial.error.reason);
                if (!original.ok) throw new Error(original.error.reason);
                if (id.category === 'media' && id.id && remaps.has(id.id)) {
                    const encoded = encodeMedia(remaps.get(id.id)!);
                    if (!encoded.ok) throw new Error(encoded.error.reason);
                    const updated = digest.replace(id, before, baseRevision);
                    if (!updated.ok) throw new Error(updated.error.reason);
                    overrides.push({ identity: id, revision: baseRevision, bytes: new TextEncoder().encode(encoded.value.text) });
                }
                if (++count >= 256 || performance.now() - started >= 3) await tick();
            }
            if (pending.length > 4096) throw new TypeError('Invalid recovery record index');
            if (part.done) break;
        }
    } finally { reader.releaseLock(); }
    if (pending) throw new TypeError('Truncated recovery record index');
    const original = originalDigest.snapshot();
    if (original.count !== expected.count || original.digest !== expected.digest) throw new Error('Recovery record index integrity mismatch');
    // This digest reflects only the explicit media-record revision replacements above.
    if (!overrides.length) return baseline;
    const next = digest.snapshot();
    if (next.count !== expected.count) throw new Error('Recovery record count changed during remap');
    const session = createSerializerSession({ revision: baseRevision, baseline, index, header, overrides }, () => {});
    try {
        const result = await session.checkpoint(next, end).build(signal);
        signal.throwIfAborted();
        if (!(result instanceof Blob) || (typeof File !== 'undefined' && result instanceof File)) throw new TypeError('Invalid remapped board copy');
        return result;
    } finally { session.dispose(); }
}

export async function materializeBoardRecoveryRecipe(payload: unknown, signal: AbortSignal, mediaFiles?: ReadonlyMap<string, string>): Promise<Blob> {
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
    let overrides: SerializerChange[] | undefined;
    if (source.overrides !== undefined) {
        if (!Array.isArray(source.overrides)) throw new TypeError('Invalid recovery baseline overrides');
        overrides = [];
        for (const value of source.overrides) {
            signal.throwIfAborted();
            const change = record(value);
            if (!(change.bytes instanceof Uint8Array) || revision(change.revision) !== baseRevision) throw new TypeError('Invalid recovery baseline override');
            overrides.push({ identity: identity(change.identity), revision: baseRevision, bytes: change.bytes.slice() });
        }
    }
    const prime: SerializerPrime = { revision: baseRevision, baseline, header: source.header,
        ...(lines ? { lines } : { index: blob(source.index) }), ...(overrides ? { overrides } : {}) };
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
    const assets = boardRecoveryMedia(payload), assetsById = new Map(assets.map(asset => [asset.id, asset]));
    if (!Array.isArray(recipe.mediaRecords)) throw new TypeError('Invalid recovery media records');
    const metadata = new Map<string, MediaEntry>();
    for (const value of recipe.mediaRecords) {
        const entry = record(value), id = entry.id;
        if (typeof id !== 'string' || !assetsById.has(id) || metadata.has(id) || !isSafeMediaFile(entry.file)
            || typeof entry.mime !== 'string' || typeof entry.name !== 'string' || typeof entry.animated !== 'boolean'
            || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
            || typeof entry.w !== 'number' || !Number.isFinite(entry.w) || typeof entry.h !== 'number' || !Number.isFinite(entry.h)
            || !(entry.duration === null || (typeof entry.duration === 'number' && Number.isFinite(entry.duration)))) throw new TypeError('Invalid recovery media metadata');
        let ext: ExtBag | null = null;
        if (entry.ext !== null) {
            const bag = record(entry.ext);
            if (!(bag.fields instanceof Map) || !(bag.raw instanceof Map)) throw new TypeError('Invalid recovery media extension');
            const read = (map: Map<unknown, unknown>) => {
                const copy = new Map<string, RawJson>();
                for (const [key, raw] of map) {
                    if (typeof key !== 'string' || typeof raw !== 'string') throw new TypeError('Invalid recovery media extension');
                    copy.set(key, raw as RawJson);
                }
                return copy;
            };
            ext = { fields: read(bag.fields), raw: read(bag.raw) };
        }
        metadata.set(id, { id: id as MediaId, mime: entry.mime, name: entry.name, animated: entry.animated,
            bytes: entry.bytes, w: entry.w, h: entry.h, duration: entry.duration as number | null, file: entry.file, ext });
    }
    const remaps = new Map<string, MediaEntry>(), oldNames = new Set<string>();
    if (mediaFiles) for (const [id, file] of mediaFiles) {
        signal.throwIfAborted();
        const asset = assetsById.get(id);
        if (!asset || !isSafeMediaFile(file) || file === null) throw new TypeError('Invalid recovered media filename');
        const oldPhysical = asset.file ?? `${asset.hash}.${asset.extension}`;
        if (file !== oldPhysical) oldNames.add(oldPhysical);
        const entry = metadata.get(id);
        if (!entry || file === (entry.file ?? `${asset.hash}.${asset.extension}`)) continue;
        oldNames.add(entry.file ?? `${asset.hash}.${asset.extension}`);
        // Unknown raw data is never rewritten. A preserved raw file field cannot
        // be overridden by a known-field remap without silently losing content.
        if (entry.ext?.raw.has('file')) throw new Error(`Preserved media filename prevents recovery remap for ${id}`);
        remaps.set(id, { ...entry, file });
    }
    let capturedOverrides: SerializerRecordOverride[] | undefined;
    if (recipe.overrides !== undefined) {
        if (!Array.isArray(recipe.overrides) || recipe.overrides.length > FORMAT_LIMITS.records) throw new TypeError('Invalid recovery snapshot overrides');
        capturedOverrides = [];
        const seen = new Set<string>();
        let bytes = 0;
        for (const value of recipe.overrides) {
            signal.throwIfAborted();
            const override = record(value);
            if (Object.keys(override).some(key => key !== 'identity' && key !== 'bytes') || !(override.bytes instanceof Uint8Array)
                || override.bytes.byteLength < 2 || override.bytes.byteLength > FORMAT_LIMITS.recordBytes) throw new TypeError('Invalid recovery snapshot override');
            const key = identity(override.identity), token = `${key.category}\u0000${key.type}\u0000${key.id ?? ''}`;
            bytes += override.bytes.byteLength;
            if (seen.has(token) || bytes > FORMAT_LIMITS.fileBytes) throw new TypeError('Duplicate or oversized recovery snapshot overrides');
            seen.add(token);
            capturedOverrides.push({ identity: key, bytes: override.bytes.slice() });
            if ((capturedOverrides.length & 127) === 0) { await yieldToHost(); signal.throwIfAborted(); }
        }
    }
    const session = createSerializerSession(prime, () => { /* build observes serializer failures */ });
    try {
        session.update(delta);
        const checkpoint = session.checkpoint(integrity, end, capturedOverrides);
        const result = await checkpoint.build(signal);
        signal.throwIfAborted();
        if (!(result instanceof Blob) || (typeof File !== 'undefined' && result instanceof File)) throw new TypeError('Invalid recovered board bytes');
        if (!remaps.size && !oldNames.size) return result;
        const product = checkpoint.product();
        if (!product) throw new Error('Recovered board index unavailable');
        if (oldNames.size) await refusePreservedFilenames(product.blob, oldNames, signal);
        if (!remaps.size) return result;
        return await remapRecoveryMedia(product.blob, product.index, delta.header ?? prime.header, nextRevision, integrity, end, remaps, signal);
    } finally { session.dispose(); }
}
