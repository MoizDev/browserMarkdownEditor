export const MEMORY_RETRY_MIN_MS = 250, MEMORY_RETRY_MAX_MS = 2000;

export class MemoryRetryGate {
    private next = MEMORY_RETRY_MIN_MS;
    private until = -Infinity;

    constructor(private readonly clock: () => number = () => performance.now()) {}

    closed(): boolean { return this.clock() < this.until; }

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
