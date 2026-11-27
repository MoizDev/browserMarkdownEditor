import type { CancelReason, FinishReason, GestureOwner, Modifiers, RealSample } from './tool';
import { LiveInk } from './liveInk';

export type PenContactMode = 'ink' | 'eraser';
export interface PenTransitionHost {
    current(): boolean;
    owner(): GestureOwner | null;
    finish(reason: FinishReason): void;
    interrupt(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean;
    update(samples: readonly RealSample[], modifiers: Modifiers): void;
    begin(sample: RealSample, modifiers: Modifiers, event: PointerEvent): boolean;
    prepareInk(sample: RealSample, modifiers: Modifiers, event: PointerEvent): GestureOwner | null;
    cancelPending(): void;
    settled(signal: AbortSignal): Promise<void>;
    ended(reason: FinishReason): void;
    error(error: unknown): void;
}
type Batch = { readonly type: 'move'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers; readonly event: PointerEvent }
    | { readonly type: 'modifiers'; readonly modifiers: Modifiers }
    | { readonly type: 'end'; readonly samples: readonly RealSample[]; readonly modifiers: Modifiers; readonly reason: FinishReason };

export class PenContactTransitions {
    private readonly controller = new AbortController();
    private readonly queue: Batch[] = [];
    private cursor = 0;
    private running = false;
    private terminal = false;
    private closed = false;
    private mode: PenContactMode;
    private waiting = false;
    private shadowMode: PenContactMode;
    private shadows: { readonly sequence: number; readonly owner: GestureOwner }[] = [];
    private shadow: { readonly sequence: number; readonly owner: GestureOwner } | null = null;
    private unshadowed = false;
    private readonly dirtyShadows = new Set<{ readonly sequence: number; readonly owner: GestureOwner }>();
    private readonly shadowed = new WeakSet<Batch>();
    constructor(readonly pointerId: number, initial: PenContactMode, private readonly host: PenTransitionHost) {
        this.mode = initial; this.shadowMode = initial;
    }
    get lifted(): boolean { return this.terminal && !this.closed; }
    move(samples: readonly RealSample[], modifiers: Modifiers, event: PointerEvent): void {
        if (this.terminal || this.closed) return;
        const batch: Batch = { type: 'move', samples, modifiers, event };
        if (this.waiting) this.stage(batch, 0);
        this.queue.push(batch); this.drain();
    }
    modifiersChanged(modifiers: Modifiers): void {
        if (this.terminal || this.closed) return;
        if (this.waiting && this.shadow) { this.shadow.owner.update([], modifiers); this.dirtyShadows.add(this.shadow); }
        this.queue.push({ type: 'modifiers', modifiers }); this.drain();
    }
    end(samples: readonly RealSample[], modifiers: Modifiers, reason: FinishReason): void {
        if (this.terminal || this.closed) return;
        if (this.waiting && samples.length && this.shadow) { this.shadow.owner.update(samples, modifiers); this.dirtyShadows.add(this.shadow); }
        this.terminal = true; this.queue.push({ type: 'end', samples, modifiers, reason }); this.drain();
    }
    private stage(batch: Extract<Batch, { type: 'move' }>, start: number): void {
        if (this.shadowed.has(batch)) return;
        this.shadowed.add(batch);
        for (let i = start; i < batch.samples.length; i++) {
            const sample = batch.samples[i], mode: PenContactMode = (sample.buttons & 32) !== 0 ? 'eraser' : 'ink';
            if (mode !== this.shadowMode) { this.shadowMode = mode; this.shadow = null; this.unshadowed = false; }
            if (mode !== 'ink' || this.unshadowed) continue;
            if (!this.shadow) {
                const owner = this.host.prepareInk(sample, batch.modifiers, batch.event);
                if (!owner || owner.kind !== 'ink' || !owner.discard) {
                    owner?.cancel('invalidated'); this.unshadowed = true; continue;
                }
                this.shadow = { sequence: sample.sequence, owner }; this.shadows.push(this.shadow);
            } else this.shadow.owner.update([sample], batch.modifiers);
            this.dirtyShadows.add(this.shadow);
        }
    }
    publishPending(): boolean {
        if (this.closed) return false;
        let count = 0;
        for (const shadow of this.dirtyShadows) {
            this.dirtyShadows.delete(shadow);
            if (shadow.owner instanceof LiveInk) shadow.owner.publish();
            if (++count >= 64) break;
        }
        return this.dirtyShadows.size > 0;
    }
    private discardShadow(sequence: number): void {
        const index = this.shadows.findIndex(value => value.sequence === sequence);
        if (index < 0) return;
        const [shadow] = this.shadows.splice(index, 1);
        this.dirtyShadows.delete(shadow);
        if (this.shadow === shadow) this.shadow = null;
        shadow.owner.discard?.();
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
            if (batch.type === 'modifiers') { this.host.update([], batch.modifiers); continue; }
            if (batch.type === 'end') {
                if (batch.samples.length) this.host.update(batch.samples, batch.modifiers);
                this.closed = true;
                for (const shadow of this.shadows) shadow.owner.discard?.();
                this.shadows = []; this.shadow = null; this.dirtyShadows.clear();
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
                    this.host.finish('tool-change');
                    this.waiting = true;
                    if (!this.shadowed.has(batch) && !this.shadows.length) { this.shadowMode = this.mode; this.shadow = null; this.unshadowed = false; }
                    this.stage(batch, start);
                    await this.host.settled(this.controller.signal);
                    this.waiting = false;
                    if (this.closed || this.controller.signal.aborted || !this.host.current()) { this.stop('os-cancel'); return; }
                    if (desired === 'ink') this.discardShadow(batch.samples[start].sequence);
                    if (!this.host.begin(batch.samples[start], batch.modifiers, batch.event)) { this.stop('os-cancel'); return; }
                    this.mode = desired; start++;
                }
                if (start < end) this.host.update(batch.samples.slice(start, end), batch.modifiers);
                start = end;
            }
            if (this.cursor >= 128) { this.queue.splice(0, this.cursor); this.cursor = 0; }
        }
    }
    interrupt(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean {
        if (this.closed) return false;
        if (reason === 'os-cancel' || reason === 'flush' || !this.running || (this.host.owner() && this.cursor >= this.queue.length)) return this.stop(reason);
        let samples: readonly RealSample[] = [], modifiers: Modifiers = { shift: false, alt: false, accel: false, control: false };
        for (let index = this.queue.length - 1; index >= this.cursor; index--) {
            const batch = this.queue[index];
            if (batch.type === 'end') { samples = batch.samples; modifiers = batch.modifiers; this.queue.splice(index, 1); }
        }
        this.terminal = true; this.queue.push({ type: 'end', samples, modifiers, reason }); this.drain();
        return true;
    }
    stop(reason: 'escape' | 'undo' | 'flush' | 'os-cancel'): boolean {
        if (this.closed) return false;
        this.closed = true; this.terminal = true; this.controller.abort(); this.queue.length = 0; this.cursor = 0;
        const owner = this.host.owner(), shadows = this.shadows; this.shadows = []; this.shadow = null; this.dirtyShadows.clear();
        let interrupted = false;
        try {
            if (shadows.length) { try { this.host.cancelPending(); } catch (error) { this.host.error(error); } }
            if (owner) interrupted = this.host.interrupt(shadows.length ? 'flush' : reason);
            for (let i = 0; i < shadows.length; i++) {
                const final = i === shadows.length - 1;
                shadows[i].owner.finish(final && reason === 'undo' ? 'undo' : final && reason === 'escape' ? 'escape' : 'flush');
                interrupted = true;
            }
            return interrupted;
        } finally { this.host.ended(reason); }
    }
    cancel(_reason: CancelReason): void { this.stop('os-cancel'); }
}
