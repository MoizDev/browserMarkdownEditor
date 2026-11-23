import type { NodeId } from '../model/ids';

/** A binding is precise after the pointer has rested on its target this long (catalogue §7, pressing: 320 ms). */
export const PRECISE_HOLD_MS = 320;
/** The arrow tool's hover hold before the hovered target is precise (catalogue §7, hovering: 600 ms). */
export const PRECISE_HOVER_MS = 600;
/** A target entered faster than this (CSS px per ms) is imprecise; a slow entry is precise at once (catalogue §7). */
export const PRECISE_SPEED = 0.5;

/** Precision of one arrow end as the pointer moves over targets. A new target entered slowly is precise at once; a faster
 * entry becomes precise only after its hold. Leaving every target starts the next one from scratch. */
export class BindingPrecision {
    private target: NodeId | null = null;
    private enteredAt: number;
    private precise = false;
    constructor(private readonly holdMs: number, now: number) { this.enteredAt = now; }
    /** `forced` is the same-target rule: the opposite end is already precise on this target. */
    decide(target: NodeId, now: number, speed: number, forced = false): boolean {
        if (target !== this.target) { this.target = target; this.enteredAt = now; this.precise = speed < PRECISE_SPEED; }
        else if (!this.precise && now - this.enteredAt >= this.holdMs) this.precise = true;
        return forced || this.precise;
    }
    leave(now: number): void { this.target = null; this.enteredAt = now; this.precise = false; }
    /** Milliseconds until the current target's hold makes it precise, or null when nothing is waiting on a hold. */
    wakeIn(now: number): number | null {
        return this.target !== null && !this.precise ? Math.max(0, this.enteredAt + this.holdMs - now) : null;
    }
}
