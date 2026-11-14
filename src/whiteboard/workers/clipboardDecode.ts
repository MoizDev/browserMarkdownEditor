import type { WorkerContext } from '../../platform/workers';
import { parseJsonIncremental, type JsonSpan } from '../format/jsonRead';
import { FORMAT_LIMITS } from '../format/schema';
import { hashMedia } from '../media/sha256';
import type { MediaId } from '../model/media';
import type { BoardPayload } from '../clipboard/snapshot';
import type { SheetId } from '../model/ids';
import { SECURITY_LIMITS } from '../security/limits';

// Provenance: private clipboard envelope, SEC-W1/W4, native limits and C5
// transport contracts; independent bounded worker decoder, no third-party source.
export const CLIPBOARD_JSON_LIMIT = SECURITY_LIMITS.clipboardExpandedBytes;
export const CLIPBOARD_INLINE_LIMIT = SECURITY_LIMITS.inlineMediaBytes;
export const CLIPBOARD_ENCODED_LIMIT = SECURITY_LIMITS.clipboardHtmlBytes;
export interface DecodedBoardClipboard {
    readonly payload: BoardPayload;
    readonly cacheOnly: boolean;
    readonly inline: readonly { readonly id: MediaId; readonly blob: Blob }[];
}
const CHUNK = 64 * 1024;
async function decodeOuter(blob: Blob, context: WorkerContext): Promise<{ mode: string; bytes: Blob }> {
    if (blob.size < 3 || blob.size > CLIPBOARD_ENCODED_LIMIT) throw new RangeError('Clipboard envelope exceeds its limit');
    let carry = '', mode = '', size = 0;
    const parts: BlobPart[] = [];
    const add = (text: string, final: boolean) => {
        if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('Invalid clipboard base64url');
        carry += text;
        const take = final ? carry.length : carry.length - carry.length % 4;
        const chunk = carry.slice(0, take); carry = carry.slice(take);
        if (!chunk) return;
        if (final && chunk.length % 4 === 1) throw new TypeError('Invalid clipboard base64url length');
        let binary: string;
        try { binary = atob(chunk.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - chunk.length % 4) % 4)); }
        catch { throw new TypeError('Invalid clipboard base64url'); }
        if (final && btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== chunk) throw new TypeError('Noncanonical clipboard base64url');
        if (binary.length > CLIPBOARD_JSON_LIMIT - size) throw new RangeError('Clipboard binary exceeds its limit');
        size += binary.length; parts.push(Uint8Array.from(binary, char => char.charCodeAt(0)));
    };
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
        context.signal.throwIfAborted();
        let text = await blob.slice(offset, offset + CHUNK).text();
        if (!mode) { mode = text.slice(0, 2); text = text.slice(2); if (mode !== 'u.' && mode !== 'd.') throw new TypeError('Unknown clipboard envelope'); }
        add(text, false); await context.slice();
    }
    add('', true);
    return { mode, bytes: new Blob(parts) };
}
async function measureJson(blob: Blob, compressed: boolean, context: WorkerContext): Promise<number> {
    let stream: ReadableStream<Uint8Array> = blob.stream();
    if (compressed) {
        if (typeof DecompressionStream === 'undefined') throw new Error('Clipboard decompression is unavailable');
        stream = stream.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    }
    const reader = stream.getReader(); let total = 0;
    const abort = () => { void reader.cancel(context.signal.reason).catch(() => {}); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
        for (;;) {
            context.signal.throwIfAborted(); const part = await reader.read(); context.signal.throwIfAborted();
            if (part.done) break;
            if (part.value.byteLength > CLIPBOARD_JSON_LIMIT - total) throw new RangeError('Clipboard JSON exceeds its limit');
            total += part.value.byteLength; await context.slice();
        }
        return total;
    } finally { context.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function readJson(blob: Blob, compressed: boolean, context: WorkerContext): Promise<string> {
    let stream: ReadableStream<Uint8Array> = blob.stream();
    if (compressed) {
        if (typeof DecompressionStream === 'undefined') throw new Error('Clipboard decompression is unavailable');
        stream = stream.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    }
    const reader = stream.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }), chunks: string[] = [];
    let total = 0;
    const abort = () => { void reader.cancel(context.signal.reason).catch(() => {}); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
        for (;;) {
            context.signal.throwIfAborted();
            const part = await reader.read(); context.signal.throwIfAborted();
            if (part.done) break;
            if (part.value.byteLength > CLIPBOARD_JSON_LIMIT - total) throw new RangeError('Clipboard JSON exceeds its limit');
            total += part.value.byteLength; chunks.push(decoder.decode(part.value, { stream: true })); await context.slice();
        }
        chunks.push(decoder.decode());
        return chunks.join('');
    } finally { context.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function fields(span: JsonSpan, allowed: readonly string[], context: WorkerContext): Promise<Map<string, JsonSpan>> {
    if (span.kind !== 'object') throw new TypeError('Clipboard field must be an object');
    const result = new Map<string, JsonSpan>();
    for await (const [key, value] of span.fieldsIncremental(context.slice)) {
        if (!allowed.includes(key) || result.has(key)) throw new TypeError('Unknown or duplicate clipboard field');
        result.set(key, value);
    }
    return result;
}
async function text(span: JsonSpan | undefined, limit: number, context: WorkerContext): Promise<string> {
    if (!span || span.kind !== 'string') throw new TypeError('Missing clipboard string');
    return span.stringIncremental(limit, context.slice);
}
function number(span: JsonSpan | undefined): number {
    if (!span || span.kind !== 'number') throw new TypeError('Missing clipboard number');
    const value = span.number(); if (!Number.isFinite(value)) throw new RangeError('Nonfinite clipboard bounds'); return value;
}
async function inlineBlob(encoded: string, context: WorkerContext): Promise<Blob> {
    if (encoded.length > 4 * Math.ceil(SECURITY_LIMITS.mediaBytes / 3) || encoded.length % 4 !== 0) throw new RangeError('Clipboard media exceeds its limit');
    const parts: BlobPart[] = []; let size = 0;
    for (let at = 0; at < encoded.length; at += CHUNK) {
        context.signal.throwIfAborted();
        const input = encoded.slice(at, at + CHUNK), last = at + CHUNK >= encoded.length;
        if (!(last ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9+/]*$/).test(input)) throw new TypeError('Invalid inline media encoding');
        let decoded: string;
        try { decoded = atob(input); } catch { throw new TypeError('Invalid inline media encoding'); }
        if (last && btoa(decoded) !== input) throw new TypeError('Noncanonical inline media encoding');
        if (decoded.length > SECURITY_LIMITS.mediaBytes - size) throw new RangeError('Clipboard media exceeds its limit');
        size += decoded.length; parts.push(Uint8Array.from(decoded, char => char.charCodeAt(0))); await context.slice();
    }
    return new Blob(parts);
}
export async function clipboardDecode(payload: unknown, context: WorkerContext): Promise<DecodedBoardClipboard | number> {
    const request = payload as { encoded?: unknown; measure?: unknown } | null, blob = request?.encoded;
    if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File)
        || request?.measure !== undefined && request.measure !== true) throw new TypeError('Clipboard decoder requires copied Blob');
    const decoded = await decodeOuter(blob, context);
    if (request?.measure === true) return measureJson(decoded.bytes, decoded.mode === 'd.', context);
    const source = await readJson(decoded.bytes, decoded.mode === 'd.', context);
    const root = await fields(await parseJsonIncremental(source, context.slice), ['v', 'nonce', 'from', 'bounds', 'records', 'media', 'cacheOnly'], context);
    if (number(root.get('v')) !== 1) throw new TypeError('Unsupported clipboard version');
    const nonce = await text(root.get('nonce'), 16, context);
    if (!/^[A-Za-z0-9]{16}$/.test(nonce)) throw new TypeError('Invalid clipboard nonce');
    const fromSpan = root.get('from'), boundsSpan = root.get('bounds');
    if (!fromSpan || !boundsSpan) throw new TypeError('Missing clipboard metadata');
    const from = await fields(fromSpan, ['board', 'sheet', 'kind'], context), bounds = await fields(boundsSpan, ['x', 'y', 'w', 'h'], context);
    const board = await text(from.get('board'), 128, context), sheet = await text(from.get('sheet'), 128, context), kind = await text(from.get('kind'), 32, context);
    if (!board || !sheet || !['whiteboard', 'notebook', 'pdf-ink'].includes(kind)) throw new TypeError('Invalid clipboard source');
    const box = { x: number(bounds.get('x')), y: number(bounds.get('y')), w: number(bounds.get('w')), h: number(bounds.get('h')) };
    if (box.w < 0 || box.h < 0 || !Number.isFinite(box.x + box.w) || !Number.isFinite(box.y + box.h)) throw new RangeError('Invalid clipboard bounds');
    const recordsSpan = root.get('records'), mediaSpan = root.get('media');
    if (!recordsSpan || recordsSpan.kind !== 'array' || !mediaSpan || mediaSpan.kind !== 'object') throw new TypeError('Invalid clipboard records or media');
    const records: string[] = []; let recordBytes = 0;
    for await (const item of recordsSpan.itemsIncremental(context.slice)) {
        if (records.length >= SECURITY_LIMITS.clipboardRecords) throw new RangeError('Too many clipboard records');
        const line = await text(item, FORMAT_LIMITS.recordBytes, context);
        const length = new TextEncoder().encode(line).byteLength;
        if (length > FORMAT_LIMITS.recordBytes || length > CLIPBOARD_JSON_LIMIT - recordBytes) throw new RangeError('Clipboard records exceed their limit');
        if ((await parseJsonIncremental(line, context.slice)).kind !== 'object') throw new TypeError('Clipboard record must be a JSON object');
        recordBytes += length; records.push(line);
    }
    const media: Record<string, string> = Object.create(null) as Record<string, string>, inline: { id: MediaId; blob: Blob }[] = [];
    const seenMedia = new Set<string>();
    let total = 0;
    for await (const [id, item] of mediaSpan.fieldsIncremental(context.slice)) {
        if (!/^sha256:[0-9a-f]{64}$/.test(id) || seenMedia.has(id) || seenMedia.size >= SECURITY_LIMITS.clipboardNodes) throw new TypeError('Invalid clipboard media identity');
        seenMedia.add(id);
        const encoded = await text(item, 4 * Math.ceil(SECURITY_LIMITS.mediaBytes / 3), context);
        const expected = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
        if (!Number.isSafeInteger(expected) || expected < 0 || expected > CLIPBOARD_INLINE_LIMIT - total) throw new RangeError('Inline clipboard media exceeds its limit');
        const bytes = await inlineBlob(encoded, context);
        if (bytes.size > CLIPBOARD_INLINE_LIMIT - total) throw new RangeError('Inline clipboard media exceeds its limit');
        total += bytes.size;
        if (await hashMedia(bytes, context.signal, context.slice) !== id) continue;
        media[id] = encoded; inline.push({ id: id as MediaId, blob: bytes });
    }
    const marker = root.get('cacheOnly');
    if (marker && (marker.kind !== 'boolean' || marker.text() !== 'true')) throw new TypeError('Invalid cache-only marker');
    const cacheOnly = !!marker;
    if (cacheOnly && (records.length || seenMedia.size)) throw new TypeError('Cache-only marker cannot contain records');
    context.signal.throwIfAborted();
    return { payload: { v: 1, nonce, from: { board, sheet: sheet as SheetId, kind: kind as BoardPayload['from']['kind'] }, bounds: box, records, media }, cacheOnly, inline };
}
