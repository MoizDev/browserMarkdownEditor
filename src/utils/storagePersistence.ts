export type StorageDurability = 'persisted' | 'best-effort' | 'unknown';

let durability: StorageDurability = 'unknown';
const listeners = new Set<() => void>();

function publish(next: StorageDurability): void {
    if (next === durability) return;
    durability = next;
    for (const fn of listeners) fn();
}

export function getStorageDurability(): StorageDurability {
    return durability;
}

export function subscribeStorageDurability(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export async function checkStorageDurability(): Promise<StorageDurability> {
    try {
        if (!navigator.storage?.persisted) return 'unknown';
        publish(await navigator.storage.persisted() ? 'persisted' : 'best-effort');
    } catch {
        publish('unknown');
    }
    return durability;
}

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
