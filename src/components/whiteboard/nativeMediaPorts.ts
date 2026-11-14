import type { NativeCanvasHost, NativeCanvasIdentity, NativeCanvasMedia } from '../../types/nativeCanvas';
import { mediaExtension } from '../../whiteboard/media/ingest';
import { MEDIA_MIMES, type MediaEntry, type MediaMime } from '../../whiteboard/model/media';

/** The host owns asset IO and hash verification; this boundary only maps board identities. */
export function createNativeMediaPorts(host: NativeCanvasHost, identity: NativeCanvasIdentity) {
    const assertCurrent = (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (!host.isCurrent(identity)) throw new DOMException('Canvas session ended', 'AbortError');
    };
    const media = (entry: MediaEntry): NativeCanvasMedia => {
        if (!/^sha256:[a-f0-9]{64}$/.test(entry.id) || !(MEDIA_MIMES as readonly string[]).includes(entry.mime)) {
            throw new Error('Invalid board media descriptor');
        }
        return { hash: entry.id.slice(7), preferredName: entry.file };
    };
    return {
        async read(entry: MediaEntry, signal: AbortSignal): Promise<{ name: string; blob: Blob } | null> {
            assertCurrent(signal);
            const result = await host.readMedia(identity, media(entry), signal);
            assertCurrent(signal);
            return result;
        },
        async restore(entry: MediaEntry, blob: Blob, signal: AbortSignal): Promise<string | null> {
            assertCurrent(signal);
            const result = await host.putMedia(identity, { ...media(entry), extension: mediaExtension(entry.mime as MediaMime) }, blob, signal);
            assertCurrent(signal);
            return result;
        },
    };
}
