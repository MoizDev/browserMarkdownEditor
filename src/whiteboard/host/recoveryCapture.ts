import type { JournalCapture } from '../../utils/recoveryFunnel';
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
import type { MediaId } from '../model/media';

// Provenance: C-20 journal capture, serializer delta/integrity and media lease
// contracts; independently implemented, no third-party source.
type Dirty = { readonly revision: number; readonly change: SerializerChange | null; readonly identity: RecordIdentity };
type Hold = { path: string; readonly lease?: { release(): void } };
function copyPrime(prime: SerializerPrime): SerializerPrime {
    if (!Number.isSafeInteger(prime.revision) || prime.revision < 0 || !(prime.baseline instanceof Blob)
        || (typeof File !== 'undefined' && prime.baseline instanceof File) || typeof prime.header !== 'string'
        || (prime.lines === undefined) === (prime.index === undefined)) throw new TypeError('Invalid recovery baseline');
    if (prime.index !== undefined && (!(prime.index instanceof Blob) || (typeof File !== 'undefined' && prime.index instanceof File))) throw new TypeError('Invalid recovery index');
    return { revision: prime.revision, baseline: prime.baseline, header: prime.header,
        ...(prime.lines ? { lines: prime.lines.map(line => ({ ...line, identity: { ...line.identity } })) } : { index: prime.index! }) };
}

export function createBoardRecoveryCapture(options: {
    baseline: SerializerPrime; doc: BoardDoc; encoder: EncoderContext; records: Iterable<RecordVersion>;
    representation: 'drawing' | 'notebook'; mediaPath: (id: MediaId) => string | null;
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
    let cached: JournalCapture | undefined, disposed = false;
    const assertOpen = () => { if (disposed) throw new Error('Recovery capture disposed'); };
    const hold = (id: MediaId, added: MediaId[]) => {
        const path = options.mediaPath(id);
        if (typeof path !== 'string' || !path.length) throw new Error(`Recovery media path unavailable for ${id}`);
        const old = held.get(id);
        if (old) { old.path = path; return; }
        const lease = options.retainMedia?.(id);
        held.set(id, { path, lease }); added.push(id);
    };
    const unhold = (ids: readonly MediaId[]) => {
        for (const id of ids) { const entry = held.get(id); held.delete(id); entry?.lease?.release(); }
    };
    const initial: MediaId[] = [];
    try {
        for (const id of doc.mediaRefs.keys()) hold(id, initial);
        for (const id of doc.preservedMediaRefs.keys()) hold(id, initial);
    } catch (error) { unhold(initial); throw error; }
    const snapshot = (nextPrime: SerializerPrime, revision: number, items: ReadonlyMap<string, Dirty>, header: string,
        expected: ReturnType<RecordChanges['integrity']>): JournalCapture | undefined => {
        if (revision <= nextPrime.revision) return undefined;
        const changed: SerializerChange[] = [], removed: RecordIdentity[] = [];
        for (const item of items.values()) { if (item.change) changed.push(item.change); else removed.push(item.identity); }
        const endFields = [...(doc.preserved.end?.fields ?? [])].map(([key, value]) => [key, value] as const);
        const recipe: BoardRecoveryRecipe = { version: 1, prime: nextPrime,
            delta: { previous: nextPrime.revision, revision, header, changed, removed }, expected, endFields };
        return { payload: recipe, copy: { kind: 'recipe', payload: recipe }, mediaRefs: [...held.values()].map(value => value.path) };
    };
    let header = prime.header;
    return {
        record(applied, revision) {
            assertOpen();
            const encodedHeader = encodeHeader(doc.kind, doc.preserved);
            if (!encodedHeader.ok) throw new Error(encodedHeader.error.reason);
            const encoded = records.encode(doc, applied.touched, options.encoder, revision, encodedHeader.value);
            if (!encoded.ok) throw new Error(encoded.error.reason);
            const next = new Map(dirty), added: MediaId[] = [];
            for (const change of encoded.value.delta.changed) next.set(recordKey(change.identity), { revision, identity: change.identity, change });
            for (const identity of encoded.value.delta.removed) next.set(recordKey(identity), { revision, identity, change: null });
            try {
                for (const id of applied.touched.media) hold(id, added);
                const capture = snapshot(prime, revision, next, encodedHeader.value, encoded.value.expected);
                encoded.value.commit();
                dirty = next; current = revision; header = encodedHeader.value; cached = capture;
            } catch (error) { unhold(added); throw error; }
        },
        capture() { assertOpen(); return cached; },
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
