import type { NodeId } from '../model/ids';

// Provenance: media §5 visible animation and platform wake/decode ownership;
// independent frame scheduler, no upstream engine source.
export interface AnimatedFrameLease {
    readonly index: number;
    readonly count: number;
    readonly durationMs: number;
    release(): void;
}
export interface AnimationHost {
    /** Decodes one admitted frame through the shared media residency/governor. */
    request(id: NodeId, frame: number, signal: AbortSignal): Promise<AnimatedFrameLease>;
    current(): boolean;
    invalidate(id: NodeId): void;
    wakeAt(time: number | null): void;
    error(id: NodeId, message: string): void;
}
interface State {
    readonly id: NodeId;
    area: number;
    visible: boolean;
    playing: boolean;
    frame: number;
    deadline: number | null;
    lease?: AnimatedFrameLease;
    request?: AbortController;
    generation: number;
}
export class BoardAnimationPlayback {
    private readonly states = new Map<NodeId, State>();
    private visible = true;
    private disposed = false;
    constructor(private readonly host: AnimationHost, private readonly reducedMotion: boolean) {}
    show(id: NodeId, visible: boolean, screenArea: number): void {
        if (!Number.isFinite(screenArea) || screenArea < 0) throw new RangeError('Invalid animation screen area');
        if (this.disposed) return;
        let state = this.states.get(id);
        if (!state) { state = { id, area: 0, visible: false, playing: !this.reducedMotion, frame: 0, deadline: null, generation: 0 }; this.states.set(id, state); }
        state.visible = visible; state.area = screenArea;
        this.reconcile();
    }
    play(id: NodeId): void { const state = this.states.get(id); if (state) { state.playing = true; this.reconcile(); } }
    pause(id: NodeId): void { const state = this.states.get(id); if (state) { state.playing = false; state.deadline = null; this.reconcile(); } }
    frame(id: NodeId): number { return this.states.get(id)?.frame ?? 0; }
    setVisible(visible: boolean): void {
        if (this.disposed || this.visible === visible) return;
        this.visible = visible; this.reconcile();
    }
    /** Called by the shared compositor scheduler at the requested deadline. */
    tick(now: number): void {
        if (!Number.isFinite(now)) throw new RangeError('Invalid animation clock');
        if (this.disposed || !this.visible || !this.host.current()) { this.reconcile(); return; }
        const active = this.active();
        for (const state of active) {
            if (!state.playing || !state.lease || state.request || state.deadline === null || state.deadline > now) continue;
            this.request(state, (state.frame + 1) % state.lease.count);
        }
        this.schedule();
    }
    remove(id: NodeId): void { const state = this.states.get(id); if (state) { this.drop(state); this.states.delete(id); this.reconcile(); } }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const state of this.states.values()) this.drop(state);
        this.states.clear(); this.host.wakeAt(null);
    }
    private active(): Set<State> {
        if (!this.visible || this.disposed || !this.host.current()) return new Set();
        return new Set([...this.states.values()].filter(state => state.visible && state.playing).sort((a, b) => b.area - a.area).slice(0, 8));
    }
    private reconcile(): void {
        const active = this.active();
        for (const state of this.states.values()) {
            if (!this.visible || !state.visible || this.disposed || !this.host.current()) { this.drop(state); continue; }
            if (!active.has(state)) {
                state.request?.abort(); state.request = undefined; state.generation++; state.deadline = null;
                continue;
            }
            if (!state.lease && !state.request) this.request(state, state.frame);
            else if (state.lease && state.deadline === null) state.deadline = performance.now() + Math.max(10, state.lease.durationMs);
        }
        this.schedule();
    }
    private request(state: State, index: number): void {
        const controller = new AbortController(), generation = ++state.generation;
        state.request = controller; state.deadline = null;
        void this.host.request(state.id, index, controller.signal).then(lease => {
            if (controller.signal.aborted || this.disposed || !this.visible || !state.visible || !state.playing
                || !this.host.current() || state.generation !== generation) { lease.release(); return; }
            if (!Number.isSafeInteger(lease.index) || lease.index !== index || !Number.isSafeInteger(lease.count) || lease.count < 1
                || lease.index >= lease.count || !Number.isFinite(lease.durationMs) || lease.durationMs < 0) {
                lease.release(); throw new TypeError('Invalid animation frame');
            }
            state.request = undefined; state.lease?.release(); state.lease = lease; state.frame = index;
            state.deadline = performance.now() + Math.max(10, lease.durationMs);
            this.host.invalidate(state.id); this.schedule();
        }).catch(error => {
            if (state.generation !== generation || controller.signal.aborted || this.disposed) return;
            state.request = undefined; state.playing = false; state.deadline = null;
            this.host.error(state.id, error instanceof Error ? error.message : 'Animation could not be decoded'); this.schedule();
        });
    }
    private drop(state: State): void {
        state.generation++; state.request?.abort(); state.request = undefined;
        state.lease?.release(); state.lease = undefined; state.deadline = null;
    }
    private schedule(): void {
        let deadline = Infinity;
        for (const state of this.active()) if (state.deadline !== null) deadline = Math.min(deadline, state.deadline);
        this.host.wakeAt(Number.isFinite(deadline) ? deadline : null);
    }
}
