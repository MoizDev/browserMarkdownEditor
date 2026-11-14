import type { MediaId } from '../model/media';
import type { BoardPayload, CopySnapshot } from './snapshot';
import { clipboardTextRendition } from './rendition';

const HTML_LIMIT = 64 * 1024 * 1024;
const INLINE_LIMIT = 32 * 1024 * 1024;
const COMPRESS_THRESHOLD = 64 * 1024;

export interface ClipboardEnvelope {
    readonly html: string;
    readonly plain: string;
    readonly encoded: string;
    readonly cacheOnly: boolean;
}

function base64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32766) {
        const end = Math.min(bytes.length, offset + 32766);
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, end))));
    }
    return chunks.join('');
}
function base64url(bytes: Uint8Array): string {
    return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function jsonBytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }

function marker(snapshot: CopySnapshot): object {
    return { v: 1, nonce: snapshot.payload.nonce, from: snapshot.payload.from, bounds: snapshot.payload.bounds,
        cacheOnly: true, records: [], media: {} };
}
function render(snapshot: CopySnapshot, encoded: string, cacheOnly: boolean): ClipboardEnvelope {
    const rendition = clipboardTextRendition(snapshot.textItems);
    const div = rendition.element;
    div.setAttribute('data-wb-board', '1');
    div.setAttribute('data-wb-nonce', snapshot.payload.nonce);
    const span = div.ownerDocument.createElement('span');
    span.setAttribute('data-wb-board-payload', encoded);
    div.append(span);
    const meta = div.ownerDocument.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    let html = meta.outerHTML + div.outerHTML;
    if (new TextEncoder().encode(html).length > HTML_LIMIT) {
        if (!cacheOnly) return render(snapshot, `u.${base64url(jsonBytes(marker(snapshot)))}`, true);
        while (div.firstChild && div.firstChild !== span) div.firstChild.remove();
        html = meta.outerHTML + div.outerHTML;
    }
    return { html, plain: rendition.plain, encoded, cacheOnly };
}

/** Synchronous copy never waits for media reads or compression. */
export function encodeClipboardNow(snapshot: CopySnapshot, inline: ReadonlyMap<MediaId, string>): ClipboardEnvelope {
    let total = 0, complete = true;
    const media: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const entry of snapshot.media) {
        total += entry.bytes;
        if (total > INLINE_LIMIT) break;
        const bytes = inline.get(entry.id);
        if (bytes === undefined) complete = false;
        else media[entry.id] = bytes;
    }
    // A just-changed selection may not have inline bytes yet. Native records
    // still carry identities and sizes, so another window can resolve by hash.
    if (total > INLINE_LIMIT || !complete) for (const key of Object.keys(media)) delete media[key];
    const payload: BoardPayload = { ...snapshot.payload, media };
    const estimate = payload.records.reduce((sum, line) => sum + line.length, 0) + Object.values(media).reduce((sum, value) => sum + value.length, 0);
    if (estimate > HTML_LIMIT * 3 / 4) return render(snapshot, `u.${base64url(jsonBytes(marker(snapshot)))}`, true);
    const bytes = jsonBytes(payload);
    if (bytes.length > HTML_LIMIT * 3 / 4) return render(snapshot, `u.${base64url(jsonBytes(marker(snapshot)))}`, true);
    return render(snapshot, `u.${base64url(bytes)}`, false);
}

/** Call off the copy event; the session owns the source blobs and verifies their hashes. */
export async function prepareInlineMedia(snapshot: CopySnapshot, read: (id: MediaId, signal: AbortSignal) => Promise<Blob | null>, signal: AbortSignal): Promise<ReadonlyMap<MediaId, string>> {
    const result = new Map<MediaId, string>();
    const total = snapshot.media.reduce((sum, entry) => sum + entry.bytes, 0);
    if (total > INLINE_LIMIT) return result;
    for (const entry of snapshot.media) {
        signal.throwIfAborted();
        const blob = await read(entry.id, signal);
        signal.throwIfAborted();
        if (!blob || blob.size !== entry.bytes) continue;
        result.set(entry.id, base64(new Uint8Array(await blob.arrayBuffer())));
    }
    signal.throwIfAborted();
    return result;
}

export async function compressClipboard(snapshot: CopySnapshot, envelope: ClipboardEnvelope, signal: AbortSignal): Promise<ClipboardEnvelope> {
    if (envelope.cacheOnly || !envelope.encoded.startsWith('u.')) return envelope;
    const encoded = envelope.encoded.slice(2).replaceAll('-', '+').replaceAll('_', '/');
    const raw = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (raw.length <= COMPRESS_THRESHOLD) return envelope;
    signal.throwIfAborted();
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    signal.throwIfAborted();
    return render(snapshot, `d.${base64url(compressed)}`, false);
}
