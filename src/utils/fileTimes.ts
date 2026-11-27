import type { FileTreeFileNode } from '../types';

let times = new Map<string, number>();
const lastWrites = new Map<string, number>();
let version = 0;
let indexTimesReady = false;
let indexNotifyFrame: number | undefined;
const listeners = new Set<() => void>();

let generation = 0;

const walksInFlight = new Set<Map<string, number>>();

const STAT_CONCURRENCY = 32;

function notify(): void {
    version++;
    for (const listener of listeners) listener();
}

export function subscribeFileTimes(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getFileTimesVersion(): number {
    return version;
}

export function getFileTimes(): ReadonlyMap<string, number> {
    return times;
}

export function areIndexTimesReady(): boolean { return indexTimesReady; }
export function markIndexTimesReady(): void {
    if (!indexTimesReady) {
        indexTimesReady = true;
        if (indexNotifyFrame !== undefined) cancelAnimationFrame(indexNotifyFrame);
        indexNotifyFrame = undefined;
        notify();
    }
}

export function recordFileWritten(path: string, time: number = Date.now()): void {
    times.set(path, time);
    lastWrites.set(path, performance.timeOrigin + performance.now());
    for (const walk of walksInFlight) walk.set(path, time);
    notify();
}

export function stampFileTimes(entries: Iterable<readonly [path: string, time: number]>): void {
    let any = false;
    for (const [path, time] of entries) {
        times.set(path, time);
        for (const walk of walksInFlight) walk.set(path, time);
        any = true;
    }
    if (any) notify();
}

/** A worker stat begun before an own save must not overwrite its newer stamp. */
export function stampIndexedFileTimes(entries: Iterable<readonly [path: string, time: number, startedAt: number]>): void {
    let changed = false;
    for (const [path, time, startedAt] of entries) {
        if ((lastWrites.get(path) ?? -Infinity) >= startedAt) continue;
        times.set(path, time);
        for (const walk of walksInFlight) walk.set(path, time);
        changed = true;
    }
    if (changed && indexNotifyFrame === undefined) {
        indexNotifyFrame = requestAnimationFrame(() => { indexNotifyFrame = undefined; notify(); });
    }
}

export function resetFileTimes(): void {
    generation++;
    walksInFlight.clear();
    lastWrites.clear();
    if (indexNotifyFrame !== undefined) cancelAnimationFrame(indexNotifyFrame);
    indexNotifyFrame = undefined;
    indexTimesReady = false;
    times = new Map();
    notify();
}

export async function statFileTimes(files: FileTreeFileNode[], isCurrent: () => boolean, readSnapshot: (handle: FileSystemFileHandle) => Promise<File>): Promise<void> {
    const startGeneration = generation;
    const stillWanted = () => generation === startGeneration && isCurrent();
    const read = new Map<string, number>();
    const writtenDuring = new Map<string, number>();
    walksInFlight.add(writtenDuring);

    try {
        let next = 0;
        const worker = async () => {
            while (next < files.length && stillWanted()) {
                const file = files[next++];
                try {
                    read.set(file.path, (await readSnapshot(file.handle)).lastModified);
                } catch {
                    read.set(file.path, 0);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, files.length) }, worker));
    } finally {
        walksInFlight.delete(writtenDuring);
    }

    if (!stillWanted()) return;
    for (const [path, time] of writtenDuring) {
        if (time > (read.get(path) ?? -Infinity)) read.set(path, time);
    }
    times = read;
    notify();
}
