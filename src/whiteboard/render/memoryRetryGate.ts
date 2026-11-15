// Back-off for one run of refused memory reservations. The layer's retry timer waits for the same window, so a refused
// owner is retried on this schedule whatever else re-runs its frame.
export const MEMORY_RETRY_MIN_MS = 250, MEMORY_RETRY_MAX_MS = 2000;

/** The first refusal of a run holds its owner back for 250 ms; each further refusal of the same run holds it back twice
 * as long, up to 2 s. Inside an open window a refusal changes nothing, so a frame that re-runs the owner cannot shorten the
 * wait. An admitted reservation ends the run. */
export class MemoryRetryGate {
    private next = MEMORY_RETRY_MIN_MS;
    private until = -Infinity;

    constructor(private readonly clock: () => number = () => performance.now()) {}

    /** True while the last refusal's window has not ended: the owner must not reserve yet. */
    closed(): boolean { return this.clock() < this.until; }

    /** Milliseconds until the window ends; 0 when it is open. */
    remaining(): number { return Math.max(0, this.until - this.clock()); }

    refused(): void {
        const now = this.clock();
        if (now < this.until) return;
        this.until = now + this.next;
        this.next = Math.min(MEMORY_RETRY_MAX_MS, this.next * 2);
    }

    admitted(): void {
        this.next = MEMORY_RETRY_MIN_MS;
        this.until = -Infinity;
    }
}
