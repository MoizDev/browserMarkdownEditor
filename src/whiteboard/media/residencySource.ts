import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { MediaEntry, MediaId } from '../model/media';
import type { BoardJobIdentity } from '../workers/protocol';
import { inspectMedia } from './inspect';
import type { MediaRasterSource } from './residency';
import type { MediaStore } from './store';

export interface ResidencySourceOptions {
    readonly media: MediaStore;
    readonly memory: MemoryAllocator;
    entry(id: MediaId): MediaEntry | undefined;
    readBlob(id: MediaId, signal: AbortSignal): Promise<Blob>;
    readonly identity: BoardJobIdentity;
    isCurrent(identity: BoardJobIdentity): boolean;
}

export function createResidencySource(options: ResidencySourceOptions): (id: MediaId, signal: AbortSignal) => Promise<MediaRasterSource | null> {
    const admitted = new WeakMap<Blob, { readonly id: MediaId; readonly source: MediaRasterSource }>();
    return async (id, signal) => {
        const entry = options.entry(id);
        if (!entry || entry.id !== id || !entry.mime.startsWith('image/')) return null;
        const held = options.media.get(id) ?? await options.readBlob(id, signal);
        signal.throwIfAborted();
        if (!(held instanceof Blob) || (typeof File !== 'undefined' && held instanceof File)) throw new TypeError('Media source must be copied Blob bytes');
        let source = admitted.get(held)?.id === id ? admitted.get(held)!.source : null;
        if (!source) {
            const blob = held.slice(0, held.size, held.type);
            const info = await inspectMedia(blob, { signal, memory: options.memory, identity: options.identity, isCurrent: options.isCurrent });
            if (info.id !== id) throw new Error('Media bytes do not match their content hash');
            source = { blob, mime: info.mime, width: info.width, height: info.height, animated: info.animated };
            admitted.set(held, { id, source });
        }
        if (entry.mime !== source.mime || entry.bytes !== source.blob.size || entry.w !== source.width || entry.h !== source.height
            || entry.animated !== source.animated) throw new Error('Media bytes do not match their board entry');
        return source;
    };
}
