import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import { isLocked } from '../change/commands';
import type { Op } from '../change/ops';
import type { BoardRuntime } from '../host/runtime';
import type { NodeId } from '../model/ids';
import type { MediaEntry } from '../model/media';
import type { JobContext } from '../security/admission';
import { checkMediaDimensions } from '../security/limits';
import { checkContentUrl, type UrlEnvironment } from '../security/urlPolicy';
import type { BoardJobIdentity } from '../workers/protocol';
import { inspectMedia } from './inspect';
import { resolveMediaStorage } from './storage';
import type { StoreMedia } from './storage.types';

export const PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024, PREVIEW_ICON_BYTES = 256 * 1024;
export type PreviewRole = 'image' | 'favicon';

export function previewAddress(declared: string, page: string, environment: UrlEnvironment, fallback: string | null = null): string | null {
    const raw = declared || fallback;
    if (!raw) return null;
    let resolved: URL;
    try { resolved = new URL(raw, page); } catch { return null; }
    if (resolved.protocol !== 'https:') return null;
    const decision = checkContentUrl(resolved.href, 'preview', environment);
    return decision.ok ? decision.url : null;
}

export async function fetchPreviewBytes(url: string, limit: number, memory: MemoryAllocator, signal: AbortSignal): Promise<Blob> {
    const lease = memory.reserve(limit);
    if (!lease) throw new Error('insufficient memory');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
            redirect: 'error', cache: 'no-store', signal });
        signal.throwIfAborted();
        if (!response.ok || !response.body) throw new Error('the server did not return it');
        const declared = response.headers.get('content-length');
        if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) throw new RangeError('it is larger than the limit');
        reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let bytes = 0;
        for (;;) {
            const chunk = await reader.read(); signal.throwIfAborted();
            if (chunk.done) break;
            if (chunk.value.byteLength > limit - bytes) throw new RangeError('it is larger than the limit');
            bytes += chunk.value.byteLength; chunks.push(new Uint8Array(chunk.value));
        }
        return new Blob(chunks);
    } finally {
        if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        memory.release(lease);
    }
}

export async function attachPreviewMedia(options: {
    readonly runtime: BoardRuntime; readonly memory: MemoryAllocator; readonly storeMedia: StoreMedia; readonly context: JobContext;
    readonly id: NodeId; readonly url: string; readonly role: PreviewRole; readonly limit: number; readonly current: () => boolean;
}): Promise<void> {
    const { runtime, context } = options, session = runtime.session, owner = session.owner, signal = context.signal;
    const start = session.doc.nodes.get(options.id);
    if (!start || start.kind !== 'linkcard') throw new Error('the card is no longer a link card');
    const url = start.url;
    const live = (identity: BoardJobIdentity) => {
        const doc = session.doc, node = doc.nodes.get(options.id);
        return identity.session === context.job.session && identity.epoch === context.job.vaultEpoch && runtime.jobs.isCurrent(context.job)
            && options.current() && runtime.session === session && session.owner === owner && !session.isReadOnly
            && !!node && node.kind === 'linkcard' && node.url === url && !isLocked(doc, node) && !!node.preview;
    };
    const check = (identity: BoardJobIdentity) => {
        context.assertCurrent();
        if (!live(identity)) throw new DOMException('Preview became stale', 'AbortError');
    };
    const bytes = await fetchPreviewBytes(options.url, options.limit, options.memory, signal);
    const identity: BoardJobIdentity = Object.freeze({ session: context.job.session, epoch: context.job.vaultEpoch, revision: session.doc.rev });
    const isCurrent = (value: BoardJobIdentity) => value.session === identity.session && value.epoch === identity.epoch && live(value);
    check(identity);
    const info = await inspectMedia(bytes, { memory: options.memory, identity, isCurrent, signal }); check(identity);
    const svg = info.mime === 'image/svg+xml';
    if (!info.mime.startsWith('image/') || (svg && options.role !== 'favicon') || info.duration !== null || !checkMediaDimensions(info.width, info.height).ok) {
        throw new Error('it is not a supported picture');
    }
    const doc = session.doc, existing = doc.media.get(info.id);
    if (existing && (existing.mime !== info.mime || existing.bytes !== bytes.size || existing.w !== info.width || existing.h !== info.height
        || existing.duration !== null || existing.animated !== info.animated)) throw new Error('stored media conflicts with the picture');
    const entry: MediaEntry = existing ?? { id: info.id, mime: info.mime, bytes: bytes.size, w: info.width, h: info.height,
        duration: null, animated: info.animated, name: options.role === 'image' ? 'preview image' : 'preview icon', file: null, ext: null };
    const location = existing ? runtime.media.currentFile(info.id) : undefined;
    const stored: MediaEntry = { ...entry, file: existing ? (location === undefined ? existing.file : location) : null };
    const proof = { runtime, context, inspection: info };
    const result = await options.storeMedia(stored, bytes, signal, proof);
    const storage = resolveMediaStorage(result, { ...proof, entry: stored, blob: bytes });
    let lease: { release(): void } | undefined;
    try {
        check(identity);
        const file = storage.file;
        if (existing && file !== existing.file && (existing.ext?.raw.size || existing.ext?.fields.size || (doc.preservedMediaRefs.get(info.id) ?? 0) > 0)) {
            throw new Error('stored media cannot be moved');
        }
        lease = runtime.media.retain(info.id, 'snapshot'); runtime.media.put(info.id, bytes);
        await session.enqueueAfterGesture(signal, () => {
            const node = session.doc.nodes.get(options.id);
            if (!node || node.kind !== 'linkcard' || !node.preview) throw new DOMException('Preview became stale', 'AbortError');
            check(identity);
            const previous = options.role === 'image' ? node.preview.image : node.preview.favicon;
            const ops: Op[] = [];
            if (!session.doc.media.has(info.id)) ops.push({ t: 'media', op: 'add', entry: { ...entry, file } });
            else if (existing && existing.file !== file) ops.push({ t: 'media', op: 'set-file', id: info.id, file });
            const preview = { ...node.preview, [options.role === 'image' ? 'image' : 'favicon']: info.id };
            ops.push({ t: 'set', id: options.id, key: 'preview', value: preview });
            if (previous && previous !== info.id && session.doc.mediaRefs.get(previous)?.size === 1
                && !(session.doc.preservedMediaRefs.get(previous) ?? 0)) ops.push({ t: 'media', op: 'drop', id: previous });
            session.history.open('Fetch preview');
            try {
                const applied = session.apply({ origin: 'host', label: 'Fetch preview', ops });
                try { runtime.media.setFile(info.id, file); storage.receipt?.committed(); } finally { applied.release(); }
            } finally { session.history.close(); }
        });
    } finally { storage.receipt?.release(); lease?.release(); }
}
