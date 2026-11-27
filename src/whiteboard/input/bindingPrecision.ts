import type { NodeId } from '../model/ids';

export const PRECISE_HOLD_MS = 320;
export const PRECISE_HOVER_MS = 600;
export const PRECISE_SPEED = 0.5;

export class BindingPrecision {
    private target: NodeId | null = null;
    private enteredAt: number;
    private precise = false;
    constructor(private readonly holdMs: number, now: number) { this.enteredAt = now; }
    decide(target: NodeId, now: number, speed: number, forced = false): boolean {
        if (target !== this.target) { this.target = target; this.enteredAt = now; this.precise = speed < PRECISE_SPEED; }
        else if (!this.precise && now - this.enteredAt >= this.holdMs) this.precise = true;
        return forced || this.precise;
    }
    leave(now: number): void { this.target = null; this.enteredAt = now; this.precise = false; }
    wakeIn(now: number): number | null {
        return this.target !== null && !this.precise ? Math.max(0, this.enteredAt + this.holdMs - now) : null;
    }
}
