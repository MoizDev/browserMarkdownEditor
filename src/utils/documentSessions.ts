import type { ContentSource, DocumentBuffer, SourceOwner } from './documentBuffers';
import type { JournalCapture } from './recoveryFunnel';

// Share the source types without a runtime dependency; App's bindings are the
// only runtime bridge, so two stores cannot drift into separate ownership rules.

/** Every engine implements this same contract, even when no pane is attached. */
export interface SessionAdapter {
    /** Only the engine's own unreported work; the entry adds the buffer ledger's dirty state. */
    hasPendingEdits(): boolean;
    /** Synchronous, revision-pinned capture; may cost O(document), but never awaits work. */
    checkpoint(): ContentSource;
    /** Outcomes describe attempted writes only; an older acknowledgement never cleans a newer edit.
     *  A read-only role, foreign write mark or encrypted-file refusal is not acknowledged at all:
     *  the revision stays dirty and App's disk state holds the reason. */
    acknowledge(revision: number, outcome: 'written' | 'conflict' | 'failed'): void;
    /** Closing/hide coordinator only, with its 2-second deadline; autosave/Save never await this.
     *  Before E4's journal, a miss keeps the edit in the buffer, the tab dirty and the leave prompt
     *  armed; a later save retries. It never abandons the edit or marks it saved. */
    drain?(): Promise<void>;
    /** Immutable, structured-cloneable unsaved changes, pinned to this session and revision. */
    journalDelta?(): JournalCapture | undefined;
    /** Apply a validated, matching-baseline recovery as one undoable change. */
    recover?(payload: unknown): void | Promise<void>;
    /** App subscribes once when the session is created, never through the lifetime of a pane. */
    onChange(listener: (source: ContentSource) => void): () => void;
}

/** One identity and one pending predicate, shared by editors and canvas engines. */
export interface SessionEntry<A extends SessionAdapter = SessionAdapter> {
    readonly documentId: string;
    /** Page-unique, nonzero, never reused, including after release or a vault switch. */
    readonly serial: number;
    /** App's engine/configuration kind, not a path or a diskRev. */
    readonly kind: string;
    readonly adapter: A;
    /** App bumps this only for reload, rotation or a byte swap, never rename/move/text save. */
    bytesGeneration: number;
    /** Opaque engine-owned state follows the session, not its panes. */
    getSlot<T>(key: symbol): T | undefined;
    setSlot<T>(key: symbol, value: T, dispose?: (value: T) => void | Promise<void>): void;
    /** Defined here: buffer.revision > savedRevision OR adapter.hasPendingEdits(). */
    hasPendingEdits(): boolean;
}

/** Structural buffer view: a cold tab needs no editor/engine session to retain or checkpoint text. */
export type SessionBufferState = Pick<DocumentBuffer, 'source' | 'revision' | 'savedRevision'>;

/** Both callbacks are App-lifetime; the report callback resolves the current path by documentId. */
export interface SessionStoreBindings {
    bufferState(documentId: string): SessionBufferState | undefined;
    reportChange(documentId: string, source: ContentSource): void;
}

export type SessionReleaseCause = 'tab-close' | 'trash' | 'vault-switch' | 'kind-change';

export interface DocumentSessionStore {
    readonly size: number;

    get(documentId: string): SessionEntry | undefined;
    entries(): IterableIterator<SessionEntry>;
    subscribe(listener: () => void): () => void;
    /** Wait for every slot teardown started for this document, including replacements. */
    settled(documentId: string): Promise<void>;

    /** Called only on first pane mount/visibility or first programmatic edit, never on tab restore.
     *  Existing same-kind entries are reused (including StrictMode); create receives its live owner.
     *  App's onChange subscription is attached once, after the entry is registered.
     *  bytesGeneration initializes a new entry only; App updates an existing entry's field. */
    ensure<A extends SessionAdapter>(
        documentId: string,
        kind: string,
        bytesGeneration: number,
        create: (owner: SourceOwner) => A,
    ): SessionEntry<A>;

    /** Canvas disk reload only: detach the old subscription and replace with a fresh serial,
     *  synchronously with App's baseline/buffer update. Markdown instead dispatches externalReload
     *  into its existing adapter and keeps its serial; this method is not used for Markdown reload. */
    replace<A extends SessionAdapter>(
        documentId: string,
        kind: string,
        bytesGeneration: number,
        create: (owner: SourceOwner) => A,
    ): SessionEntry<A>;

    /** Owner check used by the path-explicit funnel after resolving the tab's current document id. */
    isLiveOwner(documentId: string, owner: SourceOwner): boolean;

    /** Entry's one pending predicate, or just the ledger when the tab has no session yet. */
    hasPendingEdits(documentId: string): boolean;

    /** Entry's pinned capture, or the cold tab's latest source; undefined for an unknown document. */
    checkpoint(documentId: string): ContentSource | undefined;

    /** App only, after the closing barrier; never caused by hide, pane unmount, rename or diskRev. */
    release(documentId: string, cause: SessionReleaseCause): boolean;

    /** Called after all outgoing-vault barriers settle; never resets the page's serial allocator. */
    clear(cause: 'vault-switch'): void;
}

// Page-wide rather than per store: even replacing the App-owned store cannot
// make a released owner's serial live again. Clearing a vault never resets it.
let nextSerial = 0;

interface RegisteredSession {
    entry: SessionEntry;
    unsubscribe?: () => void;
    disposeSlots(): void;
}

/** App owns exactly one instance for its life; bindings keep the stores runtime-independent.
 *  Still unwired: C-20 owns barriers, baseline updates, lazy creation and bytesGeneration changes. */
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
    const detach = (documentId: string): boolean => {
        const registered = sessions.get(documentId);
        if (!registered) return false;
        // Invalidate before unsubscribe: an emitter may already have queued an
        // old callback, including an ownerless string during the migration.
        sessions.delete(documentId);
        const unsubscribe = registered.unsubscribe;
        registered.unsubscribe = undefined;
        try { unsubscribe?.(); } finally { registered.disposeSlots(); notify(); }
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
            const unsubscribe = adapter.onChange(source => {
                if (sessions.get(documentId) === registered) bindings.reportChange(documentId, source);
            });
            // onChange may emit synchronously and a caller may release/replace
            // in that callback. Do not retain its subscription after that edge.
            if (sessions.get(documentId) === registered) registered.unsubscribe = unsubscribe;
            else unsubscribe();
        } catch (error) {
            if (sessions.get(documentId) === registered) { sessions.delete(documentId); registered.disposeSlots(); notify(); }
            throw error;
        }
        return entry;
    };

    return {
        get size() { return sessions.size; },
        get: documentId => sessions.get(documentId)?.entry,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
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
                // A stable kind identifies the engine/configuration that owns
                // this adapter; a second pane never constructs another one.
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
            // All old callbacks are stale before any unsubscribe runs. One
            // broken adapter must not keep the rest of the vault subscribed.
            for (const registered of outgoing) {
                const unsubscribe = registered.unsubscribe;
                registered.unsubscribe = undefined;
                try { unsubscribe?.(); }
                catch (error) { errors.push(error); }
                finally { registered.disposeSlots(); }
            }
            if (outgoing.length) notify();
            if (errors.length) throw new AggregateError(errors, 'Could not detach every document session');
        },
    };
}
