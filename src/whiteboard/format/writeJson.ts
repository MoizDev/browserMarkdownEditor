import type { ExtBag, RawJson } from '../model/json';
import { FORMAT_LIMITS } from './schema';
import { utf8Length } from './writeTypes';
import type { WriteRefusal, WriteResult } from './writeTypes';

class WriteError extends Error {
    constructor(readonly detail: WriteRefusal) { super(detail.reason); }
}
export function refuseWrite(code: WriteRefusal['code'], reason: string, field?: string): never {
    throw new WriteError({ code, reason, ...(field === undefined ? {} : { field }) });
}
export function guardWrite<T>(work: () => T): WriteResult<T> {
    try { return { ok: true, value: work() }; } catch (error) {
        if (error instanceof WriteError) return { ok: false, error: error.detail };
        if (error instanceof RangeError) return { ok: false, error: { code: 'allocation', reason: 'The encoded record could not be allocated' } };
        throw error;
    }
}

class RawValue { constructor(readonly source: RawJson) { } }
class LazyValue { constructor(readonly read: () => unknown) { } }
class TupleValue { constructor(readonly items: readonly unknown[], readonly tail?: RawJson) { } }
type Field = readonly [name: string, value: unknown];
class ObjectValue { constructor(readonly fields: readonly Field[], readonly ext?: ExtBag | null) { } }

export function rawValue(source: RawJson): unknown { return new RawValue(source); }
export function lazyValue(read: () => unknown): unknown { return new LazyValue(read); }
export function tupleValue(items: readonly unknown[], tail?: RawJson): unknown { return new TupleValue(items, tail); }
export function objectValue(fields: readonly Field[], ext?: ExtBag | null): unknown { return new ObjectValue(fields, ext); }

export function compactRaw(source: RawJson, depthOffset = 0): string {
    // R-W16: only insignificant whitespace outside string tokens may change. Branding belongs
    // exclusively to the bounded reader; this is NOT a parser or a general RawJson constructor.
    if (!source.length) refuseWrite('invalid', 'Raw JSON value is empty');
    if (source.length > FORMAT_LIMITS.recordBytes) refuseWrite('limit', 'Raw value exceeds the record limit');
    let quoted = false, escaped = false, depth = 0, start = 0;
    const parts: string[] = [];
    let chunk = '';
    let changed = false;
    for (let i = 0; i < source.length; i++) {
        const char = source.charCodeAt(i);
        if (quoted) {
            if (char < 32) refuseWrite('invalid', 'Raw JSON string contains an unescaped control character');
            if (escaped) escaped = false;
            else if (char === 92) escaped = true;
            else if (char === 34) quoted = false;
        } else if (char === 34) {
            quoted = true;
        } else if (char === 123 || char === 91) {
            if (++depth + depthOffset > FORMAT_LIMITS.jsonDepth) refuseWrite('limit', 'Raw JSON nesting exceeds 128');
        } else if (char === 125 || char === 93) {
            if (--depth < 0) refuseWrite('invalid', 'Unbalanced raw JSON value');
        } else if (char === 32 || char === 9 || char === 10 || char === 13) {
            changed = true;
            if (start < i) chunk += source.slice(start, i);
            start = i + 1;
            if (chunk.length >= 16_384) { parts.push(chunk); chunk = ''; }
        }
    }
    if (quoted || depth !== 0) refuseWrite('invalid', 'Incomplete raw JSON value');
    if (!changed) return source;
    parts.push(chunk + source.slice(start));
    const compact = parts.join('');
    if (!compact) refuseWrite('invalid', 'Raw JSON value is empty');
    return compact;
}
function quote(value: string): string {
    if (value.length > FORMAT_LIMITS.recordBytes) refuseWrite('limit', 'String cannot fit in one record');
    return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function objectFields(object: ObjectValue, depth: number): string {
    const known = new Set<string>();
    const entries: string[] = [];
    for (const [name, value] of object.fields) {
        if (known.has(name)) refuseWrite('invalid', 'Duplicate canonical field', name);
        known.add(name);
        const preserved = object.ext?.raw.get(name);
        if (preserved !== undefined) entries.push(quote(name) + ':' + compactRaw(preserved, depth + 1));
        else if (value !== undefined) entries.push(quote(name) + ':' + serialize(value, depth + 1));
    }
    if (object.ext) {
        for (const key of object.ext.raw.keys()) {
            if (!known.has(key)) refuseWrite('invalid', 'Preserved known property has no file mapping', key);
        }
        for (const key of [...object.ext.fields.keys()].sort()) {
            if (known.has(key)) refuseWrite('invalid', 'Unknown field collides with a known property', key);
            entries.push(quote(key) + ':' + compactRaw(object.ext.fields.get(key)!, depth + 1));
        }
    }
    return '{' + entries.join(',') + '}';
}
function tuple(array: TupleValue, depth: number): string {
    const items = array.items.map(value => serialize(value, depth + 1));
    if (array.tail !== undefined) {
        const tail = compactRaw(array.tail, depth);
        if (!tail.startsWith('[') || !tail.endsWith(']')) refuseWrite('invalid', 'Preserved tuple tail must be a JSON array');
        const extra = tail.slice(1, -1);
        if (extra) items.push(extra);
    }
    return '[' + items.join(',') + ']';
}
function serialize(value: unknown, depth: number): string {
    if (value instanceof LazyValue) return serialize(value.read(), depth);
    if (value instanceof RawValue) return compactRaw(value.source, depth);
    if (value === null) return 'null';
    if (typeof value === 'string') return quote(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) refuseWrite('invalid', 'Cannot write a non-finite number');
        return JSON.stringify(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (depth >= FORMAT_LIMITS.jsonDepth) refuseWrite('limit', 'Encoded JSON nesting exceeds 128');
    if (value instanceof ObjectValue) return objectFields(value, depth);
    if (value instanceof TupleValue) return tuple(value, depth);
    if (Array.isArray(value)) {
        if (value.length > (FORMAT_LIMITS.recordBytes - 1) / 2) refuseWrite('limit', 'JSON array cannot fit in one record');
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(value, i)) refuseWrite('invalid', 'JSON arrays must not contain holes');
            items.push(serialize(value[i], depth + 1));
        }
        return '[' + items.join(',') + ']';
    }
    if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        const fields: Field[] = [];
        for (const key of Object.keys(value).sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor)) refuseWrite('invalid', 'Only own JSON data properties may be encoded', key);
            fields.push([key, descriptor.value]);
        }
        return objectFields(new ObjectValue(fields), depth);
    }
    return refuseWrite('invalid', 'Only JSON data may be encoded');
}

export function jsonText(value: unknown): string {
    const text = serialize(value, 0);
    const size = utf8Length(text, FORMAT_LIMITS.recordBytes);
    if (!size.ok) refuseWrite(size.error.code, size.error.reason, size.error.field);
    return text;
}
