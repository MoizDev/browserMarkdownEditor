// Run an async job over many items, a bounded number at a time.
//
// `Promise.all(items.map(fn))` starts everything at once. For a whole-vault
// walk that is thousands of `getFile()` calls handed to the browser's file
// thread in one breath: they queue there anyway, nothing can be cancelled
// between them, and every result is held alive until the slowest lands.
// A pool costs the same total work and keeps the tab answering.
//
// 32 is what `utils/fileTimes.ts` settled on for the same stat walk, and the
// number is a queue depth rather than a parallelism: the work is IO.
export const VAULT_CONCURRENCY = 32;

/** `items.map(fn)`, in order, with at most `limit` in flight. */
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
 * A budget of concurrent slots, shared by everyone who holds the object.
 *
 * `mapPool` bounds ONE list. A recursive walk is many lists inside one
 * another, and a pool per level multiplies: twelve at the root, twelve inside
 * each of those, and a deep vault is back to firing everything at once. A
 * semaphore is counted once for the whole walk however deep it goes.
 */
export class Limiter {
    private free: number;
    private waiting: (() => void)[] = [];

    constructor(slots = VAULT_CONCURRENCY) { this.free = slots; }

    /** Run `job` once a slot is free, and give the slot back after it — even if
     *  it throws, or the walk would narrow itself to nothing on one failure. */
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

/** Run `job` when the browser is next idle, or after `timeout` ms whichever
 *  comes first; returns a canceller. Safari has no `requestIdleCallback`, and a
 *  plain timeout is a fine stand-in for something whose only requirement is
 *  "not while the reader is waiting for something else". */
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
