import type { ContentSource, DocumentBuffer, SourceOwner, SourceReportOptions } from './documentBuffers';
import type { JournalCapture } from './recoveryFunnel';

export interface SessionAdapter {
    hasPendingEdits(): boolean;
    checkpoint(): ContentSource;
    acknowledge(revision: number, outcome: 'written' | 'conflict' | 'failed'): void;
    drain?(): Promise<void>;
    settle?(): Promise<void>;
    mediaReferences?(): readonly string[] | undefined;
    mediaReferenceIssues?(): readonly string[] | undefined;
    journalDelta?(): JournalCapture | undefined;
    recover?(payload: unknown): void | Promise<void>;
    canRecover?(): boolean;
    dispose?(): void | Promise<void>;
    onChange(listener: (source: ContentSource, options?: SourceReportOptions) => void): () => void;
    onPending?(listener: () => void): () => void;
}

export interface SessionEntry<A extends SessionAdapter = SessionAdapter> {
    readonly documentId: string;
    readonly serial: number;
    readonly kind: string;
    readonly adapter: A;
    bytesGeneration: number;
    getSlot<T>(key: symbol): T | undefined;
    setSlot<T>(key: symbol, value: T, dispose?: (value: T) => void | Promise<void>): void;
    hasPendingEdits(): boolean;
}

export type SessionBufferState = Pick<DocumentBuffer, 'source' | 'revision' | 'savedRevision'>;

export interface SessionStoreBindings {
    bufferState(documentId: string): SessionBufferState | undefined;
    reportChange(documentId: string, source: ContentSource, options?: SourceReportOptions): void;
}

export type SessionReleaseCause = 'tab-close' | 'trash' | 'vault-switch' | 'kind-change';

export interface DocumentSessionStore {
    readonly size: number;

    get(documentId: string): SessionEntry | undefined;
    entries(): IterableIterator<SessionEntry>;
    subscribe(listener: () => void): () => void;
    setBytesGeneration(documentId: string, generation: number): boolean;
    settled(documentId: string): Promise<void>;

    ensure<A extends SessionAdapter>(
        documentId: string,
        kind: string,
        bytesGeneration: number,
        create: (owner: SourceOwner) => A,
    ): SessionEntry<A>;

    replace<A extends SessionAdapter>(
        documentId: string,
        kind: string,
        bytesGeneration: number,
        create: (owner: SourceOwner) => A,
    ): SessionEntry<A>;

    isLiveOwner(documentId: string, owner: SourceOwner): boolean;

    hasPendingEdits(documentId: string): boolean;

    checkpoint(documentId: string): ContentSource | undefined;

    release(documentId: string, cause: SessionReleaseCause): boolean;

    clear(cause: 'vault-switch'): void;
}

// Page-wide rather than per store: even replacing the App-owned store cannot
// make a released owner's serial live again. Clearing a vault never resets it.
let nextSerial = 0;

interface RegisteredSession {
    entry: SessionEntry;
    unsubscribe?: () => void;
    unsubscribePending?: () => void;
    disposeSlots(): void;
}

export function createDocumentSessions(bindings: SessionStoreBindings): DocumentSessionStore {
    const sessions = new Map<string, RegisteredSession>();
    const listeners = new Set<() => void>();
    const disposals = new Map<string, Set<Promise<void>>>();
    const disposeSlot = (documentId: string, dispose?: () => void | Promise<void>) => {
        if (!dispose) return;
        try {
            const result = dispose();
            if (result) {
                let pendingSet = disposals.get(documentId);
                if (!pendingSet) disposals.set(documentId, pendingSet = new Set());
                const set = pendingSet;
                const pending = Promise.resolve(result).catch(error => { console.error('Session slot disposal failed:', error); });
                set.add(pending);
                void pending.then(() => { set.delete(pending); if (!set.size && disposals.get(documentId) === set) disposals.delete(documentId); });
            }
        } catch (error) { console.error('Session slot disposal failed:', error); }
    };
    const notify = () => {
        for (const listener of [...listeners]) {
            try { listener(); } catch (error) { console.error('Session subscriber failed:', error); }
        }
    };
    const ledgerPending = (documentId: string): boolean => {
        const buffer = bindings.bufferState(documentId);
        return !!buffer && buffer.revision > buffer.savedRevision;
    };
    const unsubscribeSession = (registered: RegisteredSession) => {
        const pending = registered.unsubscribePending, change = registered.unsubscribe;
        registered.unsubscribePending = undefined;
        registered.unsubscribe = undefined;
        try { pending?.(); } finally { change?.(); }
    };
    const detach = (documentId: string): boolean => {
        const registered = sessions.get(documentId);
        if (!registered) return false;
        // Invalidate before unsubscribe: an emitter may already have queued an
        // old callback, including an ownerless string during the migration.
        sessions.delete(documentId);
        try { unsubscribeSession(registered); } finally {
            registered.disposeSlots();
            disposeSlot(documentId, registered.entry.adapter.dispose?.bind(registered.entry.adapter));
            notify();
        }
        return true;
    };
    const register = <A extends SessionAdapter>(
        documentId: string,
        kind: string,
        bytesGeneration: number,
        create: (owner: SourceOwner) => A,
    ): SessionEntry<A> => {
        if (nextSerial === Number.MAX_SAFE_INTEGER) throw new RangeError('Session serial exhausted');
        const serial = ++nextSerial;
        const adapter = create(Object.freeze({ documentId, session: serial }));
        const slots = new Map<symbol, { value: unknown; dispose?: () => void | Promise<void> }>();
        let generation = bytesGeneration;
        let closed = false;
        const entry: SessionEntry<A> = {
            documentId, serial, kind, adapter,
            get bytesGeneration() { return generation; },
            set bytesGeneration(value) { if (generation !== value) { generation = value; notify(); } },
            getSlot<T>(key: symbol) { return slots.get(key)?.value as T | undefined; },
            setSlot<T>(key: symbol, value: T, dispose?: (value: T) => void | Promise<void>) {
                if (closed) throw new Error('Cannot set a slot on a released session');
                const previous = slots.get(key);
                if (previous && Object.is(previous.value, value)) return;
                slots.delete(key);
                disposeSlot(documentId, previous?.dispose);
                slots.set(key, { value, dispose: dispose ? () => dispose(value) : undefined });
            },
            hasPendingEdits: () => ledgerPending(documentId) || adapter.hasPendingEdits(),
        };
        const registered: RegisteredSession = { entry, disposeSlots() {
            closed = true;
            const values = [...slots.values()]; slots.clear();
            for (const slot of values) disposeSlot(documentId, slot.dispose);
        } };
        sessions.set(documentId, registered);
        notify();
        try {
            const unsubscribe = adapter.onChange((source, options) => {
                if (sessions.get(documentId) === registered) bindings.reportChange(documentId, source, options);
            });
            if (sessions.get(documentId) === registered) registered.unsubscribe = unsubscribe;
            else { unsubscribe(); return entry; }
            const pending = adapter.onPending?.(() => {
                if (sessions.get(documentId) === registered) notify();
            });
            if (pending) {
                if (sessions.get(documentId) === registered) registered.unsubscribePending = pending;
                else pending();
            }
            if (sessions.get(documentId) === registered) notify();
        } catch (error) {
            if (sessions.get(documentId) === registered) {
                sessions.delete(documentId);
                try { unsubscribeSession(registered); } catch (cleanupError) { console.error('Session subscription cleanup failed:', cleanupError); }
                registered.disposeSlots();
                disposeSlot(documentId, adapter.dispose?.bind(adapter));
                notify();
            }
            throw error;
        }
        return entry;
    };

    return {
        get size() { return sessions.size; },
        get: documentId => sessions.get(documentId)?.entry,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        setBytesGeneration(documentId, generation) {
            if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError('Invalid byte generation');
            const entry = sessions.get(documentId)?.entry;
            if (!entry || entry.bytesGeneration === generation) return false;
            entry.bytesGeneration = generation;
            return true;
        },
        async settled(documentId) {
            while (disposals.has(documentId)) await Promise.all([...disposals.get(documentId)!]);
        },
        *entries() {
            for (const registered of sessions.values()) yield registered.entry;
        },
        ensure<A extends SessionAdapter>(documentId: string, kind: string, bytesGeneration: number,
            create: (owner: SourceOwner) => A): SessionEntry<A> {
            const existing = sessions.get(documentId)?.entry;
            if (existing) {
                if (existing.kind !== kind) throw new Error('A kind change must release the old session after its barrier');
                return existing as SessionEntry<A>;
            }
            return register(documentId, kind, bytesGeneration, create);
        },
        replace<A extends SessionAdapter>(documentId: string, kind: string, bytesGeneration: number,
            create: (owner: SourceOwner) => A): SessionEntry<A> {
            detach(documentId);
            return register(documentId, kind, bytesGeneration, create);
        },
        isLiveOwner(documentId, owner) {
            return owner.documentId === documentId && sessions.get(documentId)?.entry.serial === owner.session;
        },
        hasPendingEdits(documentId) {
            const entry = sessions.get(documentId)?.entry;
            return entry ? entry.hasPendingEdits() : ledgerPending(documentId);
        },
        checkpoint(documentId) {
            const entry = sessions.get(documentId)?.entry;
            return entry ? entry.adapter.checkpoint() : bindings.bufferState(documentId)?.source;
        },
        release(documentId, _cause) {
            return detach(documentId);
        },
        clear(_cause) {
            const outgoing = [...sessions.values()];
            sessions.clear();
            const errors: unknown[] = [];
            for (const registered of outgoing) {
                try { unsubscribeSession(registered); }
                catch (error) { errors.push(error); }
                finally {
                    registered.disposeSlots();
                    disposeSlot(registered.entry.documentId, registered.entry.adapter.dispose?.bind(registered.entry.adapter));
                }
            }
            if (outgoing.length) notify();
            if (errors.length) throw new AggregateError(errors, 'Could not detach every document session');
        },
    };
}
