// A small, read-only PDF object reader for the rotation writer: enough of the file
// syntax to follow the cross-reference chain (tables, streams, hybrids, object
// streams) and read the page tree, and nothing else. Worker-only: it parses
// untrusted bytes, so it runs where the rest of the writer does.
//
// WHY ITS OWN READER, when pdf-lib is already in the writer: pdf-lib reads a file
// front to back and re-serializes values through its own model (latin1 strings,
// renumbered refs on save), while an incremental update must copy a page
// dictionary EXACTLY and address it by its existing object number. Reading only
// the xref chain and the page objects also keeps the cost independent of how much
// image data the file holds — the old route decoded every stream (measured: ~4.3s
// of JS Flate on a 62-page, 5.3MB scan).

export class PdfSyntaxError extends Error {
    constructor(message: string) { super(message); this.name = 'PdfSyntaxError'; }
}

export interface PdfNumberValue { readonly kind: 'number'; readonly value: number; readonly raw: string }
export interface PdfNameValue { readonly kind: 'name'; readonly value: string }
export interface PdfStringValue { readonly kind: 'string'; readonly bytes: Uint8Array }
export interface PdfRefValue { readonly kind: 'ref'; readonly num: number; readonly gen: number }
export interface PdfKeywordValue { readonly kind: 'keyword'; readonly value: string }
export type PdfValue = PdfNumberValue | PdfNameValue | PdfStringValue | PdfRefValue | PdfKeywordValue
    | { readonly kind: 'bool'; readonly value: boolean } | { readonly kind: 'null' }
    | { readonly kind: 'array'; readonly items: PdfValue[] } | PdfDictValue;
export interface PdfDictValue { readonly kind: 'dict'; readonly entries: Map<string, PdfValue> }

const MAX_DEPTH = 64;
const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (byte: number) => !WHITE.has(byte) && !DELIM.has(byte);
const latin1 = (bytes: Uint8Array, from: number, to: number) => {
    let text = '';
    for (let i = from; i < to; i++) text += String.fromCharCode(bytes[i]);
    return text;
};

/** Skips white space and comments. */
export function skipSpace(bytes: Uint8Array, pos: number): number {
    while (pos < bytes.length) {
        const byte = bytes[pos];
        if (WHITE.has(byte)) pos++;
        else if (byte === 0x25) { while (pos < bytes.length && bytes[pos] !== 10 && bytes[pos] !== 13) pos++; }
        else break;
    }
    return pos;
}

function token(bytes: Uint8Array, pos: number): { text: string; end: number } {
    let end = pos;
    while (end < bytes.length && isRegular(bytes[end])) end++;
    return { text: latin1(bytes, pos, end), end };
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const INTEGER = /^\d+$/;

/** Parses one direct value (refs included) starting at `pos`. */
export function parseValue(bytes: Uint8Array, start: number, depth = 0): { value: PdfValue; end: number } {
    if (depth > MAX_DEPTH) throw new PdfSyntaxError('PDF value nesting exceeds its limit');
    const pos = skipSpace(bytes, start);
    if (pos >= bytes.length) throw new PdfSyntaxError('Unexpected end of PDF data');
    const byte = bytes[pos];
    if (byte === 0x2f) {
        const { text, end } = token(bytes, pos + 1);
        return { value: { kind: 'name', value: text.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) }, end };
    }
    if (byte === 0x3c && bytes[pos + 1] === 0x3c) {
        const entries = new Map<string, PdfValue>();
        let at = skipSpace(bytes, pos + 2);
        while (!(bytes[at] === 0x3e && bytes[at + 1] === 0x3e)) {
            if (at >= bytes.length) throw new PdfSyntaxError('Unterminated PDF dictionary');
            const key = parseValue(bytes, at, depth + 1);
            if (key.value.kind !== 'name') throw new PdfSyntaxError('PDF dictionary key is not a name');
            const item = parseValue(bytes, key.end, depth + 1);
            if (entries.has(key.value.value)) throw new PdfSyntaxError('PDF dictionary repeats a key');
            entries.set(key.value.value, item.value);
            at = skipSpace(bytes, item.end);
        }
        return { value: { kind: 'dict', entries }, end: at + 2 };
    }
    if (byte === 0x3c) {
        const close = bytes.indexOf(0x3e, pos + 1);
        if (close < 0) throw new PdfSyntaxError('Unterminated PDF hex string');
        const hex = latin1(bytes, pos + 1, close).replace(/[\0\t\n\f\r ]/g, '');
        if (!/^[0-9a-fA-F]*$/.test(hex)) throw new PdfSyntaxError('Invalid PDF hex string');
        const padded = hex.length % 2 ? hex + '0' : hex, out = new Uint8Array(padded.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
        return { value: { kind: 'string', bytes: out }, end: close + 1 };
    }
    if (byte === 0x28) return literalString(bytes, pos);
    if (byte === 0x5b) {
        const items: PdfValue[] = [];
        let at = skipSpace(bytes, pos + 1);
        while (bytes[at] !== 0x5d) {
            if (at >= bytes.length) throw new PdfSyntaxError('Unterminated PDF array');
            const item = parseValue(bytes, at, depth + 1);
            items.push(item.value);
            at = skipSpace(bytes, item.end);
        }
        return { value: { kind: 'array', items }, end: at + 1 };
    }
    const { text, end } = token(bytes, pos);
    if (!text) throw new PdfSyntaxError('Unexpected PDF delimiter');
    if (NUMBER.test(text)) {
        // `n g R` is a reference only when both parts are unsigned integers.
        if (INTEGER.test(text)) {
            const second = token(bytes, skipSpace(bytes, end));
            if (INTEGER.test(second.text)) {
                const third = token(bytes, skipSpace(bytes, second.end));
                if (third.text === 'R') return { value: { kind: 'ref', num: Number(text), gen: Number(second.text) }, end: third.end };
            }
        }
        return { value: { kind: 'number', value: Number(text), raw: text }, end };
    }
    if (text === 'true' || text === 'false') return { value: { kind: 'bool', value: text === 'true' }, end };
    if (text === 'null') return { value: { kind: 'null' }, end };
    return { value: { kind: 'keyword', value: text }, end };
}

function literalString(bytes: Uint8Array, pos: number): { value: PdfValue; end: number } {
    const out: number[] = [];
    let depth = 1, at = pos + 1;
    while (at < bytes.length) {
        const byte = bytes[at++];
        if (byte === 0x5c) {
            const next = bytes[at++];
            if (next === undefined) break;
            const simple: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
            if (simple[next] !== undefined) out.push(simple[next]);
            else if (next >= 0x30 && next <= 0x37) {
                let code = next - 0x30;
                for (let i = 0; i < 2 && bytes[at] >= 0x30 && bytes[at] <= 0x37; i++) code = code * 8 + bytes[at++] - 0x30;
                out.push(code & 0xff);
            } else if (next === 13) { if (bytes[at] === 10) at++; }
            else if (next !== 10) out.push(next);
        } else if (byte === 0x28) { depth++; out.push(byte); }
        else if (byte === 0x29) { if (--depth === 0) return { value: { kind: 'string', bytes: Uint8Array.from(out) }, end: at }; out.push(byte); }
        else if (byte === 13) { out.push(10); if (bytes[at] === 10) at++; }
        else out.push(byte);
    }
    throw new PdfSyntaxError('Unterminated PDF string');
}

/** `n g obj`, returning the position after `obj`. */
export function parseObjectHeader(bytes: Uint8Array, start: number): { num: number; gen: number; end: number } {
    const pos = skipSpace(bytes, start);
    const a = token(bytes, pos), b = token(bytes, skipSpace(bytes, a.end)), c = token(bytes, skipSpace(bytes, b.end));
    if (!INTEGER.test(a.text) || !INTEGER.test(b.text) || c.text !== 'obj') throw new PdfSyntaxError('Expected a PDF object header');
    return { num: Number(a.text), gen: Number(b.text), end: c.end };
}

export function keywordAt(bytes: Uint8Array, start: number, word: string): number {
    const pos = skipSpace(bytes, start), { text, end } = token(bytes, pos);
    return text === word ? end : -1;
}

/** Start of stream data after the `stream` keyword (CRLF or LF; a bare CR is tolerated). */
export function streamDataStart(bytes: Uint8Array, afterDict: number): number {
    const end = keywordAt(bytes, afterDict, 'stream');
    if (end < 0) return -1;
    if (bytes[end] === 13 && bytes[end + 1] === 10) return end + 2;
    if (bytes[end] === 10 || bytes[end] === 13) return end + 1;
    throw new PdfSyntaxError('Invalid PDF stream start');
}

export const dictGet = (dict: PdfDictValue, key: string) => dict.entries.get(key);
export function asInt(value: PdfValue | undefined): number | undefined {
    return value?.kind === 'number' && Number.isSafeInteger(value.value) ? value.value : undefined;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unpredict(data: Uint8Array, params: PdfDictValue | undefined): Uint8Array {
    const predictor = params ? asInt(dictGet(params, 'Predictor')) ?? 1 : 1;
    if (predictor === 1) return data;
    if (predictor < 10 || predictor > 15) throw new PdfSyntaxError('Unsupported PDF stream predictor');
    const colors = asInt(params && dictGet(params, 'Colors')) ?? 1, bits = asInt(params && dictGet(params, 'BitsPerComponent')) ?? 8;
    const columns = asInt(params && dictGet(params, 'Columns')) ?? 1;
    const bpp = Math.max(1, Math.ceil(colors * bits / 8)), row = Math.ceil(colors * bits * columns / 8);
    if (row <= 0 || data.length % (row + 1)) throw new PdfSyntaxError('Malformed PDF predictor data');
    const rows = data.length / (row + 1), out = new Uint8Array(rows * row);
    for (let r = 0; r < rows; r++) {
        const type = data[r * (row + 1)], src = r * (row + 1) + 1, dst = r * row;
        for (let i = 0; i < row; i++) {
            const left = i >= bpp ? out[dst + i - bpp] : 0, up = r ? out[dst - row + i] : 0, corner = r && i >= bpp ? out[dst - row + i - bpp] : 0;
            const raw = data[src + i];
            let value: number;
            switch (type) {
                case 0: value = raw; break;
                case 1: value = raw + left; break;
                case 2: value = raw + up; break;
                case 3: value = raw + ((left + up) >> 1); break;
                case 4: {
                    const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
                    value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner); break;
                }
                default: throw new PdfSyntaxError('Malformed PDF predictor row');
            }
            out[dst + i] = value & 0xff;
        }
    }
    return out;
}

/** Decodes a stream this reader is allowed to need: none or FlateDecode, with PNG predictors. */
export async function decodeStream(dict: PdfDictValue, data: Uint8Array): Promise<Uint8Array> {
    const filter = dictGet(dict, 'Filter'), params = dictGet(dict, 'DecodeParms');
    const filters = filter === undefined ? [] : filter.kind === 'array' ? filter.items : [filter];
    if (filters.length > 1 || filters.some(item => item.kind !== 'name' || item.value !== 'FlateDecode')) throw new PdfSyntaxError('Unsupported PDF stream filter');
    if (!filters.length) return data;
    const parms = params?.kind === 'array' ? params.items[0] : params;
    return unpredict(await inflate(data), parms?.kind === 'dict' ? parms : undefined);
}

export type XrefEntry = { type: 1; offset: number; gen: number } | { type: 2; stream: number; index: number };
export interface PdfXrefSection {
    readonly kind: 'table' | 'stream';
    readonly offset: number;
    readonly trailer: PdfDictValue;
}

/** The byte offset after the last `startxref` keyword in [0, limit). */
export function readStartXref(bytes: Uint8Array, limit = bytes.length): number {
    const window = Math.max(0, limit - 2048);
    const tail = latin1(bytes, window, limit), at = tail.lastIndexOf('startxref');
    if (at < 0) throw new PdfSyntaxError('PDF has no startxref');
    const value = parseValue(bytes, window + at + 9);
    const offset = asInt(value.value);
    if (offset === undefined || offset < 0 || offset >= limit) throw new PdfSyntaxError('PDF startxref is out of range');
    return offset;
}

export interface ReadSectionResult extends PdfXrefSection {
    readonly entries: Map<number, XrefEntry>;
    readonly hybrid?: Map<number, XrefEntry>;
    /** Just past the trailer dictionary, or past the xref stream's `endobj`. */
    readonly end: number;
}

async function readStreamSection(bytes: Uint8Array, offset: number): Promise<{ entries: Map<number, XrefEntry>; dict: PdfDictValue; end: number }> {
    const header = parseObjectHeader(bytes, offset);
    const parsed = parseValue(bytes, header.end);
    if (parsed.value.kind !== 'dict') throw new PdfSyntaxError('PDF xref stream has no dictionary');
    const dict = parsed.value;
    const type = dictGet(dict, 'Type');
    if (type?.kind !== 'name' || type.value !== 'XRef') throw new PdfSyntaxError('PDF xref offset does not point at an xref stream');
    const start = streamDataStart(bytes, parsed.end), length = asInt(dictGet(dict, 'Length'));
    if (start < 0 || length === undefined || length < 0 || start + length > bytes.length) throw new PdfSyntaxError('PDF xref stream length is invalid');
    const data = await decodeStream(dict, bytes.subarray(start, start + length));
    const afterData = keywordAt(bytes, start + length, 'endstream'), end = afterData < 0 ? -1 : keywordAt(bytes, afterData, 'endobj');
    if (end < 0) throw new PdfSyntaxError('PDF xref stream is not terminated');
    const w = dictGet(dict, 'W'), size = asInt(dictGet(dict, 'Size'));
    if (w?.kind !== 'array' || w.items.length !== 3 || size === undefined) throw new PdfSyntaxError('PDF xref stream fields are invalid');
    const widths = w.items.map(item => asInt(item));
    if (widths.some(width => width === undefined || width < 0 || width > 8)) throw new PdfSyntaxError('PDF xref stream widths are invalid');
    const [w0, w1, w2] = widths as number[], rowWidth = w0 + w1 + w2;
    const index = dictGet(dict, 'Index');
    const ranges = index?.kind === 'array' ? index.items.map(item => asInt(item)) : [0, size];
    if (ranges.length % 2 || ranges.some(value => value === undefined || value < 0)) throw new PdfSyntaxError('PDF xref stream index is invalid');
    const entries = new Map<number, XrefEntry>();
    let at = 0;
    const field = (width: number, fallback: number) => {
        if (!width) return fallback;
        let value = 0;
        for (let i = 0; i < width; i++) value = value * 256 + data[at++];
        return value;
    };
    for (let r = 0; r < ranges.length; r += 2) {
        const first = ranges[r] as number, count = ranges[r + 1] as number;
        if (at + count * rowWidth > data.length) throw new PdfSyntaxError('PDF xref stream is truncated');
        for (let i = 0; i < count; i++) {
            const kind = field(w0, 1), a = field(w1, 0), b = field(w2, 0), num = first + i;
            if (kind === 1) entries.set(num, { type: 1, offset: a, gen: b });
            else if (kind === 2) entries.set(num, { type: 2, stream: a, index: b });
        }
    }
    return { entries, dict, end };
}

function readTableSection(bytes: Uint8Array, offset: number): { entries: Map<number, XrefEntry>; trailer: PdfDictValue; end: number } {
    let at = keywordAt(bytes, offset, 'xref');
    if (at < 0) throw new PdfSyntaxError('PDF xref offset does not point at a table');
    const entries = new Map<number, XrefEntry>();
    for (;;) {
        const pos = skipSpace(bytes, at), first = token(bytes, pos);
        if (first.text === 'trailer') {
            const trailer = parseValue(bytes, first.end);
            if (trailer.value.kind !== 'dict') throw new PdfSyntaxError('PDF trailer is not a dictionary');
            return { entries, trailer: trailer.value, end: trailer.end };
        }
        const count = token(bytes, skipSpace(bytes, first.end));
        if (!INTEGER.test(first.text) || !INTEGER.test(count.text)) throw new PdfSyntaxError('Malformed PDF xref subsection');
        at = count.end;
        const start = Number(first.text), n = Number(count.text);
        for (let i = 0; i < n; i++) {
            const o = token(bytes, skipSpace(bytes, at)), g = token(bytes, skipSpace(bytes, o.end)), t = token(bytes, skipSpace(bytes, g.end));
            if (!INTEGER.test(o.text) || !INTEGER.test(g.text) || (t.text !== 'n' && t.text !== 'f')) throw new PdfSyntaxError('Malformed PDF xref entry');
            at = t.end;
            if (t.text === 'n' && !entries.has(start + i)) entries.set(start + i, { type: 1, offset: Number(o.text), gen: Number(g.text) });
        }
    }
}

/** One cross-reference section at `offset`, table or stream; a hybrid table carries its /XRefStm entries. */
export async function readXrefSection(bytes: Uint8Array, offset: number): Promise<ReadSectionResult> {
    if (keywordAt(bytes, offset, 'xref') >= 0) {
        const { entries, trailer, end } = readTableSection(bytes, offset);
        const stm = asInt(dictGet(trailer, 'XRefStm'));
        const hybrid = stm === undefined ? undefined : (await readStreamSection(bytes, stm)).entries;
        return { kind: 'table', offset, trailer, entries, hybrid, end };
    }
    const { entries, dict, end } = await readStreamSection(bytes, offset);
    return { kind: 'stream', offset, trailer: dict, entries, end };
}

/** The file's objects as its cross-reference chain defines them: newest section first. */
export class PdfObjectReader {
    readonly entries = new Map<number, XrefEntry>();
    private readonly objectStreams = new Map<number, Promise<Map<number, PdfValue>>>();
    private constructor(readonly bytes: Uint8Array, readonly last: ReadSectionResult) {}

    static async open(bytes: Uint8Array, limit = bytes.length): Promise<PdfObjectReader> {
        const view = limit === bytes.length ? bytes : bytes.subarray(0, limit);
        const first = await readXrefSection(view, readStartXref(view));
        const reader = new PdfObjectReader(view, first);
        const seen = new Set<number>();
        let section: ReadSectionResult | undefined = first;
        while (section) {
            if (seen.has(section.offset) || seen.size > 4096) throw new PdfSyntaxError('PDF xref chain loops');
            seen.add(section.offset);
            for (const [num, entry] of section.entries) if (!reader.entries.has(num)) reader.entries.set(num, entry);
            if (section.hybrid) for (const [num, entry] of section.hybrid) if (!reader.entries.has(num)) reader.entries.set(num, entry);
            const prev = asInt(dictGet(section.trailer, 'Prev'));
            section = prev === undefined ? undefined : await readXrefSection(view, prev);
        }
        return reader;
    }

    /** Where an object's own bytes are, when it is not inside an object stream. */
    location(num: number): { offset: number; gen: number } | undefined {
        const entry = this.entries.get(num);
        return entry?.type === 1 ? { offset: entry.offset, gen: entry.gen } : undefined;
    }

    generation(num: number): number | undefined {
        const entry = this.entries.get(num);
        return entry ? entry.type === 1 ? entry.gen : 0 : undefined;
    }

    async object(num: number): Promise<PdfValue> {
        const entry = this.entries.get(num);
        if (!entry) throw new PdfSyntaxError(`PDF object ${num} is missing`);
        if (entry.type === 1) {
            const header = parseObjectHeader(this.bytes, entry.offset);
            if (header.num !== num) throw new PdfSyntaxError(`PDF object ${num} is not where its xref says`);
            return parseValue(this.bytes, header.end).value;
        }
        let stream = this.objectStreams.get(entry.stream);
        if (!stream) { stream = this.readObjectStream(entry.stream); this.objectStreams.set(entry.stream, stream); }
        const value = (await stream).get(num);
        if (!value) throw new PdfSyntaxError(`PDF object ${num} is missing from its object stream`);
        return value;
    }

    async resolve(value: PdfValue | undefined): Promise<PdfValue | undefined> {
        let current = value;
        for (let hops = 0; current?.kind === 'ref'; hops++) {
            if (hops > 32) throw new PdfSyntaxError('PDF reference chain is too long');
            current = await this.object(current.num);
        }
        return current;
    }

    private async readObjectStream(num: number): Promise<Map<number, PdfValue>> {
        const location = this.location(num);
        if (!location) throw new PdfSyntaxError('PDF object stream is itself compressed');
        const header = parseObjectHeader(this.bytes, location.offset);
        const parsed = parseValue(this.bytes, header.end);
        if (parsed.value.kind !== 'dict') throw new PdfSyntaxError('PDF object stream has no dictionary');
        const dict = parsed.value, start = streamDataStart(this.bytes, parsed.end);
        let length = asInt(dictGet(dict, 'Length'));
        const lengthRef = dictGet(dict, 'Length');
        if (length === undefined && lengthRef?.kind === 'ref') length = asInt(await this.resolve(lengthRef));
        const count = asInt(dictGet(dict, 'N')), first = asInt(dictGet(dict, 'First'));
        if (start < 0 || length === undefined || count === undefined || first === undefined || start + length > this.bytes.length) {
            throw new PdfSyntaxError('PDF object stream is malformed');
        }
        const data = await decodeStream(dict, this.bytes.subarray(start, start + length));
        const objects = new Map<number, PdfValue>();
        let at = 0;
        const pairs: Array<[number, number]> = [];
        for (let i = 0; i < count; i++) {
            const a = parseValue(data, at), b = parseValue(data, a.end);
            const n = asInt(a.value), o = asInt(b.value);
            if (n === undefined || o === undefined) throw new PdfSyntaxError('PDF object stream index is malformed');
            pairs.push([n, o]); at = b.end;
        }
        for (const [n, o] of pairs) objects.set(n, parseValue(data, first + o).value);
        return objects;
    }
}

/** Equality of two parsed values, ignoring how they were spelled (numbers by value). */
export function sameValue(a: PdfValue, b: PdfValue): boolean {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
        case 'number': return a.value === (b as PdfNumberValue).value;
        case 'name': case 'keyword': return a.value === (b as PdfNameValue).value;
        case 'bool': return a.value === (b as { value: boolean }).value;
        case 'null': return true;
        case 'ref': return a.num === (b as PdfRefValue).num && a.gen === (b as PdfRefValue).gen;
        case 'string': { const other = (b as PdfStringValue).bytes; return a.bytes.length === other.length && a.bytes.every((v, i) => v === other[i]); }
        case 'array': { const other = (b as { items: PdfValue[] }).items; return a.items.length === other.length && a.items.every((v, i) => sameValue(v, other[i])); }
        case 'dict': {
            const other = (b as PdfDictValue).entries;
            if (a.entries.size !== other.size) return false;
            for (const [key, value] of a.entries) { const peer = other.get(key); if (!peer || !sameValue(value, peer)) return false; }
            return true;
        }
    }
}

const hexDigits = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
function serializeName(name: string): string {
    let out = '/';
    for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code > 0xff) throw new PdfSyntaxError('PDF name is not bytes');
        out += code > 0x20 && code < 0x7f && code !== 0x23 && !DELIM.has(code) ? name[i] : '#' + code.toString(16).padStart(2, '0');
    }
    return out;
}

/** PDF syntax for a parsed value: numbers keep their spelling, strings become hex (byte-exact). */
export function serializeValue(value: PdfValue): string {
    switch (value.kind) {
        case 'number': return value.raw;
        case 'name': return serializeName(value.value);
        case 'string': return `<${hexDigits(value.bytes)}>`;
        case 'ref': return `${value.num} ${value.gen} R`;
        case 'bool': return value.value ? 'true' : 'false';
        case 'null': return 'null';
        case 'keyword': throw new PdfSyntaxError('A PDF keyword is not a value');
        case 'array': return `[${value.items.map(serializeValue).join(' ')}]`;
        case 'dict': return `<<${[...value.entries].map(([key, item]) => `${serializeName(key)} ${serializeValue(item)}`).join(' ')}>>`;
    }
}
