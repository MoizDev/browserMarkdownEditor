// The render platform can attach accounting to an endpoint without making the worker host
// depend on rendering. Keys are incarnations, never the stable client.
const releases = new WeakMap<object, () => void>();
const stopped = new WeakSet<object>();
const memory = new Map<object, number>();
const listeners = new Set<(worker: object, bytes: number | null) => void>();

/** Current reports belong to endpoints, and disappear when that incarnation stops. */
export function workerMemoryReports(): ReadonlyMap<object, number> {
    return new Map(memory);
}

export function workerOwnedBytes(worker: object): number | undefined { return memory.get(worker); }

export function subscribeWorkerMemory(listener: (worker: object, bytes: number | null) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function reportWorkerOwnedBytes(worker: object, bytes: number): void {
    if (stopped.has(worker)) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid worker memory report');
    if (bytes) memory.set(worker, bytes);
    else memory.delete(worker);
    notify(worker, bytes);
}

function notify(worker: object, bytes: number | null): void {
    for (const listener of [...listeners]) {
        try { listener(worker, bytes); }
        catch (error) { console.warn('Worker memory listener failed', error); }
    }
}

export function onWorkerStop(worker: object, release: () => void): boolean {
    if (stopped.has(worker)) return false;
    releases.set(worker, release);
    return true;
}

export function workerStopped(worker: object): void {
    stopped.add(worker);
    const release = releases.get(worker);
    releases.delete(worker);
    memory.delete(worker);
    try { release?.(); }
    finally { notify(worker, null); }
}
