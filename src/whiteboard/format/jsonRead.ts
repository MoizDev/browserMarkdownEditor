import type { RawJson } from '../model/json';
import { FORMAT_LIMITS } from './schema';

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export class JsonReadError extends Error {
    constructor(readonly code: 'syntax' | 'limit', message: string, readonly offset: number) { super(message); }
}
export interface JsonSpan {
    readonly start: number;
    readonly end: number;
    readonly kind: JsonKind;
    readonly depth: number;
    readonly source: string;
    text(): string;
    string(limit: number): string;
    stringLength(limit: number): number;
    number(): number;
    value(): unknown;
    raw(): RawJson;
    fields(): Iterable<readonly [string, JsonSpan]>;
    items(): Iterable<JsonSpan>;
    length(limit: number): number;
    fieldMap(): ReadonlyMap<string, JsonSpan>;
}

function error(code: 'syntax' | 'limit', message: string, offset: number): never {
    throw new JsonReadError(code, message, offset);
}
const JSON_ESCAPES: readonly number[] = [34, 92, 47, 98, 102, 110, 114, 116];
function whitespace(code: number): boolean { return code === 32 || code === 9 || code === 10 || code === 13; }
function digit(code: number): boolean { return code >= 48 && code <= 57; }
function hex(code: number): boolean { return digit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102); }
function copyText(source: string, start: number, end: number, minify = false): string {
    const buffer = new Uint16Array(Math.min(4096, end - start));
    const parts: string[] = [];
    let used = 0, quoted = false, escaped = false;
    for (let i = start; i < end; i++) {
        const code = source.charCodeAt(i);
        if (minify) {
            if (quoted) {
                if (escaped) escaped = false;
                else if (code === 92) escaped = true;
                else if (code === 34) quoted = false;
            } else if (code === 34) quoted = true;
            else if (whitespace(code)) continue;
        }
        buffer[used++] = code;
        if (used === buffer.length) { parts.push(String.fromCharCode(...buffer)); used = 0; }
    }
    if (used) parts.push(String.fromCharCode(...buffer.subarray(0, used)));
    return parts.join('');
}
function tokenText(source: string, start: number, end: number): string {
    // A tiny raw value must not pin a 64 MiB parent line through V8's sliced-string backing.
    return source.length > 16_384 && end - start < source.length / 4
        ? copyText(source, start, end) : source.slice(start, end);
}
function kind(source: string, start: number): JsonKind {
    switch (source.charCodeAt(start)) {
        case 123: return 'object';
        case 91: return 'array';
        case 34: return 'string';
        case 116: case 102: return 'boolean';
        case 110: return 'null';
        default: return 'number';
    }
}

class Reader {
    stringUnits = 0;
    constructor(readonly source: string, readonly maxDepth: number) { }
    white(index: number): number {
        while (index < this.source.length && whitespace(this.source.charCodeAt(index))) index++;
        return index;
    }
    quoted(index: number, limit = FORMAT_LIMITS.recordBytes): number {
        if (this.source.charCodeAt(index) !== 34) return error('syntax', 'Expected a JSON string', index);
        const start = index++;
        let units = 0;
        while (index < this.source.length) {
            const code = this.source.charCodeAt(index++);
            if (code === 34) { this.stringUnits = units; return index; }
            if (code < 32) error('syntax', 'Unescaped control character in JSON string', index - 1);
            if (code === 92) {
                const escaped = this.source.charCodeAt(index++);
                if (escaped === 117) {
                    for (let n = 0; n < 4; n++) if (!hex(this.source.charCodeAt(index++))) error('syntax', 'Invalid Unicode escape', index - 1);
                } else if (!JSON_ESCAPES.includes(escaped)) {
                    error('syntax', 'Invalid JSON escape', index - 1);
                }
            }
            if (++units > limit) error('limit', `JSON string exceeds ${limit} UTF-16 units`, start);
        }
        return error('syntax', 'Unterminated JSON string', start);
    }
    skip(index: number, depth: number): number {
        const start = index;
        const code = this.source.charCodeAt(index);
        if (code === 34) return this.quoted(index);
        if (code === 123 || code === 91) {
            if (depth >= this.maxDepth) error('limit', `JSON nesting exceeds ${this.maxDepth}`, start);
            const object = code === 123, close = object ? 125 : 93;
            index = this.white(index + 1);
            if (this.source.charCodeAt(index) === close) return index + 1;
            for (; ;) {
                if (object) {
                    index = this.white(this.quoted(index));
                    if (this.source.charCodeAt(index++) !== 58) error('syntax', 'Expected a colon after JSON key', index - 1);
                    index = this.white(index);
                }
                index = this.white(this.skip(index, depth + 1));
                const separator = this.source.charCodeAt(index++);
                if (separator === close) return index;
                if (separator !== 44) error('syntax', 'Expected a JSON comma or closing delimiter', index - 1);
                index = this.white(index);
            }
        }
        if (code === 116 && this.source.startsWith('true', index)) return index + 4;
        if (code === 102 && this.source.startsWith('false', index)) return index + 5;
        if (code === 110 && this.source.startsWith('null', index)) return index + 4;
        if (code === 45) index++;
        const first = this.source.charCodeAt(index);
        if (first === 48) index++;
        else {
            if (first < 49 || first > 57 || !Number.isFinite(first)) error('syntax', 'Expected a JSON value', start);
            while (digit(this.source.charCodeAt(++index))) { /* integer digits */ }
        }
        if (this.source.charCodeAt(index) === 46) {
            if (!digit(this.source.charCodeAt(++index))) error('syntax', 'Missing fractional digits', index);
            while (digit(this.source.charCodeAt(++index))) { /* fractional digits */ }
        }
        const exponent = this.source.charCodeAt(index);
        if (exponent === 69 || exponent === 101) {
            index++;
            if (this.source.charCodeAt(index) === 43 || this.source.charCodeAt(index) === 45) index++;
            if (!digit(this.source.charCodeAt(index))) error('syntax', 'Missing exponent digits', index);
            while (digit(this.source.charCodeAt(++index))) { /* exponent digits */ }
        }
        if (!Number.isFinite(Number(this.source.slice(start, index)))) error('limit', 'JSON number is not finite', start);
        return index;
    }
    span(start: number, depth: number, parent?: Span, key?: string | number): Span {
        return new Span(this, start, this.skip(start, depth), depth, parent, key);
    }
}

class Span implements JsonSpan {
    private parsed = false;
    private cached: unknown;
    readonly kind: JsonKind;
    constructor(private readonly reader: Reader, readonly start: number, readonly end: number,
        readonly depth: number, private readonly parent?: Span, private readonly key?: string | number) {
        this.kind = kind(reader.source, start);
    }
    get source(): string { return this.reader.source; }
    text(): string { return tokenText(this.source, this.start, this.end); }
    stringLength(limit: number): number {
        if (this.kind !== 'string') return error('syntax', 'Expected a string', this.start);
        this.reader.quoted(this.start, limit);
        return this.reader.stringUnits;
    }
    string(limit: number): string {
        this.stringLength(limit);
        const value = this.value() as string;
        if (this.source.length > 16_384 && value.length < this.source.length / 4) {
            this.cached = copyText(value, 0, value.length);
        }
        return this.cached as string;
    }
    number(): number {
        if (this.kind !== 'number') return error('syntax', 'Expected a number', this.start);
        return Number(this.text()); // skip() has checked grammar and finiteness already.
    }
    value(): unknown {
        if (!this.parsed) {
            if (this.parent?.parsed && this.key !== undefined) {
                this.cached = (this.parent.cached as Record<string | number, unknown>)[this.key];
            } else {
                this.cached = JSON.parse(this.text());
            }
            this.parsed = true;
        }
        return this.cached;
    }
    raw(): RawJson {
        // Only this reader brands a grammar/depth/number-validated source value. No JSON.parse /
        // stringify cycle touches its strings, escapes, numbers or nested key spellings (R-W16).
        let quoted = false, escaped = false;
        for (let i = this.start; i < this.end; i++) {
            const code = this.source.charCodeAt(i);
            if (quoted) {
                if (escaped) escaped = false;
                else if (code === 92) escaped = true;
                else if (code === 34) quoted = false;
            } else if (code === 34) quoted = true;
            else if (whitespace(code)) return copyText(this.source, this.start, this.end, true) as RawJson;
        }
        return this.text() as RawJson;
    }
    *fields(): Iterable<readonly [string, JsonSpan]> {
        if (this.kind !== 'object') error('syntax', 'Expected an object', this.start);
        let index = this.reader.white(this.start + 1);
        while (index < this.end - 1) {
            const keyEnd = this.reader.quoted(index);
            const name = JSON.parse(tokenText(this.source, index, keyEnd)) as string;
            const valueStart = this.reader.white(this.reader.white(keyEnd) + 1);
            const child = this.reader.span(valueStart, this.depth + 1, this, name);
            yield [name, child];
            index = this.reader.white(child.end);
            if (this.source.charCodeAt(index) === 44) index = this.reader.white(index + 1);
        }
    }
    *items(): Iterable<JsonSpan> {
        if (this.kind !== 'array') error('syntax', 'Expected an array', this.start);
        let index = this.reader.white(this.start + 1), count = 0;
        while (index < this.end - 1) {
            const child = this.reader.span(index, this.depth + 1, this, count++);
            yield child;
            index = this.reader.white(child.end);
            if (this.source.charCodeAt(index) === 44) index = this.reader.white(index + 1);
        }
    }
    length(limit: number): number {
        let count = 0;
        for (const _item of this.items()) if (++count > limit) error('limit', `Array exceeds ${limit} elements`, this.start);
        return count;
    }
    fieldMap(): ReadonlyMap<string, JsonSpan> {
        const fields = new Map<string, JsonSpan>();
        for (const [key, value] of this.fields()) {
            if (fields.has(key)) error('syntax', 'Duplicate JSON property cannot be represented losslessly', value.start);
            fields.set(key, value);
        }
        return fields;
    }
}

// Format-first sniffing stops at the root's format property. Later damage must not send native
// content to the legacy importer; a nested string/object bearing that word is not a marker.
export function hasNativeMarker(source: string): boolean {
    const reader = new Reader(source, FORMAT_LIMITS.jsonDepth);
    let index = reader.white(source.charCodeAt(0) === 0xfeff ? 1 : 0);
    if (source.charCodeAt(index++) !== 123) return false;
    try {
        for (; ;) {
            index = reader.white(index);
            if (source.charCodeAt(index) === 125) return false;
            const keyEnd = reader.quoted(index);
            const name = JSON.parse(tokenText(source, index, keyEnd)) as string;
            index = reader.white(keyEnd);
            if (source.charCodeAt(index++) !== 58) return false;
            index = reader.white(index);
            const value = reader.span(index, 1);
            if (name === 'format') return value.kind === 'string' && value.string(FORMAT_LIMITS.recordBytes) === 'board';
            index = reader.white(value.end);
            if (source.charCodeAt(index++) !== 44) return false;
        }
    } catch (error) { if (!(error instanceof JsonReadError)) throw error; return false; }
}

export function parseJson(source: string, maxDepth: number = FORMAT_LIMITS.jsonDepth): JsonSpan {
    if (source.length > FORMAT_LIMITS.recordBytes) error('limit', 'JSON value exceeds 64 MiB', 0);
    const reader = new Reader(source, maxDepth), start = reader.white(0);
    const span = reader.span(start, 0);
    if (reader.white(span.end) !== source.length) error('syntax', 'Unexpected text after JSON value', span.end);
    return span;
}
