import type { JournalCapture } from '../../utils/recoveryFunnel';
import type { RecoveryMediaAsset } from '../../utils/recoveryCopy';
import type { Applied } from '../change/ops';
import { encodeHeader } from '../format/encode';
import type { EncoderContext } from '../format/encode';
import { RecordChanges } from '../format/recordChanges';
import type { RecordVersion } from '../format/recordChanges';
import type { BoardRecoveryRecipe } from '../format/recoveryRecipe';
import type { SerializerChange, SerializerPrime } from '../format/serializerProtocol';
import { recordKey } from '../format/writeTypes';
import type { RecordIdentity } from '../format/writeTypes';
import type { BoardDoc } from '../model/doc';
import { isSafeMediaFile, type MediaEntry, type MediaId } from '../model/media';

// Provenance: C-20 journal capture, serializer delta/integrity and media lease
// contracts; independently implemented, no third-party source.
type Dirty = { readonly revision: number; readonly change: SerializerChange | null; readonly identity: RecordIdentity };
type Hold = { path: string | null; readonly lease?: { release(): void }; asset?: RecoveryMediaAsset };
function copyPrime(prime: SerializerPrime): SerializerPrime {
    if (!Number.isSafeInteger(prime.revision) || prime.revision < 0 || !(prime.baseline instanceof Blob)
        || (typeof File !== 'undefined' && prime.baseline instanceof File) || typeof prime.header !== 'string'
        || (prime.lines === undefined) === (prime.index === undefined)) throw new TypeError('Invalid recovery baseline');
    if (prime.index !== undefined && (!(prime.index instanceof Blob) || (typeof File !== 'undefined' && prime.index instanceof File))) throw new TypeError('Invalid recovery index');
    return { revision: prime.revision, baseline: prime.baseline, header: prime.header,
        ...(prime.lines ? { lines: prime.lines.map(line => ({ ...line, identity: { ...line.identity } })) } : { index: prime.index! }),
        ...(prime.overrides ? { overrides: prime.overrides.map(change => ({ identity: { ...change.identity }, revision: change.revision, bytes: change.bytes.slice() })) } : {}) };
}

export function createBoardRecoveryCapture(options: {
    baseline: SerializerPrime; doc: BoardDoc; encoder: EncoderContext; records: Iterable<RecordVersion>;
    representation: 'drawing' | 'notebook'; mediaPath: (id: MediaId) => string | null;
    mediaAsset: (id: MediaId) => RecoveryMediaAsset | undefined;
    retainMedia?: (id: MediaId) => { release(): void };
}): { record(applied: Applied, revision: number): void; capture(): JournalCapture | undefined;
    acknowledge(revision: number, baseline?: SerializerPrime): void; dispose(): void } {
    const { doc } = options;
    if ((options.representation === 'drawing' && doc.kind !== 'whiteboard')
        || (options.representation === 'notebook' && doc.kind !== 'notebook')) throw new TypeError('Recovery representation does not match board');
    let prime = copyPrime(options.baseline), current = prime.revision;
    const records = new RecordChanges(current, options.records);
    let dirty = new Map<string, Dirty>();
    const held = new Map<MediaId, Hold>();
    let cached: JournalCapture | undefined, disposed = false, failure: unknown, failed = false;
    const assertOpen = () => { if (disposed) throw new Error('Recovery capture disposed'); };
    const copyAsset = (id: MediaId, source: RecoveryMediaAsset): RecoveryMediaAsset => {
        if (source.id !== id || source.hash !== id.slice(7) || !/^[0-9a-f]{64}$/.test(source.hash)
            || !/^[a-z0-9]{1,10}$/.test(source.extension) || !isSafeMediaFile(source.file) || !(source.blob instanceof Blob)) {
            throw new Error(`Recovery media bytes unavailable for ${id}`);
        }
        return Object.freeze({ id, hash: source.hash, extension: source.extension, file: source.file,
            blob: source.blob.slice(0, source.blob.size, source.blob.type) });
    };
    const hold = (id: MediaId, added: MediaId[]) => {
        const path = options.mediaPath(id);
        const old = held.get(id);
        if (old) {
            if (path) old.path = path;
            const source = options.mediaAsset(id);
            if (source) old.asset = copyAsset(id, source);
            return;
        }
        const lease = options.retainMedia?.(id);
        try {
            const source = options.mediaAsset(id);
            held.set(id, { path, lease, ...(source ? { asset: copyAsset(id, source) } : {}) }); added.push(id);
        } catch (error) { try { lease?.release(); } catch { /* retain/capture failure is primary */ } throw error; }
    };
    const unhold = (ids: readonly MediaId[]) => {
        for (const id of ids) { const entry = held.get(id); held.delete(id); entry?.lease?.release(); }
    };
    const initial: MediaId[] = [];
    try {
        for (const [id, refs] of doc.mediaRefs) if (refs.size) hold(id, initial);
        for (const [id, count] of doc.preservedMediaRefs) if (count > 0) hold(id, initial);
    } catch (error) { unhold(initial); throw error; }
    const snapshot = (nextPrime: SerializerPrime, revision: number, items: ReadonlyMap<string, Dirty>, header: string,
        expected: ReturnType<RecordChanges['integrity']>): JournalCapture | undefined => {
        if (revision <= nextPrime.revision) return undefined;
        const changed: SerializerChange[] = [], removed: RecordIdentity[] = [];
        for (const item of items.values()) { if (item.change) changed.push(item.change); else removed.push(item.identity); }
        const endFields = [...(doc.preserved.end?.fields ?? [])].map(([key, value]) => [key, value] as const);
        const retainedMedia: RecoveryMediaAsset[] = [], mediaRecords: MediaEntry[] = [], mediaRefs: string[] = [];
        for (const [id, hold] of held) {
            const source = options.mediaAsset(id) ?? hold.asset;
            if (!source) throw new Error(`Recovery media bytes unavailable for ${id}`);
            const path = options.mediaPath(id) ?? hold.path;
            if (!path) throw new Error(`Recovery media path unavailable for ${id}`);
            const asset = copyAsset(id, source);
            hold.asset = asset; hold.path = path; retainedMedia.push(asset); mediaRefs.push(path);
            const entry = doc.media.get(id);
            if (entry) mediaRecords.push({ ...entry, ext: entry.ext ? { fields: new Map(entry.ext.fields), raw: new Map(entry.ext.raw) } : null });
        }
        const recipe: BoardRecoveryRecipe = { version: 1, prime: nextPrime,
            delta: { previous: nextPrime.revision, revision, header, changed, removed }, expected, endFields,
            retainedMedia: Object.freeze(retainedMedia), mediaRecords: Object.freeze(mediaRecords) };
        return { payload: recipe, copy: { kind: 'recipe', payload: recipe }, mediaRefs };
    };
    let header = prime.header;
    return {
        record(applied, revision) {
            assertOpen();
            if (failed) throw failure;
            cached = undefined;
            const encodedHeader = encodeHeader(doc.kind, doc.preserved);
            if (!encodedHeader.ok) { failed = true; failure = new Error(encodedHeader.error.reason); throw failure; }
            const encoded = records.encode(doc, applied.touched, options.encoder, revision, encodedHeader.value);
            if (!encoded.ok) { failed = true; failure = new Error(encoded.error.reason); throw failure; }
            const next = new Map(dirty), added: MediaId[] = [];
            for (const change of encoded.value.delta.changed) next.set(recordKey(change.identity), { revision, identity: change.identity, change });
            for (const identity of encoded.value.delta.removed) next.set(recordKey(identity), { revision, identity, change: null });
            try {
                for (const id of applied.touched.media) {
                    if (held.has(id) || doc.mediaRefs.get(id)?.size || (doc.preservedMediaRefs.get(id) ?? 0) > 0) hold(id, added);
                }
            } catch (error) { unhold(added); failed = true; failure = error; throw error; }
            encoded.value.commit();
            dirty = next; current = revision; header = encodedHeader.value;
            try { cached = snapshot(prime, revision, next, header, encoded.value.expected); failure = undefined; }
            catch (error) { failure = error; throw error; }
        },
        capture() {
            assertOpen();
            if (failed) throw failure;
            if (!cached && current > prime.revision) {
                try { cached = snapshot(prime, current, dirty, header, records.integrity()); failure = undefined; }
                catch (error) { failure = error; throw error; }
            }
            return cached;
        },
        acknowledge(revision, baseline) {
            assertOpen();
            if (!Number.isSafeInteger(revision) || revision < prime.revision || revision > current) throw new RangeError('Invalid acknowledged revision');
            if (!baseline) return;
            const nextPrime = copyPrime(baseline);
            if (nextPrime.revision !== revision) throw new RangeError('Acknowledged baseline revision mismatch');
            const next = new Map<string, Dirty>();
            for (const [key, item] of dirty) if (item.revision > revision) next.set(key, item);
            const capture = snapshot(nextPrime, current, next, header, records.integrity());
            prime = nextPrime; dirty = next; cached = capture;
        },
        dispose() {
            if (disposed) return;
            disposed = true; cached = undefined; dirty.clear();
            for (const entry of held.values()) entry.lease?.release();
            held.clear();
        },
    };
}
