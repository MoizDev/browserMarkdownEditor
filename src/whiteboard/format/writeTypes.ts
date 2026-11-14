import type { RecordCategory } from './schema';

export type StoredRecordCategory = Exclude<RecordCategory, 'end'>;
export interface RecordIdentity {
    readonly category: StoredRecordCategory;
    readonly type: string;
    readonly id?: string;
}
export interface EncodedRecord {
    readonly identity: RecordIdentity;
    readonly text: string; // One JSON object, no delimiter or physical line break.
}
export interface WriteRefusal {
    readonly code: 'invalid' | 'limit' | 'points' | 'allocation' | 'integrity' | 'dirty' | 'header';
    readonly reason: string;
    readonly field?: string;
}
export type WriteResult<T> = { readonly ok: true; readonly value: T; }
    | { readonly ok: false; readonly error: WriteRefusal; };

export function recordKey(identity: RecordIdentity): string {
    // A tuple cannot alias an imported id containing colons, quotes or a singleton's name.
    return JSON.stringify([identity.type, identity.id ?? null]);
}
export function writeFailure<T>(code: WriteRefusal['code'], reason: string, field?: string): WriteResult<T> {
    return { ok: false, error: { code, reason, ...(field === undefined ? {} : { field }) } };
}

export function utf8Length(text: string, limit: number): WriteResult<number> {
    if (text.length > limit) return writeFailure('limit', 'Encoded line exceeds its byte limit');
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 10 || code === 13) return writeFailure('invalid', 'Encoded records must occupy one physical line');
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return writeFailure('invalid', 'Encoded line contains an unpaired surrogate');
            bytes += 4;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return writeFailure('invalid', 'Encoded line contains an unpaired surrogate');
        } else {
            bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
        }
        if (bytes > limit) return writeFailure('limit', 'Encoded line exceeds its byte limit');
    }
    return { ok: true, value: bytes };
}
