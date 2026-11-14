import type { NodeId } from '../model/ids';
import type { MediaId } from '../model/media';

export interface AnimatedPictureDemand {
    readonly node: NodeId;
    readonly media: MediaId;
    readonly visibleArea: number;
    readonly playing: boolean;
}
interface AnimationState {
    media: MediaId;
    frame: number;
    frameCount: number;
    durationMs: number;
    due: number | null;
    awaiting: boolean;
    playing: boolean;
    area: number;
}
export interface AnimationHost {
    invalidate(): void;
    wakeAt(deadline: number | null): void;
}

export function initialPicturePlaying(reducedMotion: boolean): boolean { return !reducedMotion; }

// The layer's existing scheduler supplies the clock; playback never dirties the document.
export class PictureAnimations {
    private readonly states = new Map<NodeId, AnimationState>();
    private active = new Set<NodeId>();
    private visible = true;
    constructor(private readonly host: AnimationHost) {}

    update(demands: readonly AnimatedPictureDemand[], now: number): void {
        if (!Number.isFinite(now)) throw new RangeError('Invalid animation clock');
        const present = new Set<NodeId>();
        for (const item of demands) {
            present.add(item.node);
            let state = this.states.get(item.node);
            if (!state || state.media !== item.media) {
                state = { media: item.media, frame: 0, frameCount: 1, durationMs: 0, due: null,
                    awaiting: true, playing: item.playing, area: 0 };
                this.states.set(item.node, state);
            }
            state.playing = item.playing;
            state.area = Number.isFinite(item.visibleArea) ? Math.max(0, item.visibleArea) : 0;
        }
        for (const node of this.states.keys()) if (!present.has(node)) this.states.delete(node);
        this.reselect(now);
    }

    frame(node: NodeId): number { return this.states.get(node)?.frame ?? 0; }

    decoded(media: MediaId, frame: number, durationMs: number, frameCount: number, now: number): void {
        if (!Number.isFinite(now) || !Number.isFinite(durationMs) || durationMs < 0 || !Number.isSafeInteger(frameCount) || frameCount < 1) return;
        let changed = false;
        for (const [node, state] of this.states) {
            if (state.media !== media || state.frame !== frame) continue;
            const wasAwaiting = state.awaiting;
            state.frameCount = frameCount;
            state.durationMs = Math.max(10, durationMs);
            state.awaiting = false;
            if (this.active.has(node) && frameCount > 1 && (wasAwaiting || state.due === null)) state.due = now + state.durationMs;
            if (wasAwaiting) changed = true;
        }
        if (changed) { this.host.invalidate(); this.schedule(); }
    }

    tick(now: number): void {
        if (!this.visible || !Number.isFinite(now)) return;
        let changed = false;
        for (const node of this.active) {
            const state = this.states.get(node)!;
            if (state.awaiting || state.due === null || now < state.due || state.frameCount < 2) continue;
            state.frame = (state.frame + 1) % state.frameCount;
            state.awaiting = true;
            state.due = null;
            changed = true;
        }
        if (changed) this.host.invalidate();
        this.schedule();
    }

    setVisible(visible: boolean, now: number): void {
        this.visible = visible;
        if (!visible) for (const state of this.states.values()) { state.awaiting = true; state.due = null; }
        this.reselect(now);
    }

    clear(): void { this.states.clear(); this.active.clear(); this.host.wakeAt(null); }

    private reselect(now: number): void {
        const next = new Set(this.visible ? [...this.states.entries()]
            .filter(([, state]) => state.playing && state.area > 0)
            .sort((a, b) => b[1].area - a[1].area || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .slice(0, 8).map(([node]) => node) : []);
        for (const [node, state] of this.states) {
            if (!next.has(node)) state.due = null;
            else if (!this.active.has(node) && !state.awaiting && state.frameCount > 1) state.due = now + state.durationMs;
        }
        this.active = next;
        this.schedule();
    }

    private schedule(): void {
        let earliest = Infinity;
        for (const node of this.active) {
            const due = this.states.get(node)?.due;
            if (due !== null && due !== undefined) earliest = Math.min(earliest, due);
        }
        this.host.wakeAt(Number.isFinite(earliest) ? earliest : null);
    }
}
