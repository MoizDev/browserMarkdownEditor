import type { NodeId } from '../model/ids';
import type { MediaId } from '../model/media';
import { initialPicturePlaying } from './animation';

// Provenance: media §5/MD-4 transient picture playback and reduced-motion defaults;
// independent per-session state, no upstream engine source.
interface PictureState { readonly media: MediaId; readonly playing: boolean }
/** No document operations: play, pause and initial preference never dirty or serialize the board. */
export class PicturePlayback {
    private readonly values = new Map<NodeId, PictureState>();
    private readonly listeners = new Set<() => void>();
    private closed = false;
    constructor(private readonly reducedMotion: boolean) {}
    playing(node: NodeId, media: MediaId): boolean {
        if (this.closed) return false;
        const value = this.values.get(node);
        return value?.media === media ? value.playing : initialPicturePlaying(this.reducedMotion);
    }
    setPlaying(node: NodeId, media: MediaId, playing: boolean): void {
        if (this.closed) throw new Error('Picture playback session is closed');
        if (typeof playing !== 'boolean') throw new TypeError('Invalid picture playback state');
        const current = this.values.get(node);
        if (current?.media === media && current.playing === playing) return;
        this.values.set(node, Object.freeze({ media, playing }));
        for (const listener of this.listeners) listener();
    }
    /** A deleted node or replaced media must not inherit a stale playback choice. */
    remove(node: NodeId): void {
        if (!this.values.delete(node)) return;
        for (const listener of this.listeners) listener();
    }
    subscribe(listener: () => void): () => void {
        if (this.closed) return () => {};
        this.listeners.add(listener); return () => { this.listeners.delete(listener); };
    }
    dispose(): void {
        if (this.closed) return;
        this.closed = true; this.values.clear();
        for (const listener of this.listeners) listener();
        this.listeners.clear();
    }
}
