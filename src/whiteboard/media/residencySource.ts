import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { MediaEntry, MediaId } from '../model/media';
import type { BoardJobIdentity } from '../workers/protocol';
import { inspectMedia } from './inspect';
import type { MediaRasterSource } from './residency';
import type { MediaStore } from './store';

// Provenance: residency source adapter; independent. The hash and board-entry checks mirror
// the frame-zero path in paintImages.ts, so a tile decode never trusts bytes it has not admitted.
export interface ResidencySourceOptions {
    readonly media: MediaStore;
    readonly memory: MemoryAllocator;
    entry(id: MediaId): MediaEntry | undefined;
    readBlob(id: MediaId, signal: AbortSignal): Promise<Blob>;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
}

/** Local session bytes for one picture, hash-verified and checked against its board entry. Never fetches a URL. */
export function createResidencySource(options: ResidencySourceOptions): (id: MediaId, signal: AbortSignal) => Promise<MediaRasterSource | null> {
    return async (id, signal) => {
        const entry = options.entry(id);
        if (!entry || entry.id !== id || !entry.mime.startsWith('image/')) return null;
        let blob = options.media.get(id) ?? await options.readBlob(id, signal);
        signal.throwIfAborted();
        if (!(blob instanceof Blob) || (typeof File !== 'undefined' && blob instanceof File)) throw new TypeError('Media source must be copied Blob bytes');
        blob = blob.slice(0, blob.size, blob.type);
        const info = await inspectMedia(blob, { signal, memory: options.memory, identity: options.identity, isCurrent: options.isCurrent });
        if (info.id !== id) throw new Error('Media bytes do not match their content hash');
        if (entry.mime !== info.mime || entry.bytes !== blob.size || entry.w !== info.width || entry.h !== info.height
            || entry.animated !== info.animated) throw new Error('Media bytes do not match their board entry');
        return { blob, mime: info.mime, width: info.width, height: info.height, animated: info.animated };
    };
}
