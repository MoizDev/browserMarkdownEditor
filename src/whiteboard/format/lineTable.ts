import type { TouchedSet } from '../change/ops';
import type { ExtBag } from '../model/json';
import { encodeEnd } from './encode';
import { FORMAT_LIMITS, RECORD_ORDER } from './schema';
import { recordKey, utf8Length, writeFailure } from './writeTypes';
import type { EncodedRecord, RecordIdentity, WriteResult } from './writeTypes';

export interface RecordIntegrity { readonly count: number; readonly digest: string; }

// R-W16: a consistency token for a missing/wrong record table, NOT a security property or file hash.
// The serializer's separate Blob SHA-256 belongs to W-D2b. Each lane adds/subtracts modulo 2^32.
const DIGEST_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const;
const DIGEST_PRIME = 0x01000193;
function revisionValid(revision: number): boolean { return Number.isSafeInteger(revision) && revision >= 0; }
function tokenHash(identity: RecordIdentity, revision: number): number[] {
    const token = JSON.stringify([identity.type, identity.id ?? null, revision]);
    const hash: number[] = [...DIGEST_SEEDS];
    for (let i = 0; i < token.length; i++) {
        const code = token.charCodeAt(i);
        for (let lane = 0; lane < 4; lane++) hash[lane] = Math.imul(hash[lane] ^ code, DIGEST_PRIME) >>> 0;
    }
    return hash;
}

export class RecordKeyDigest {
    private count = 0;
    private readonly lanes = new Uint32Array(4);

    // The session owns revisions; this accumulator owns no by-id registry or document metadata.
    // Supplying the previous revision lets both session and worker update in O(touched ids).
    replace(identity: RecordIdentity, before: number | null, after: number | null): WriteResult<RecordIntegrity> {
        if (!identityValid(identity) || (before !== null && !revisionValid(before)) || (after !== null && !revisionValid(after))) {
            return writeFailure('invalid', 'Record revision must be a non-negative safe integer');
        }
        const count = this.count + Number(after !== null) - Number(before !== null);
        if (count < 0 || count >= FORMAT_LIMITS.records) return writeFailure('limit', 'Record count exceeds the native format limit');
        const oldHash = before === null ? null : tokenHash(identity, before);
        const newHash = after === null ? null : tokenHash(identity, after);
        for (let lane = 0; lane < 4; lane++) {
            this.lanes[lane] = (this.lanes[lane] - (oldHash?.[lane] ?? 0) + (newHash?.[lane] ?? 0)) >>> 0;
        }
        this.count = count;
        return { ok: true, value: this.snapshot() };
    }

    clone(): RecordKeyDigest {
        const copy = new RecordKeyDigest();
        copy.count = this.count;
        copy.lanes.set(this.lanes);
        return copy;
    }

    snapshot(): RecordIntegrity {
        let digest = '';
        for (const lane of this.lanes) digest += lane.toString(16).padStart(8, '0');
        return { count: this.count, digest };
    }
}

interface Entry {
    readonly identity: RecordIdentity;
    revision: number;
    text: string;
    bytes: number;
}
interface DirtyRecord { readonly identity: RecordIdentity; readonly revision: number; }
export interface LinePosition {
    readonly identity: RecordIdentity;
    readonly offset: number;
    readonly length: number;
    readonly revision: number;
}
export interface LineAssembly {
    readonly kind: 'built' | 'unchanged';
    readonly blob: Blob;
    readonly revision: number; // Content epoch, not a document or per-record revision.
    readonly integrity: RecordIntegrity;
}
function sameIntegrity(a: RecordIntegrity, b: RecordIntegrity): boolean {
    return a.count === b.count && a.digest === b.digest;
}
function identityValid(identity: RecordIdentity): boolean {
    if (typeof identity.type !== 'string' || !identity.type || identity.type.length > FORMAT_LIMITS.idChars) return false;
    if (identity.category === 'opaque') {
        if (RECORD_ORDER.includes(identity.type as typeof RECORD_ORDER[number]) && identity.type !== 'opaque') return false;
    } else if (identity.type !== identity.category || !RECORD_ORDER.includes(identity.category)) return false;
    const singleton = identity.category !== 'opaque' && (identity.type === 'pen' || identity.type === 'view' || identity.type === 'paper' || identity.type === 'host');
    if (singleton) return identity.id === undefined;
    if (typeof identity.id !== 'string' || !identity.id.length || identity.id.length > FORMAT_LIMITS.idChars) return false;
    for (let i = 0; i < identity.id.length; i++) {
        const code = identity.id.charCodeAt(i);
        if (code < 32 || code === 127) return false;
    }
    return true;
}
function ownIdentity(identity: RecordIdentity): RecordIdentity {
    return { category: identity.category, type: identity.type, ...(identity.id === undefined ? {} : { id: identity.id }) };
}
function compare(a: Entry, b: Entry): number {
    const rank = RECORD_ORDER.indexOf(a.identity.category) - RECORD_ORDER.indexOf(b.identity.category);
    if (rank) return rank;
    const left = a.identity.id ?? '', right = b.identity.id ?? '';
    if (left !== right) return left < right ? -1 : 1;
    return a.identity.type < b.identity.type ? -1 : a.identity.type > b.identity.type ? 1 : 0;
}

function lowerBound(entries: readonly Entry[], needle: Entry): number {
    let lo = 0, hi = entries.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compare(entries[mid], needle) < 0) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export class LineTable {
    private entries = new Map<string, Entry>();
    private dirty = new Map<string, DirtyRecord>();
    private keyDigest = new RecordKeyDigest();
    private ordered: Entry[] | null = null;
    private header: { text: string; bytes: number; } | null = null;
    private lineBytes = 0;
    private epoch = 0;
    private savedEpoch = -1;
    private assembly: { blob: Blob; revision: number; } | null = null;
    private end: { ext: ExtBag | null; count: number; text: string; bytes: number; } | null = null;

    get revision(): number { return this.epoch; }
    get needsSave(): boolean { return this.dirty.size > 0 || this.epoch !== this.savedEpoch; }
    get dirtyCount(): number { return this.dirty.size; }
    integrity(): RecordIntegrity { return this.keyDigest.snapshot(); }

    // Snapshot tables share immutable lines; edits replace entries, never mutate shared entries.
    // The worker can therefore assemble an older pinned revision after later edits arrive.
    fork(): LineTable {
        const copy = new LineTable();
        copy.entries = new Map(this.entries);
        copy.dirty = new Map(this.dirty);
        copy.keyDigest = this.keyDigest.clone();
        copy.ordered = this.ordered ? [...this.ordered] : null;
        copy.header = this.header;
        copy.lineBytes = this.lineBytes;
        copy.epoch = this.epoch;
        copy.savedEpoch = this.savedEpoch;
        copy.assembly = this.assembly;
        copy.end = this.end;
        return copy;
    }

    setHeader(text: string): WriteResult<boolean> {
        if (!text.startsWith('{') || !text.endsWith(',"records":[')) return writeFailure('header', 'Expected the native header and opening records array');
        const bytes = utf8Length(text, FORMAT_LIMITS.recordBytes);
        if (!bytes.ok) return bytes;
        if (this.header?.text === text) return { ok: true, value: false };
        if (!Number.isSafeInteger(this.epoch + 1)) return writeFailure('limit', 'Line-table content revision overflow');
        this.header = { text, bytes: bytes.value };
        this.epoch++;
        return { ok: true, value: true };
    }

    set(record: EncodedRecord, revision: number): WriteResult<boolean> {
        if (!identityValid(record.identity) || !revisionValid(revision)) return writeFailure('invalid', 'Invalid record identity or revision');
        if (!record.text.startsWith('{') || !record.text.endsWith('}')) return writeFailure('invalid', 'Record line must be a JSON object');
        const bytes = utf8Length(record.text, FORMAT_LIMITS.recordBytes);
        if (!bytes.ok) return bytes;
        const key = recordKey(record.identity), previous = this.entries.get(key);
        const changed = previous?.text !== record.text;
        if (changed && !Number.isSafeInteger(this.epoch + 1)) return writeFailure('limit', 'Line-table content revision overflow');
        const integrity = this.keyDigest.replace(record.identity, previous?.revision ?? null, revision);
        if (!integrity.ok) return integrity;
        const entry: Entry = { identity: previous?.identity ?? ownIdentity(record.identity), text: record.text, bytes: bytes.value, revision };
        this.entries.set(key, entry);
        this.lineBytes += bytes.value - (previous?.bytes ?? 0);
        if (this.ordered) {
            const index = lowerBound(this.ordered, entry);
            if (previous) this.ordered[index] = entry;
            else this.ordered.splice(index, 0, entry);
        }
        this.dirty.delete(key);
        if (changed) this.epoch++;
        return { ok: true, value: changed };
    }

    remove(identity: RecordIdentity): WriteResult<boolean> {
        if (!identityValid(identity)) return writeFailure('invalid', 'Invalid record identity');
        const key = recordKey(identity), previous = this.entries.get(key);
        if (!previous) { this.dirty.delete(key); return { ok: true, value: false }; }
        if (!Number.isSafeInteger(this.epoch + 1)) return writeFailure('limit', 'Line-table content revision overflow');
        const integrity = this.keyDigest.replace(previous.identity, previous.revision, null);
        if (!integrity.ok) return integrity;
        this.entries.delete(key);
        this.dirty.delete(key);
        this.lineBytes -= previous.bytes;
        if (this.ordered) this.ordered.splice(lowerBound(this.ordered, previous), 1);
        this.epoch++;
        return { ok: true, value: true };
    }

    touch(identity: RecordIdentity, revision: number): WriteResult<void> {
        if (!identityValid(identity) || !revisionValid(revision)) return writeFailure('invalid', 'Invalid dirty-record identity or revision');
        this.dirty.set(recordKey(identity), { identity: ownIdentity(identity), revision });
        return { ok: true, value: undefined };
    }

    markDirty(touched: TouchedSet, revision: number): WriteResult<void> {
        if (!revisionValid(revision)) return writeFailure('invalid', 'Invalid dirty-record revision');
        for (const [type, ids] of [['node', touched.nodes], ['sheet', touched.sheets], ['media', touched.media]] as const) {
            for (const id of ids) {
                const marked = this.touch({ category: type, type, id }, revision);
                if (!marked.ok) return marked;
            }
        }
        for (const key of touched.board) {
            const type = key.startsWith('ui.') ? 'pen' : key.startsWith('view.') ? 'view' : key === 'host.paper' ? 'paper' : 'host';
            const marked = this.touch({ category: type, type }, revision);
            if (!marked.ok) return marked;
        }
        return { ok: true, value: undefined };
    }

    reencodeDirty(encode: (identity: RecordIdentity) => WriteResult<EncodedRecord | null>): WriteResult<number> {
        let encoded = 0;
        for (const { identity, revision } of this.dirty.values()) {
            const record = encode(identity);
            if (!record.ok) return record;
            if (record.value !== null && recordKey(record.value.identity) !== recordKey(identity)) {
                return writeFailure('integrity', 'Encoder returned another record identity');
            }
            const applied = record.value === null ? this.remove(identity) : this.set(record.value, revision);
            if (!applied.ok) return applied;
            encoded++;
        }
        // A refusal leaves its record dirty. No assembly can expose a partly re-encoded table.
        return { ok: true, value: encoded };
    }

    assemble(expected: RecordIntegrity, endExt: ExtBag | null = null): WriteResult<LineAssembly> {
        if (this.dirty.size) return writeFailure('dirty', 'Records still need encoding; the board remains dirty');
        const integrity = this.keyDigest.snapshot();
        if (this.entries.size !== expected.count || !sameIntegrity(integrity, expected)) {
            return writeFailure('integrity', 'Record count or revision-key digest does not match the session');
        }
        if (!this.header) return writeFailure('header', 'The native header is missing');
        // R-W30: the end record's unknown fields come from the model too. Cache by immutable
        // owner and count, but never reuse an assembly whose footer bytes changed.
        if (!this.end || this.end.ext !== endExt || this.end.count !== expected.count) {
            const encoded = encodeEnd(expected.count, endExt);
            if (!encoded.ok) return encoded;
            const size = utf8Length(encoded.value, FORMAT_LIMITS.recordBytes);
            if (!size.ok) return size;
            const changed = this.end !== null && this.end.text !== encoded.value;
            if (changed && !Number.isSafeInteger(this.epoch + 1)) return writeFailure('limit', 'Line-table content revision overflow');
            this.end = { ext: endExt, count: expected.count, text: encoded.value, bytes: size.value };
            if (changed) this.epoch++;
        }
        if (this.assembly?.revision === this.epoch) {
            return { ok: true, value: { kind: 'unchanged', blob: this.assembly.blob, revision: this.epoch, integrity } };
        }
        const bytes = this.header.bytes + 1 + this.lineBytes + 2 * expected.count + this.end.bytes + 4;
        if (bytes > FORMAT_LIMITS.fileBytes) return writeFailure('limit', 'Native board exceeds 1 GiB');
        if (!this.ordered) this.ordered = [...this.entries.values()].sort(compare);
        const parts: BlobPart[] = [this.header.text, '\n'];
        for (const entry of this.ordered) parts.push(entry.text, ',\n');
        parts.push(this.end.text, '\n]}\n');
        let blob: Blob;
        try { blob = new Blob(parts, { type: 'application/json' }); } catch (error) {
            if (error instanceof RangeError) return writeFailure('allocation', 'The assembled board could not be allocated');
            throw error;
        }
        this.assembly = { blob, revision: this.epoch };
        return { ok: true, value: { kind: 'built', blob, revision: this.epoch, integrity } };
    }

    /** Positions in the canonical Blob produced by assemble(). Consumed in the worker to
     * retain a compact recovery index without posting a whole board's record table to App. */
    *positions(): Iterable<LinePosition> {
        if (!this.header || this.dirty.size) throw new Error('Cannot index an incomplete line table');
        if (!this.ordered) this.ordered = [...this.entries.values()].sort(compare);
        let offset = this.header.bytes + 1;
        for (const entry of this.ordered) {
            yield { identity: entry.identity, offset, length: entry.bytes, revision: entry.revision };
            offset += entry.bytes + 2;
        }
    }

    acknowledge(revision: number): WriteResult<void> {
        if (!revisionValid(revision) || revision > this.epoch) return writeFailure('invalid', 'Cannot acknowledge a future content revision');
        this.savedEpoch = Math.max(this.savedEpoch, revision);
        return { ok: true, value: undefined };
    }
}
