import type { ByteLease } from '../../platform/render/gfx/api';
import type { MemoryAllocator } from '../../platform/render/memoryGovernor';
import type { NodeId } from '../model/ids';
import type { MediaEntry, MediaId } from '../model/media';
import type { VideoFrameRegistry } from './videoFrames';

// Provenance: media §6 session playback, C4 visibility and verified-blob
// authority; independent detached video lifecycle, no upstream engine source.
export interface VideoPlaybackSource { readonly entry: MediaEntry; readonly blob: Blob }
export interface VideoPlaybackState { readonly playing: boolean; readonly muted: boolean; readonly time: number; readonly visible: boolean }
export interface VideoPlaybackHost {
    readonly memory: MemoryAllocator;
    readonly mode?: 'detached' | 'hidden-dom';
    readonly overlay?: HTMLElement;
    /** Real pane-relative on-screen box; required by the hidden-DOM decoder fallback. */
    videoRect?(id: NodeId): Readonly<{ x: number; y: number; width: number; height: number }> | null;
    /** Only session-owned bytes already verified against this entry may be returned. */
    source(id: NodeId): VideoPlaybackSource | null;
    current(): boolean;
    invalidate(id: NodeId): void;
    error(id: NodeId, message: string): void;
    /** Where each presented frame goes as an immutable bitmap. Without it the view repaints the live element instead. */
    readonly frames?: VideoFrameRegistry;
}
interface Player {
    readonly id: NodeId;
    readonly mediaId: MediaId;
    readonly video: HTMLVideoElement;
    readonly url: string;
    readonly memory: ByteLease;
    callback: number | null;
    closed: boolean;
    /** One snapshot at a time: a frame that arrives while the last is copying is the next one to be shown. */
    snapshotting: boolean;
    /** The copy in flight. The source it reads (object URL and charge) is dropped only after this settles. */
    copying: Promise<void> | null;
}
interface State { playing: boolean; muted: boolean; time: number; visible: boolean; initialized: boolean; mediaId?: MediaId; player?: Player }
let soundOwner: Player | null = null;

/** Playback state is transient. A hidden pane owns no video element or frame reservation. */
export class BoardVideoPlayback {
    private readonly states = new Map<NodeId, State>();
    private visible = true;
    private disposed = false;
    constructor(private readonly host: VideoPlaybackHost) {}
    private state(id: NodeId): State {
        let state = this.states.get(id);
        if (!state) { state = { playing: false, muted: true, time: 0, visible: false, initialized: false }; this.states.set(id, state); }
        return state;
    }
    getState(id: NodeId): VideoPlaybackState {
        const state = this.state(id), time = state.player?.video.currentTime;
        return Object.freeze({ playing: state.playing, muted: state.player?.video.muted ?? state.muted, time: Number.isFinite(time) ? time! : state.time, visible: this.visible && state.visible });
    }
    /** `autoplay` is honored muted, only while the node and pane are visible. */
    show(id: NodeId, visible: boolean, autoplay = false): void {
        if (this.disposed) return;
        const state = this.state(id);
        if (!state.initialized) { state.initialized = true; state.playing = autoplay; state.muted = true; }
        state.visible = visible;
        this.reconcile(id, state);
    }
    setVisible(visible: boolean): void {
        if (this.disposed || visible === this.visible) return;
        this.visible = visible;
        for (const [id, state] of this.states) this.reconcile(id, state);
    }
    play(id: NodeId): void {
        const state = this.state(id); state.playing = true;
        this.reconcile(id, state);
    }
    pause(id: NodeId): void {
        const state = this.state(id); state.playing = false;
        state.player?.video.pause(); this.host.invalidate(id);
    }
    seek(id: NodeId, time: number): void {
        if (!Number.isFinite(time) || time < 0) throw new RangeError('Invalid video time');
        const state = this.state(id);
        if (state.player && this.host.source(id)?.entry.id !== state.player.mediaId) this.reconcile(id, state);
        state.time = time;
        if (state.player) {
            const duration = state.player.video.duration;
            state.player.video.currentTime = Number.isFinite(duration) ? Math.min(time, duration) : time;
        }
        this.host.invalidate(id);
    }
    /** Caller invokes this only from the user's explicit audio gesture. */
    enableSound(id: NodeId): void {
        if (!this.host.current() || !this.visible) throw new DOMException('Video session is unavailable', 'AbortError');
        const state = this.state(id), player = state.player;
        if (!player || player.closed || !state.visible || this.host.source(id)?.entry.id !== player.mediaId) throw new Error('Video is not visible');
        if (soundOwner && soundOwner !== player && !soundOwner.closed) soundOwner.video.muted = true;
        soundOwner = player; state.muted = false; player.video.muted = false;
    }
    mute(id: NodeId): void {
        const state = this.state(id); state.muted = true;
        if (state.player) { state.player.video.muted = true; if (soundOwner === state.player) soundOwner = null; }
    }
    /** Valid only until the next visibility/lifetime change; callers do not retain it. */
    frame(id: NodeId): HTMLVideoElement | null {
        const state = this.states.get(id), player = state?.player;
        return !this.disposed && this.visible && state?.visible && player && !player.closed && this.host.current()
            && this.host.source(id)?.entry.id === player.mediaId && player.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? player.video : null;
    }
    remove(id: NodeId): void {
        const state = this.states.get(id); if (!state) return;
        this.close(state); this.states.delete(id);
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const state of this.states.values()) this.close(state);
        this.states.clear();
    }
    private reconcile(id: NodeId, state: State): void {
        if (this.disposed || !this.visible || !state.visible || !this.host.current()) { this.close(state); return; }
        const source = this.host.source(id);
        if (source && source.entry.id !== state.mediaId) {
            this.close(state); state.mediaId = source.entry.id; state.time = 0; state.muted = true;
        } else if (state.player && !source) this.close(state);
        if (!state.player) {
            if (!source || !(source.blob instanceof Blob) || !source.entry.mime.startsWith('video/') || source.blob.size !== source.entry.bytes) return;
            const pixels = source.entry.w * source.entry.h;
            if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > 2 ** 26) throw new RangeError('Invalid video dimensions');
            const memory = this.host.memory.reserve(4 * pixels);
            if (!memory) { this.host.error(id, 'Not enough memory for video playback'); return; }
            let url: string | undefined, cleanupVideo: HTMLVideoElement | undefined;
            try {
                url = URL.createObjectURL(source.blob);
                const video = document.createElement('video'); cleanupVideo = video;
                video.preload = 'auto'; video.playsInline = true; video.loop = true; video.muted = true;
                const player: Player = { id, mediaId: source.entry.id, video, url, memory, callback: null, closed: false, snapshotting: false, copying: null };
                state.player = player; state.muted = true;
                if (this.host.mode === 'hidden-dom') {
                    if (!this.host.overlay || !this.host.videoRect) throw new Error('Video fallback overlay is unavailable');
                    video.setAttribute('aria-hidden', 'true'); video.style.position = 'absolute';
                    video.style.opacity = '0'; video.style.pointerEvents = 'none';
                    this.host.overlay.append(video);
                }
                video.addEventListener('loadedmetadata', () => {
                    if (player.closed || !this.host.current()) return;
                    if (state.time > 0) video.currentTime = Number.isFinite(video.duration) ? Math.min(state.time, video.duration) : state.time;
                    this.host.invalidate(id);
                });
                video.addEventListener('loadeddata', () => { if (!player.closed && this.host.current()) this.host.invalidate(id); });
                video.addEventListener('error', () => { if (!player.closed) this.host.error(id, 'This video could not be played'); });
                video.src = url;
                const frame = () => {
                    if (player.closed || !this.visible || !state.visible || !this.host.current()) return;
                    if (this.host.source(id)?.entry.id !== player.mediaId) { this.close(state); return; }
                    if (this.host.frames) this.presentFrame(player); else this.host.invalidate(id);
                    player.callback = video.requestVideoFrameCallback(frame);
                };
                player.callback = video.requestVideoFrameCallback(frame);
            } catch (error) {
                try { if (cleanupVideo) { cleanupVideo.pause(); cleanupVideo.removeAttribute('src'); cleanupVideo.load(); cleanupVideo.remove(); } }
                finally { if (url) URL.revokeObjectURL(url); this.host.memory.release(memory); state.player = undefined; }
                throw error;
            }
        }
        if (this.host.mode === 'hidden-dom') {
            const rect = this.host.videoRect?.(id);
            if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
                this.close(state); return;
            }
            const style = state.player.video.style;
            style.left = `${rect.x}px`; style.top = `${rect.y}px`; style.width = `${rect.width}px`; style.height = `${rect.height}px`;
        }
        if (state.playing) {
            const player = state.player;
            void player.video.play().catch(() => { if (!player.closed && this.host.current()) this.host.error(id, 'Video playback was blocked'); });
        } else state.player.video.pause();
    }
    /** Copies the element's current frame out as an immutable bitmap. Its lifetime is the registry's, not the element's. */
    private presentFrame(player: Player): void {
        const frames = this.host.frames, video = player.video;
        if (!frames || player.closed || player.snapshotting || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        // Charged before the copy allocates. A refused charge defers this frame; the next frame callback asks again.
        const lease = frames.admitFrame(video.videoWidth * video.videoHeight * 4);
        if (!lease) return;
        player.snapshotting = true;
        const copy: Promise<void> = createImageBitmap(video).then(bitmap => {
            if (player.closed || !this.host.current() || this.host.source(player.id)?.entry.id !== player.mediaId) { bitmap.close(); frames.release(lease); return; }
            frames.present(player.id, bitmap, lease);
        }, () => {
            frames.release(lease);
            if (!player.closed && this.host.current()) this.host.error(player.id, 'This video frame could not be shown');
        }).finally(() => { player.snapshotting = false; if (player.copying === copy) player.copying = null; });
        player.copying = copy;
    }
    private close(state: State): void {
        const player = state.player; if (!player || player.closed) return;
        player.closed = true; state.player = undefined;
        if (Number.isFinite(player.video.currentTime)) state.time = player.video.currentTime;
        if (soundOwner === player) soundOwner = null;
        state.muted = true;
        // Presented frames close before the element and its object URL are released, so no paint can name a source that is gone.
        this.host.frames?.retire(player.id);
        try {
            if (player.callback !== null) player.video.cancelVideoFrameCallback(player.callback);
            player.video.pause(); player.video.removeAttribute('src'); player.video.load();
        } finally {
            player.video.remove();
            // The decoder is stopped above. The source (object URL and charge) waits for a copy the browser already started.
            const dropSource = () => { URL.revokeObjectURL(player.url); this.host.memory.release(player.memory); };
            if (player.copying) void player.copying.then(dropSource, dropSource); else dropSource();
        }
    }
}
