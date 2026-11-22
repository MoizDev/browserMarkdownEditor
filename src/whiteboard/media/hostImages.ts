import { getPlatformRuntime } from '../../platform/render/platformRuntime';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { RenderToken } from '../../platform/render/types';
import type { MediaEntry, MediaId } from '../model/media';
import type { PaintImageProvider } from '../render/resources';
import { matchingIdentity, validBoardIdentity } from '../workers/protocol';
import type { BoardJobIdentity } from '../workers/protocol';
import { createBoardFullFrameDecoder } from './fullFrame';
import { isMediaTileKey } from './mips';
import { createBoardPaintImages } from './paintImages';
import { MediaResidency } from './residency';
import { createResidencySource } from './residencySource';
import { MediaStore } from './store';
import { videoFrameInProfile } from './videoFrameHost';
import { createVideoFrameRegistry, VIDEO_FRAME_PREFIX, type VideoFrameRegistry } from './videoFrames';

// Provenance: C4 shared memory governor, C5 contained media and paint image
// ownership contracts; independent per-view wiring, no third-party source.
let serial = 0;
export function createBoardHostImages(options: {
    readonly identity: BoardJobIdentity;
    readonly token: RenderToken;
    readonly media: MediaStore;
    readBlob(id: MediaId, signal: AbortSignal): Promise<Blob>;
    entry(id: MediaId): MediaEntry | undefined;
    current(token: RenderToken): boolean;
    onError(error: unknown): void;
    readonly signal?: AbortSignal;
    /** Repaints the view when a playing video presents a new frame. */
    readonly invalidate?: () => void;
}): PaintImageProvider & { dispose(): void; setVisible(visible: boolean): void; setDemand(keys: ReadonlySet<string>): void; readonly memory: MemoryAllocator; readonly frames: VideoFrameRegistry } {
    const identity = Object.freeze({ ...options.identity }), token = Object.freeze({ ...options.token });
    if (!validBoardIdentity(identity) || !Number.isSafeInteger(token.vaultEpoch) || token.vaultEpoch < 0
        || !Number.isSafeInteger(token.session) || token.session < 0 || !Number.isSafeInteger(token.bytesGeneration)
        || token.bytesGeneration < 0 || typeof token.documentId !== 'string' || !token.documentId) throw new TypeError('Invalid host image identity');
    const sameToken = (value: RenderToken) => value.vaultEpoch === token.vaultEpoch && value.documentId === token.documentId
        && value.bytesGeneration === token.bytesGeneration && value.session === token.session;
    let disposed = false, live = 0;
    const now = performance.now();
    const cache = getPlatformRuntime().governor.register({ id: `whiteboard-images:${token.documentId}:${token.session}:${++serial}`,
        owner: { vaultEpoch: token.vaultEpoch, documentId: token.documentId, session: token.session }, pool: 'cpu', kind: 'working',
        class: 'scene-cache', hiddenAt: null, lastVisibleAt: now, lastUsedAt: now,
        memory: () => ({ live, retiring: 0 }), evict: () => { /* No unleased warm entries are retained. */ } });
    const memory: MemoryAllocator = {
        reserve(bytes) { if (disposed) return null; const lease = cache.reserve(bytes); if (lease) live += lease.bytes; return lease; },
        release(lease) { cache.release(lease); live -= lease.bytes; },
    };
    const frames = createVideoFrameRegistry({ memory, invalidate: () => options.invalidate?.() });
    const currentIdentity = (value: BoardJobIdentity) => !disposed && matchingIdentity(identity, value) && options.current(token);
    const decoder = createBoardFullFrameDecoder({ identity, isCurrent: currentIdentity,
        reserveCpu(bytes) {
            const lease = memory.reserve(bytes);
            if (!lease) return null;
            let held = true;
            return { release() { if (held) { held = false; memory.release(lease); } } };
        },
        async video(blob, info, job, signal) {
            const extra = memory.reserve(info.width * info.height * 4 + blob.size * 3);
            if (!extra) throw new Error('Insufficient memory for contained video canvas');
            try {
                const result = await videoFrameInProfile(blob, info, job, currentIdentity, signal, 'frame');
                if (!(result instanceof ImageBitmap)) throw new Error('Contained video did not return a frame');
                return result;
            } finally { memory.release(extra); }
        },
    });
    const images = createBoardPaintImages({ media: options.media, memory, entry: options.entry, readBlob: options.readBlob,
        identity: value => { if (!sameToken(value)) throw new DOMException('Stale image token', 'AbortError'); return identity; },
        isCurrent: (value, job) => sameToken(value) && currentIdentity(job), decodeFullFrame: decoder });
    // Tile rasters are created on the first tile key, not per view: the residency recycles the shared decode worker
    // when it tears down mid-job, so a view that never paints a tile (every export path) must never own one.
    let residency: MediaResidency | undefined, visible = true;
    const tileResidency = (): MediaResidency => {
        if (disposed) throw new DOMException('Board images disposed', 'AbortError');
        if (residency) return residency;
        const created = new MediaResidency({ memory,
            source: createResidencySource({ media: options.media, memory, entry: options.entry, readBlob: options.readBlob, identity, isCurrent: currentIdentity }),
            identity: value => { if (!sameToken(value)) throw new DOMException('Stale image token', 'AbortError'); return identity; },
            isCurrent: (value, job) => sameToken(value) && currentIdentity(job) });
        if (!visible) created.setVisible(false);
        residency = created;
        return created;
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true; options.signal?.removeEventListener('abort', dispose);
        // Presented frames and tile rasters close before the decoder and cache they were drawn from.
        try { frames.dispose(); } finally { try { residency?.dispose(); } finally { try { images.dispose(); } finally { try { decoder.dispose(); } finally { cache.close(); } } } }
    };
    options.signal?.addEventListener('abort', dispose, { once: true });
    if (options.signal?.aborted) dispose();
    return {
        async acquire(key, value, signal) {
            try {
                if (key.startsWith(VIDEO_FRAME_PREFIX)) return await frames.lease(key, signal);
                if (isMediaTileKey(key)) return await tileResidency().acquire(key, value, signal);
                return await images.acquire(key, value, signal);
            }
            catch (error) {
                // A superseded or stopped video frame is the normal end of a paint, not a failure to report.
                const retired = error instanceof DOMException && error.name === 'AbortError';
                if (!disposed && !signal.aborted && !retired) { try { options.onError(error); } catch { /* Keep the decoder error. */ } }
                throw error;
            }
        },
        mediaSize(key: string) {
            const match = /^(?:sha256:([0-9a-f]{64})(?::0)?|media:([0-9a-f]{64}):0)$/.exec(key);
            if (!match) return null;
            const id = `sha256:${match[1] ?? match[2]}` as MediaId, entry = options.entry(id);
            return entry && Number.isSafeInteger(entry.w) && Number.isSafeInteger(entry.h) && entry.w > 0 && entry.h > 0 ? { id, mime: entry.mime, width: entry.w, height: entry.h } : null;
        },
        /** The tile keys the view last drew. Tile rasters outside them are released; a view that draws none never creates a residency. */
        setDemand(keys: ReadonlySet<string>) {
            if (disposed || (!residency && keys.size === 0)) return;
            tileResidency().setDemand(keys, new Set());
        },
        /** The view's one visibility signal for picture memory: a hidden pane releases tile rasters and stops their decodes. */
        setVisible(next: boolean) {
            if (disposed) return;
            visible = next;
            residency?.setVisible(next);
        },
        dispose,
        memory,
        frames,
    };
}
