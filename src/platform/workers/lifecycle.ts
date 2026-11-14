// The render platform can attach accounting to an endpoint without making the worker host
// depend on rendering. Keys are incarnations, never the stable client.
const releases = new WeakMap<object, () => void>();
const stopped = new WeakSet<object>();

export function onWorkerStop(worker: object, release: () => void): boolean {
    if (stopped.has(worker)) return false;
    releases.set(worker, release);
    return true;
}

export function workerStopped(worker: object): void {
    stopped.add(worker);
    const release = releases.get(worker);
    releases.delete(worker);
    release?.();
}
