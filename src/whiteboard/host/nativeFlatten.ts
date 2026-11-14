import { flattenSelectionToImage, type FlattenOptions } from '../media/flatten';
import type { MediaEntry } from '../model/media';
import type { NodeId } from '../model/ids';
import { prepareNativeExport } from './nativeExport';

export interface NativeFlattenOptions extends Omit<FlattenOptions, 'capture'> {
    readonly boardName: string;
    readonly theme: 'light' | 'dark';
    /** App-owned immutable asset acquisition; never a direct filesystem read here. */
    readMedia(entry: MediaEntry, signal: AbortSignal): Promise<Blob | null>;
    notice(message: string): void;
    onError(error: unknown): void;
}

/** The existing single flatten mutation job owns actual capture, media admission,
 * attachment-aware deletion and replacement. Capture never starts another session job. */
export function flattenNativeSelection(options: NativeFlattenOptions): Promise<NodeId | null> {
    return flattenSelectionToImage({ ...options, async capture(roots, excludedLocked, signal) {
        const job = await prepareNativeExport({ runtime: options.runtime, route: 'copy', boardName: options.boardName,
            theme: options.theme, transparent: true, signal, maxSide: 8192,
            selection: { roots, excludeSubtrees: excludedLocked }, readMedia: options.readMedia,
            current: options.current, notice: options.notice, onError: options.onError });
        let transferred = false;
        try {
            signal.throwIfAborted();
            if (!job.topmostRoot) throw new RangeError('The flatten selection has no visible paint');
            const blob = await job.png(signal);
            signal.throwIfAborted();
            const capture = { blob, bounds: job.bounds, topmost: job.topmostRoot, release: () => job.release() };
            transferred = true;
            return capture;
        } finally { if (!transferred) job.release(); }
    } });
}
