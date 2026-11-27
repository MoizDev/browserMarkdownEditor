import type { NodeId } from '../model/ids';
import type { MediaId } from '../model/media';
import { initialPicturePlaying } from './animation';

interface PictureState { readonly media: MediaId; readonly playing: boolean }
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
        const listeners = [...this.listeners]; this.listeners.clear();
        for (const listener of listeners) listener();
    }
}
