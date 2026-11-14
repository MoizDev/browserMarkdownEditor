import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { FORMAT_LIMITS } from '../format/schema';
import { SECURITY_LIMITS } from '../security/limits';
import { boardWorker, importDeadline } from '../workers/client';
import { closeWorkerResult, validBoardIdentity } from '../workers/protocol';
import type { BoardJobIdentity } from '../workers/protocol';
import type { DecodedBoardClipboard } from '../workers/clipboardDecode';

// Provenance: private clipboard limits, C4 accounting and C5 worker contracts;
// independent acquisition boundary, no third-party source.
const JSON_LIMIT = SECURITY_LIMITS.clipboardExpandedBytes, INLINE_LIMIT = SECURITY_LIMITS.inlineMediaBytes;
const ENCODED_LIMIT = SECURITY_LIMITS.clipboardHtmlBytes;
export interface BoardClipboardDecodeLease extends DecodedBoardClipboard { release(): void }
async function validReply(value: unknown, check: () => void): Promise<boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const reply = value as Record<string, unknown>, payload = reply.payload;
    if (typeof reply.cacheOnly !== 'boolean' || !Array.isArray(reply.inline) || reply.inline.length > SECURITY_LIMITS.clipboardNodes
        || !payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const p = payload as Record<string, unknown>, from = p.from, bounds = p.bounds;
    if (p.v !== 1 || typeof p.nonce !== 'string' || !/^[A-Za-z0-9]{16}$/.test(p.nonce)
        || !from || typeof from !== 'object' || Array.isArray(from) || !bounds || typeof bounds !== 'object' || Array.isArray(bounds)
        || !Array.isArray(p.records) || p.records.length > SECURITY_LIMITS.clipboardRecords
        || !p.media || typeof p.media !== 'object' || Array.isArray(p.media)) return false;
    const f = from as Record<string, unknown>, b = bounds as Record<string, unknown>;
    if (typeof f.board !== 'string' || !f.board.length || f.board.length > 128 || typeof f.sheet !== 'string' || !f.sheet.length || f.sheet.length > 128
        || (f.kind !== 'whiteboard' && f.kind !== 'notebook' && f.kind !== 'pdf-ink')
        || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.w !== 'number' || typeof b.h !== 'number'
        || ![b.x, b.y, b.w, b.h, b.x + b.w, b.y + b.h].every(Number.isFinite) || b.w < 0 || b.h < 0) return false;
    let recordBytes = 0, total = 0, visits = 0;
    const yieldToHost = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    for (const record of p.records) {
        if (typeof record !== 'string' || record.length > FORMAT_LIMITS.recordBytes) return false;
        let length = 0;
        for (let i = 0; i < record.length; i += 65536) {
            let end = Math.min(record.length, i + 65536);
            if (end < record.length && record.charCodeAt(end - 1) >= 0xd800 && record.charCodeAt(end - 1) <= 0xdbff) end--;
            if (end === i) return false;
            length += new TextEncoder().encode(record.slice(i, end)).byteLength;
            i = end - 65536;
            if (length > FORMAT_LIMITS.recordBytes || length > JSON_LIMIT - recordBytes) return false;
            if ((++visits & 255) === 0) { await yieldToHost(); check(); }
        }
        recordBytes += length;
    }
    const media = p.media as Record<string, unknown>, seen = new Set<string>();
    for (const entry of reply.inline) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const item = entry as Record<string, unknown>, id = item.id;
        if (typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id) || seen.has(id)
            || !(item.blob instanceof Blob) || (typeof File !== 'undefined' && item.blob instanceof File)
            || item.blob.size > SECURITY_LIMITS.mediaBytes || item.blob.size > INLINE_LIMIT - total
            || !Object.hasOwn(media, id) || typeof media[id] !== 'string'
            || (media[id] as string).length !== 4 * Math.ceil(item.blob.size / 3)) return false;
        total += item.blob.size; seen.add(id);
        if ((++visits & 255) === 0) { await yieldToHost(); check(); }
    }
    let keys = 0;
    for (const key in media) {
        if (!Object.hasOwn(media, key) || !seen.has(key)) return false;
        keys++;
        if ((++visits & 255) === 0) { await yieldToHost(); check(); }
    }
    if (keys !== seen.size || (reply.cacheOnly && (p.records.length > 0 || seen.size > 0))) return false;
    return true;
}
/** Reserve before transport; release the returned lease only when all decoded data is unused. */
export async function decodeBoardClipboard(options: {
    readonly encoded: Blob;
    readonly identity: BoardJobIdentity;
    readonly memory: MemoryAllocator;
    isCurrent(identity: BoardJobIdentity): boolean;
    readonly signal?: AbortSignal;
}): Promise<BoardClipboardDecodeLease> {
    const { encoded } = options;
    options.signal?.throwIfAborted();
    if (!(encoded instanceof Blob) || (typeof File !== 'undefined' && encoded instanceof File) || encoded.size < 3 || encoded.size > ENCODED_LIMIT
        || !validBoardIdentity(options.identity)) throw new TypeError('Clipboard decoding requires a bounded copied Blob and valid identity');
    const identity = Object.freeze({ ...options.identity });
    const check = () => { options.signal?.throwIfAborted(); if (!options.isCurrent(identity)) throw new DOMException('Clipboard job became stale', 'AbortError'); };
    check();
    // Measure deflate as a streaming worker pass before reserving its actual expanded size.
    const mode = await encoded.slice(0, 2).text(); check();
    if (mode !== 'u.' && mode !== 'd.') throw new TypeError('Unknown clipboard envelope');
    let expanded = Math.min(JSON_LIMIT, Math.ceil(Math.max(0, encoded.size - 2) * 3 / 4));
    if (mode === 'd.') {
        const measuring = options.memory.reserve(encoded.size * 3 + 4 * 1024 * 1024);
        if (!measuring) throw new Error('Insufficient memory to measure clipboard decoding');
        try {
            const size = await boardWorker('parse').request<unknown>('clipboardDecode', { encoded, measure: true }, identity,
                { priority: 0, cpu: 'governed', deadlineMs: importDeadline(encoded.size), signal: options.signal }, options.isCurrent);
            check();
            if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > JSON_LIMIT) throw new TypeError('Invalid clipboard expansion measurement');
            expanded = size as number;
        } finally { options.memory.release(measuring); }
    }
    const lease = options.memory.reserve(encoded.size + 5 * expanded + 1024 * 1024);
    if (!lease) throw new Error('Insufficient memory for clipboard decoding');
    let value: unknown, owned = true;
    const release = () => { if (owned) { owned = false; options.memory.release(lease); } };
    try {
        value = await boardWorker('parse').request('clipboardDecode', { encoded }, identity,
            { priority: 0, cpu: 'governed', deadlineMs: importDeadline(encoded.size), signal: options.signal }, options.isCurrent);
        check();
        if (!await validReply(value, check)) throw new TypeError('Invalid clipboard worker response');
        check();
        return { ...(value as DecodedBoardClipboard), release };
    } catch (error) { closeWorkerResult(value); release(); throw error; }
}
