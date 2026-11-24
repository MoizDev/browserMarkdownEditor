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
    // Each tile and mip decode asks for its source. A Blob is immutable, so bytes admitted once under this id stay admitted: the
    // inspection (a SHA-256 of the whole file and a whole-picture verification decode) runs once per Blob, not once per raster.
    // Inspected per raster, every tile of a large picture cost two decodes in the shared media worker, and the verification decodes
    // queued ahead of the rasters the picture was waiting for (measured, a 4000x3000 JPEG inserted on a drawing: 4 verification
    // decodes of the whole picture besides the insert's own, one before each raster).
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
        // The board entry can change under the same bytes (an edit of the document): checked on every call.
        if (entry.mime !== source.mime || entry.bytes !== source.blob.size || entry.w !== source.width || entry.h !== source.height
            || entry.animated !== source.animated) throw new Error('Media bytes do not match their board entry');
        return source;
    };
}
