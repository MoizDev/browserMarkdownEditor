import type { TouchedSet } from '../change/ops';
import type { BoardDoc } from '../model/doc';
import { encodeRecord } from './encode';
import type { EncoderContext } from './encode';
import { RecordKeyDigest } from './lineTable';
import type { RecordIntegrity } from './lineTable';
import { FORMAT_LIMITS } from './schema';
import type { SerializerChange, SerializerDelta } from './serializerProtocol';
import { recordKey, utf8Length, writeFailure } from './writeTypes';
import type { RecordIdentity, WriteResult } from './writeTypes';

export interface RecordVersion { readonly identity: RecordIdentity; readonly revision: number; }
export interface EncodedChanges {
    readonly delta: SerializerDelta;
    readonly expected: RecordIntegrity;
    /** Call only after SerializerSession.update accepted the delta synchronously. */
    commit(): void;
}

/** Session-owned count/digest and per-record revisions. No full-board walk on an edit: the
 * transaction's touched set is the sole input, including media whose reference count changed. */
export class RecordChanges {
    private readonly versions = new Map<string, number>();
    private digest = new RecordKeyDigest();
    private revision: number;
    constructor(revision: number, initial: Iterable<RecordVersion>) {
        if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Invalid initial session revision');
        this.revision = revision;
        for (const item of initial) {
            const key = recordKey(item.identity);
            if (this.versions.has(key)) throw new Error('Duplicate record identity in serializer baseline');
            const next = this.digest.replace(item.identity, null, item.revision);
            if (!next.ok) throw new Error(next.error.reason);
            this.versions.set(key, item.revision);
        }
    }
    integrity(): RecordIntegrity { return this.digest.snapshot(); }

    encode(doc: BoardDoc, touched: TouchedSet, context: EncoderContext, revision: number, header?: string): WriteResult<EncodedChanges> {
        if (!Number.isSafeInteger(revision) || revision <= this.revision) return writeFailure('invalid', 'Session revision must advance');
        const identities = new Map<string, RecordIdentity>();
        const add = (identity: RecordIdentity) => identities.set(recordKey(identity), identity);
        for (const id of touched.nodes) add({ category: 'node', type: 'node', id });
        for (const id of touched.sheets) add({ category: 'sheet', type: 'sheet', id });
        for (const id of touched.media) add({ category: 'media', type: 'media', id });
        for (const key of touched.board) {
            const type = key.startsWith('ui.') ? 'pen' : key.startsWith('view.') ? 'view' : key === 'host.paper' ? 'paper' : 'host';
            add({ category: type, type });
        }
        const changed: SerializerChange[] = [], removed: RecordIdentity[] = [];
        const replacements: { key: string; revision: number | null; }[] = [];
        const digest = this.digest.clone();
        const encoder = new TextEncoder();
        for (const [key, identity] of identities) {
            const encoded = encodeRecord(doc, identity, context);
            if (!encoded.ok) return encoded;
            const before = this.versions.get(key) ?? null;
            const after = encoded.value === null ? null : revision;
            const next = digest.replace(identity, before, after);
            if (!next.ok) return next;
            replacements.push({ key, revision: after });
            if (encoded.value === null) removed.push(identity);
            else {
                const size = utf8Length(encoded.value.text, FORMAT_LIMITS.recordBytes);
                if (!size.ok) return size;
                try { changed.push({ identity, revision, bytes: encoder.encode(encoded.value.text) }); }
                catch (error) {
                    if (error instanceof RangeError) return writeFailure('allocation', 'Changed record could not be encoded');
                    throw error;
                }
            }
        }
        const previous = this.revision;
        let committed = false;
        return {
            ok: true, value: {
                delta: { revision, previous, ...(header === undefined ? {} : { header }), changed, removed },
                expected: digest.snapshot(),
                commit: () => {
                    if (committed) return;
                    if (this.revision !== previous) throw new Error('Stale prepared serializer change');
                    // Encoding and synchronous handoff can fail; neither may advance the digest.
                    for (const replacement of replacements) {
                        if (replacement.revision === null) this.versions.delete(replacement.key);
                        else this.versions.set(replacement.key, replacement.revision);
                    }
                    this.revision = revision;
                    this.digest = digest;
                    committed = true;
                },
            }
        };
    }
}
