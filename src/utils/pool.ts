export const VAULT_CONCURRENCY = 32;

export async function mapPool<T, R>(
    items: readonly T[],
    fn: (item: T, index: number) => Promise<R>,
    limit = VAULT_CONCURRENCY,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/**
 * A permit covers LOCAL IO only: release it before awaiting descendants that
 * need the same limiter. `run` is not re-entrant; parents holding every slot
 * while their children queue deadlock even with no native IO left in flight.
 */
export class Limiter {
    private free: number;
    private waiting: (() => void)[] = [];

    constructor(slots = VAULT_CONCURRENCY) { this.free = slots; }

    async run<R>(job: () => Promise<R>): Promise<R> {
        if (this.free === 0) await new Promise<void>(resolve => this.waiting.push(resolve));
        else this.free--;
        try {
            return await job();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.free++;
        }
    }
}

export function onIdle(job: () => void, timeout = 2000): () => void {
    const w = window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
        const id = w.requestIdleCallback(job, { timeout });
        return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(job, Math.min(timeout, 1500));
    return () => clearTimeout(id);
}
