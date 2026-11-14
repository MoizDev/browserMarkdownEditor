import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';

export type PenContactMode = 'ink' | 'eraser';
export interface PenTransitionHost {
    current(): boolean;
    owner(): GestureOwner | null;
    finish(reason: FinishReason): void;
    interrupt(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean;
    update(samples: readonly RealSample[], modifiers: Modifiers): void;
    begin(sample: RealSample, modifiers: Modifiers, event: PointerEvent): boolean;
    /** Resolves only after the previous gesture's async commits release their holds. */
    settled(signal: AbortSignal): Promise<void>;
    ended(reason: FinishReason): void;
    error(error: unknown): void;
}
type Batch = { readonly type: 'move'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers; readonly event: PointerEvent }
    | { readonly type: 'end'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers; readonly reason: FinishReason };

/** A pen eraser-end change is a real gesture boundary. Preserve every acquired
 * sample while the old eraser resolves its asynchronous exact sweep, and never
 * join the two independently committed ink segments across the eraser gap. */
export class PenContactTransitions {
    private readonly controller = new AbortController();
    private readonly queue: Batch[] = [];
    private cursor = 0;
    private running = false;
    private terminal = false;
    private closed = false;
    private mode: PenContactMode;
    constructor(readonly pointerId: number, initial: PenContactMode, private readonly host: PenTransitionHost) { this.mode = initial; }
    move(samples: readonly RealSample[], modifiers: Modifiers, event: PointerEvent): void {
        if (this.terminal || this.closed) return;
        this.queue.push({ type: 'move', samples, modifiers, event }); this.drain();
    }
    end(samples: readonly RealSample[], modifiers: Modifiers, reason: FinishReason): void {
        if (this.terminal || this.closed) return;
        this.terminal = true; this.queue.push({ type: 'end', samples, modifiers, reason }); this.drain();
    }
    private drain(): void {
        if (this.running || this.closed) return;
        this.running = true;
        void this.run().catch(error => {
            if (!this.controller.signal.aborted) {
                try { this.host.error(error); } finally { this.stop('os-cancel'); }
            }
        }).finally(() => { this.running = false; if (!this.closed && this.cursor < this.queue.length) this.drain(); });
    }
    private async run(): Promise<void> {
        while (!this.closed && this.cursor < this.queue.length) {
            if (!this.host.current()) { this.stop('os-cancel'); return; }
            const batch = this.queue[this.cursor++];
            if (batch.type === 'end') {
                if (batch.samples.length) this.host.update(batch.samples, batch.modifiers);
                this.closed = true;
                try {
                    if (batch.reason === 'up') this.host.finish('up');
                    else if (batch.reason === 'escape' || batch.reason === 'undo' || batch.reason === 'flush') this.host.interrupt(batch.reason);
                    else this.host.interrupt('os-cancel');
                } finally { this.host.ended(batch.reason); }
                return;
            }
            if (!batch.samples.length) { this.host.update([], batch.modifiers); continue; }
            let start = 0;
            while (start < batch.samples.length) {
                const desired: PenContactMode = (batch.samples[start].buttons & 32) !== 0 ? 'eraser' : 'ink';
                let end = start + 1;
                while (end < batch.samples.length && (((batch.samples[end].buttons & 32) !== 0) === (desired === 'eraser'))) end++;
                if (desired !== this.mode) {
                    // Resolve and commit the previous mode before starting the next;
                    // queued raw samples remain owned here while the sweep completes.
                    this.host.finish('tool-change');
                    await this.host.settled(this.controller.signal);
                    if (this.closed || this.controller.signal.aborted || !this.host.current()) { this.stop('os-cancel'); return; }
                    if (!this.host.begin(batch.samples[start], batch.modifiers, batch.event)) throw new Error('Pen contact transition could not start');
                    this.mode = desired; start++;
                }
                if (start < end) this.host.update(batch.samples.slice(start, end), batch.modifiers);
                start = end;
            }
            // Compact only processed batches; queued samples are never thinned.
            if (this.cursor >= 128) { this.queue.splice(0, this.cursor); this.cursor = 0; }
        }
    }
    /** Escape and Undo must reach the last acquired prefix even while an eraser
     * sweep is finishing. The ordinary gesture owner still implements policy. */
    interrupt(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean {
        if (this.closed) return false;
        if (reason === 'os-cancel' || !this.running || (this.host.owner() && this.cursor >= this.queue.length)) return this.stop(reason);
        let samples: readonly RealSample[] = [], modifiers: Modifiers = { shift: false, alt: false, accel: false, control: false };
        for (let index = this.queue.length - 1; index >= this.cursor; index--) {
            const batch = this.queue[index];
            if (batch.type === 'end') { samples = batch.samples; modifiers = batch.modifiers; this.queue.splice(index, 1); }
        }
        this.terminal = true; this.queue.push({ type: 'end', samples, modifiers, reason }); this.drain();
        return true;
    }
    /** Invalidations terminate immediately; no pending continuation may resurrect a closed view. */
    stop(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean {
        if (this.closed) return false;
        this.closed = true; this.terminal = true; this.controller.abort(); this.queue.length = 0; this.cursor = 0;
        const owner = this.host.owner();
        try {
            if (owner) return this.host.interrupt(reason);
            return false;
        } finally { this.host.ended(reason); }
    }
    cancel(_reason: CancelReason): void { this.stop('os-cancel'); }
}
