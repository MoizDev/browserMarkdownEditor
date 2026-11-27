import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import { Limiter } from '../../utils/pool';
import { boardRecoveryMedia } from '../format/recoveryRecipe';
import type { MediaLease, MediaStore } from '../media/store';
import { isSafeMediaFile, type MediaId } from '../model/media';

export async function restoreRecoveredMediaFromHost(
    payload: unknown, host: NativeCanvasHost, identity: NativeCanvasIdentity, store: MediaStore,
    signal: AbortSignal, isCurrent: () => boolean,
): Promise<{ readonly files: ReadonlyMap<MediaId, string>; release(): void }> {
    const assets = boardRecoveryMedia(payload), limiter = new Limiter();
    const files = new Map<MediaId, string>(), leases: MediaLease[] = [];
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        for (const lease of leases.splice(0)) lease.release();
    };
    const check = () => {
        signal.throwIfAborted();
        if (released || !host.isCurrent(identity) || !isCurrent()) throw new DOMException('Board recovery is no longer current', 'AbortError');
    };
    try {
        check();
        const results = await Promise.allSettled(assets.map(asset => limiter.run(async () => {
            check();
            const name = await host.putMedia(identity, { hash: asset.hash, preferredName: asset.file, extension: asset.extension }, asset.blob, signal);
            check();
            if (!isSafeMediaFile(name) || name === null) throw new Error('Recovery returned an invalid media filename');
            const id = asset.id as MediaId;
            const lease = store.retain(id, 'journal');
            leases.push(lease);
            store.put(id, asset.blob);
            files.set(id, name);
        })));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        check();
        return { files, release };
    } catch (error) {
        release();
        throw error;
    }
}
