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
const notify = () => {
    for (const listener of [...listeners]) {
        try { listener(); } catch (error) { console.error('Session identity subscriber failed:', error); }
    }
};

/** App installs its lifetime store; cleanup cannot detach a newer installation. */
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

/** Stable snapshot identity until this document's session or bytes change. */
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

export function subscribeSessionIdentity(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
