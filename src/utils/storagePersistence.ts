// Asking the browser not to throw the vault list away.
//
// EVERYTHING THIS APP REMEMBERS LIVES IN BROWSER STORAGE, and it has no server
// to rebuild any of it from: the folder handles behind the vault list are in
// IndexedDB (they are the only way back into a folder — the File System Access
// API hands out no paths, so a forgotten handle means finding the folder in the
// picker again), and the open tabs, reading positions, canvas cameras and
// settings are in localStorage. Under storage pressure a browser may evict all
// of it from a "best effort" origin without asking.
//
// `navigator.storage.persist()` is the one lever against that. Chrome does not
// prompt: it decides from engagement — a site that is installed, bookmarked, or
// visited often enough is granted silently, and anything else is refused just
// as silently. So this asks on the one gesture that proves the app is being
// used for real (opening a vault), and asks again later rather than treating a
// refusal as final, because the heuristics it is judged by keep moving.
//
// A grant is not a guarantee against the USER clearing site data — nothing is.
// It is the difference between "the browser may bin this when a video site
// wants the room" and "the browser will keep it until you say otherwise", and
// Settings → Vault reports which of the two the app is living under.

export type StorageDurability = 'persisted' | 'best-effort' | 'unknown';

let durability: StorageDurability = 'unknown';
const listeners = new Set<() => void>();

function publish(next: StorageDurability): void {
    if (next === durability) return;
    durability = next;
    for (const fn of listeners) fn();
}

/** What the last check said. Synchronous, for `useSyncExternalStore`. */
export function getStorageDurability(): StorageDurability {
    return durability;
}

export function subscribeStorageDurability(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Read the current state without asking for anything. */
export async function checkStorageDurability(): Promise<StorageDurability> {
    try {
        if (!navigator.storage?.persisted) return 'unknown';
        publish(await navigator.storage.persisted() ? 'persisted' : 'best-effort');
    } catch {
        // A browser that refuses to answer is one we can say nothing about;
        // 'unknown' is what the Settings row is worded for.
        publish('unknown');
    }
    return durability;
}

/**
 * Ask for persistent storage, unless it is already granted.
 *
 * Safe to call on every vault open: `persisted()` short-circuits a repeat ask,
 * and a refusal costs one promise. Never throws — this is a best-effort
 * improvement to durability, and no caller has anything to do about a failure.
 */
export async function requestPersistentStorage(): Promise<StorageDurability> {
    try {
        if (!navigator.storage?.persist) return 'unknown';
        if (await checkStorageDurability() === 'persisted') return 'persisted';
        publish(await navigator.storage.persist() ? 'persisted' : 'best-effort');
    } catch {
        publish('unknown');
    }
    return durability;
}
