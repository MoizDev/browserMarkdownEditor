import type { DocumentSessionStore, SessionAdapter } from './documentSessions';
import type { SourceOwner } from './documentBuffers';
import type { CanvasSessionBridge } from './canvasSessionBridge';

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

/** Attach an engine to the App-created bridge without changing identity or slots. */
export function attachCanvasSession<A extends SessionAdapter>(documentId: string, create: (owner: SourceOwner) => A): A | undefined {
    const adapter = store?.get(documentId)?.adapter as CanvasSessionBridge | undefined;
    return typeof adapter?.attach === 'function' ? adapter.attach(create) : undefined;
}

/** Optional presentation handoff, called while the old token is still current. */
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

/** Presentation errors never stop an authoritative byte generation advancing. */
export function prepareBytesChange(documentId: string, generation: number): void {
    for (const listener of [...(beforeBytesChange.get(documentId) ?? [])]) {
        try { listener(generation); } catch (error) { console.error('Could not bridge document pixels:', error); }
    }
}

export function subscribeSessionIdentity(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
