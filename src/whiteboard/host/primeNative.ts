import { encodeHeader, encodeOpaque, encodeRecord, type EncoderContext } from '../format/encode';
import { RecordChanges, type RecordVersion } from '../format/recordChanges';
import { FORMAT_LIMITS } from '../format/schema';
import type { BaselineLine, SerializerChange, SerializerPrime } from '../format/serializerProtocol';
import { recordKey, utf8Length, type EncodedRecord, type RecordIdentity, type WriteResult } from '../format/writeTypes';
import type { RehydratedLoad } from '../model/loadTypes';
import type { MediaId } from '../model/media';

/** Build revision-zero serializer state from the admitted model and its original bytes.
 * Repairs are baseline overrides, not synthetic edits or a save. */
export async function primeNativeLoad(load: RehydratedLoad, baseline: Blob, encoder: EncoderContext,
    cooperate?: () => Promise<void>, signal?: AbortSignal): Promise<{ prime: SerializerPrime; records: RecordChanges }> {
    const doc = load.doc;
    if (doc.rev !== 0 || !(baseline instanceof Blob) || (typeof File !== 'undefined' && baseline instanceof File)) {
        throw new TypeError('Native priming requires an admitted revision-zero board and parsed-byte Blob');
    }
    if (load.unmapped.length) throw new Error('Unmapped records cannot be safely primed');
    let steps = 0;
    const tick = async () => { signal?.throwIfAborted(); await cooperate?.(); signal?.throwIfAborted(); };
    const due = () => (steps++ & 255) === 0;
    const take = <T>(result: WriteResult<T>): T => { if (!result.ok) throw new Error(result.error.reason); return result.value; };
    await tick();
    const header = take(encodeHeader(doc.kind, doc.preserved));
    const wanted = new Map<string, RecordIdentity>();
    const add = (identity: RecordIdentity) => {
        const key = recordKey(identity);
        if (wanted.has(key)) throw new Error('Duplicate canonical record identity');
        wanted.set(key, identity);
    };
    add({ category: 'pen', type: 'pen' }); add({ category: 'view', type: 'view' });
    if (doc.host.kind === 'notebook') add({ category: 'paper', type: 'paper' });
    if (doc.host.kind === 'pdf-ink') add({ category: 'host', type: 'host' });
    const mediaIds = new Set<MediaId>();
    for (const [id, refs] of encoder.mediaRefs) { if (due()) await tick(); if (refs.size) mediaIds.add(id); }
    for (const [id, count] of encoder.preservedMediaRefs) { if (due()) await tick(); if (count > 0) mediaIds.add(id); }
    for (const id of mediaIds) { if (due()) await tick(); if (doc.media.has(id)) add({ category: 'media', type: 'media', id }); }
    for (const sheet of doc.sheets.values()) { if (due()) await tick(); add({ category: 'sheet', type: 'sheet', id: sheet.id }); }
    for (const node of doc.nodes.values()) { if (due()) await tick(); add({ category: 'node', type: 'node', id: node.id }); }
    const opaque = new Map<string, (typeof doc.preserved.records)[number]>();
    for (const record of doc.preserved.records) {
        if (due()) await tick();
        const id: RecordIdentity = { category: 'opaque', type: record.type, id: record.id };
        add(id); opaque.set(recordKey(id), record);
    }
    const lines: BaselineLine[] = [], overrides: SerializerChange[] = [], versions: RecordVersion[] = [];
    const textEncoder = new TextEncoder();
    const encode = (id: RecordIdentity): EncodedRecord => {
        const unknown = id.category === 'opaque' ? opaque.get(recordKey(id)) : undefined;
        const value = take(unknown ? encodeOpaque(unknown) : encodeRecord(doc, id, encoder));
        if (!value || recordKey(value.identity) !== recordKey(id)) throw new Error('Canonical record is missing or changed identity');
        return value;
    };
    const override = (id: RecordIdentity) => {
        const encoded = encode(id);
        take(utf8Length(encoded.text, FORMAT_LIMITS.recordBytes));
        overrides.push({ identity: id, revision: 0, bytes: textEncoder.encode(encoded.text) });
    };
    for (const source of load.sources) {
        if (due()) await tick();
        if (source.category === 'end') continue;
        const id: RecordIdentity = { category: source.category, type: source.type, ...(source.id === undefined ? {} : { id: source.id }) };
        const key = recordKey(id), canonical = wanted.get(key);
        if (!canonical) continue;
        if (canonical.category !== id.category) throw new Error('Source record category does not match canonical identity');
        wanted.delete(key);
        versions.push({ identity: canonical, revision: 0 });
        if (source.reencode) override(canonical);
        else lines.push({ identity: canonical, offset: source.position.byteOffset, length: source.position.byteLength, revision: 0 });
    }
    for (const id of wanted.values()) {
        if (due()) await tick();
        versions.push({ identity: id, revision: 0 });
        override(id);
    }
    await tick();
    const records = await RecordChanges.from(0, versions, cooperate, signal);
    signal?.throwIfAborted();
    return { prime: { revision: 0, baseline, header, lines, overrides }, records };
}
