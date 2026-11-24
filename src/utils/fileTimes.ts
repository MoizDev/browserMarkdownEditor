// Each vault file's modification time, as an external store — what the file
// explorer's Modified-time sorts order by.
//
// A store rather than App state for the reason utils/saveEpoch.ts gives: the
// save funnel stamps a time after every write, and a per-save value threaded as
// a prop through the memo'd FileExplorer would re-render the whole tree once a
// second while the user types. As a store it reaches only a subscriber — and
// the explorer subscribes only while a time sort is actually chosen.
//
// Times come from `handle.getFile()`, which hands back the File's metadata
// (`lastModified`) without reading its bytes: read-only, like the walks in
// utils/graph.ts and utils/vaultSearch.ts. The File System Access API exposes
// no creation time at all, anywhere — which is why the sort menu has no
// Created-time rows, not an oversight.

import type { FileTreeFileNode } from '../types';

let times = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();

// Bumped by resetFileTimes: a walk that began in the previous vault must not
// paint its paths' times over the next one, whatever its caller's `isCurrent`
// says (a vault switch and the explorer's own run id need not move together).
let generation = 0;

// Stamps made while a walk is in flight, one map per walk. A walk READS the
// disk and then REPLACES the whole map, so a save landing mid-walk — after its
// file was stat'ed, or its stat raced the write — would otherwise be wiped by
// the older reading and the file would jump back down the list.
const walksInFlight = new Set<Map<string, number>>();

// getFile() is cheap per call but not free, and a vault of thousands of files
// fired at once queues them all in the browser's file thread; a bounded pool
// keeps the walk responsive and cancellable between files.
const STAT_CONCURRENCY = 32;

function notify(): void {
    version++;
    for (const listener of listeners) listener();
}

export function subscribeFileTimes(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The snapshot for `useSyncExternalStore` — the map itself is replaced or
 *  written in place, so its identity is not a reliable change signal. */
export function getFileTimesVersion(): number {
    return version;
}

/** Path → `lastModified` (ms). A path absent from it is not yet known. */
export function getFileTimes(): ReadonlyMap<string, number> {
    return times;
}

/** Called by the save funnel after a write it just made, so a sort reacts to a
 *  save without re-statting the vault. */
export function recordFileWritten(path: string, time: number = Date.now()): void {
    times.set(path, time);
    for (const walk of walksInFlight) walk.set(path, time);
    notify();
}

/** The same, for a whole batch of OUTSIDE writes (a `git pull` rewrites hundreds
 *  of files at once): one notification, so a time sort re-renders once for the
 *  batch rather than once per path. `time` should be the file's real
 *  `lastModified` where the caller has stat'ed it — the app's own clock is only
 *  a stand-in, and an outside writer's clock is not the app's. */
export function stampFileTimes(entries: Iterable<readonly [path: string, time: number]>): void {
    let any = false;
    for (const [path, time] of entries) {
        times.set(path, time);
        for (const walk of walksInFlight) walk.set(path, time);
        any = true;
    }
    if (any) notify();
}

/** For a vault switch: the old vault's paths mean nothing in the new one. */
export function resetFileTimes(): void {
    generation++;
    walksInFlight.clear();
    times = new Map();
    notify();
}

/**
 * Stat every file in `files` and REPLACE the map with the result, so a deleted
 * or renamed path drops out. A file that cannot be read sorts as time 0 (oldest)
 * rather than failing the walk. Nothing is published unless `isCurrent()` still
 * holds when the walk ends — a newer tree or a newer walk has superseded it.
 */
export async function statFileTimes(files: FileTreeFileNode[], isCurrent: () => boolean): Promise<void> {
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
                    read.set(file.path, (await file.handle.getFile()).lastModified);
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
    // A save made during the walk outranks what the walk read, unless the disk
    // reported something newer still. A path written but absent from `files`
    // (created after the tree was built) is kept too; the next walk, which a
    // tree refresh triggers, confirms or drops it.
    for (const [path, time] of writtenDuring) {
        if (time > (read.get(path) ?? -Infinity)) read.set(path, time);
    }
    times = read;
    notify();
}
