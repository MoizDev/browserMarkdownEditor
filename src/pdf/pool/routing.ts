export interface RouteWorker { id: number; inFlight: number; heapBytes: number; retiring: boolean; pages: Set<string> }

/** Rendezvous hashing moves only pages whose winning worker changed. */
export function homeWorker<T extends RouteWorker>(workers: readonly T[], docKey: string, page: number): T | undefined {
    let best: T | undefined, score = -1;
    for (const worker of workers) {
        if (worker.retiring) continue;
        let h = 2166136261;
        const key = `${docKey}\0${page}\0${worker.id}`;
        for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
        const value = h >>> 0;
        if (!best || value > score) { best = worker; score = value; }
    }
    return best;
}
export function poolBudget(deviceMemory: number | undefined): number {
    if (!deviceMemory || !Number.isFinite(deviceMemory)) return 512 * 1024 * 1024;
    if (deviceMemory <= 2) return 256 * 1024 * 1024;
    if (deviceMemory <= 4) return 512 * 1024 * 1024;
    return 1024 * 1024 * 1024;
}
export function maximumWorkers(hardwareConcurrency: number | undefined): number {
    if (!hardwareConcurrency || !Number.isFinite(hardwareConcurrency)) return 1;
    return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)));
}
export function recycleCeiling(budget: number, live: number): number {
    return Math.min(512 * 1024 * 1024, Math.max(256 * 1024 * 1024, budget / Math.max(1, live)));
}
export function canSteal(pageKey: string, footprint: number | undefined, sourceBytes: number,
    workers: readonly RouteWorker[], budget: number): boolean {
    const copies = workers.filter(worker => worker.pages.has(pageKey)).length;
    if (footprint === undefined) return sourceBytes < 32 * 1024 * 1024;
    return footprint * (copies + 1) <= budget / 2;
}
