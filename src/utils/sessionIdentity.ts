import type { DocumentSessionStore } from './documentSessions';

export interface SessionIdentity {
    readonly serial: number;
    readonly bytesGeneration: number;
    getSlot<T>(key: symbol): T | undefined;
    setSlot<T>(key: symbol, value: T, dispose?: (value: T) => void | Promise<void>): void;
}

let store: DocumentSessionStore | undefined;
let unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
const snapshots = new Map<string, SessionIdentity>();
const beforeBytesChange = new Map<string, Set<(nextGeneration: number) => void>>();
const notify = () => {
    for (const listener of [...listeners]) {
        try { listener(); } catch (error) { console.error('Session identity subscriber failed:', error); }
    }
};

export function installSessionIdentity(next: DocumentSessionStore): () => void {
    unsubscribe?.();
    store = next;
    snapshots.clear();
    unsubscribe = next.subscribe(notify);
    notify();
    return () => {
        if (store !== next) return;
        unsubscribe?.(); unsubscribe = undefined; store = undefined; snapshots.clear(); notify();
    };
}

export function awaitSessionDisposals(documentId: string): Promise<void> {
    return store?.settled(documentId) ?? Promise.resolve();
}

export function getSessionIdentity(documentId: string): SessionIdentity | undefined {
    const entry = store?.get(documentId);
    if (!entry) { snapshots.delete(documentId); return undefined; }
    const cached = snapshots.get(documentId);
    if (cached?.serial === entry.serial && cached.bytesGeneration === entry.bytesGeneration) return cached;
    const identity: SessionIdentity = Object.freeze({
        serial: entry.serial, bytesGeneration: entry.bytesGeneration,
        getSlot: entry.getSlot, setSlot: entry.setSlot,
    });
    snapshots.set(documentId, identity);
    return identity;
}

export function registerBeforeBytesChange(documentId: string, listener: (nextGeneration: number) => void): () => void {
    let set = beforeBytesChange.get(documentId);
    if (!set) beforeBytesChange.set(documentId, set = new Set());
    const registered = set;
    registered.add(listener);
    return () => {
        registered.delete(listener);
        if (!registered.size && beforeBytesChange.get(documentId) === registered) beforeBytesChange.delete(documentId);
    };
}

export function prepareBytesChange(documentId: string, generation: number): void {
    for (const listener of [...(beforeBytesChange.get(documentId) ?? [])]) {
        try { listener(generation); } catch (error) { console.error('Could not bridge document pixels:', error); }
    }
}

export function subscribeSessionIdentity(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
