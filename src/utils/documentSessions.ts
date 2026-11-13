/** Structurally identical to documentBuffers.SourceOwner; neither store imports the other. */
export interface SessionOwner {
    readonly documentId: string;
    readonly session: number;
}

/** Structural counterpart of documentBuffers.ContentSource, including the future engine branches.
 *  Content-source types are canonical in documentBuffers; these members keep this module import-free. */
export type SessionContentSource = string | {
    readonly kind: 'deferred';
    readonly owner: SessionOwner;
    readonly revision: number;
    read(): string | Uint8Array | Blob | {
        readonly kind: 'build';
        readonly revision: number;
        run(signal: AbortSignal): Promise<Uint8Array | Blob>;
    };
};

/** Every engine implements this same contract, even when no pane is attached. */
export interface SessionAdapter {
    /** Only the engine's own unreported work; the entry adds the buffer ledger's dirty state. */
    hasPendingEdits(): boolean;
    /** Synchronous, revision-pinned capture; may cost O(document), but never awaits work. */
    checkpoint(): SessionContentSource;
    /** Acknowledging an older engine revision must not clean a newer one. */
    acknowledge(revision: number, outcome: 'written' | 'conflict' | 'failed'): void;
    /** Closing/hide coordinator only, with its 2-second deadline; autosave/Save never await this. */
    drain?(): Promise<void>;
    /** App subscribes once when the session is created, never through the lifetime of a pane. */
    onChange(listener: (source: SessionContentSource) => void): () => void;
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
    /** Defined here: buffer.revision > savedRevision OR adapter.hasPendingEdits(). */
    hasPendingEdits(): boolean;
}

/** Structural buffer view: a cold tab needs no editor/engine session to retain or checkpoint text. */
export interface SessionBufferState {
    readonly source: SessionContentSource;
    readonly revision: number;
    readonly savedRevision: number;
}

/** Both callbacks are App-lifetime; the report callback resolves the current path by documentId. */
export interface SessionStoreBindings {
    bufferState(documentId: string): SessionBufferState | undefined;
    reportChange(documentId: string, source: SessionContentSource): void;
}

export type SessionReleaseCause = 'tab-close' | 'trash' | 'vault-switch' | 'kind-change';

export interface DocumentSessionStore {
    readonly size: number;

    get(documentId: string): SessionEntry | undefined;
    entries(): IterableIterator<SessionEntry>;

    /** Called only on first pane mount/visibility or first programmatic edit, never on tab restore.
     *  Existing same-kind entries are reused (including StrictMode); create receives its live owner.
     *  App's onChange subscription is attached once, after the entry is registered. */
    ensure<A extends SessionAdapter>(
        documentId: string,
        kind: string,
        bytesGeneration: number,
        create: (owner: SessionOwner) => A,
    ): SessionEntry<A>;

    /** Canvas disk reload only: detach the old subscription and replace with a fresh serial,
     *  synchronously with App's baseline/buffer update. Markdown instead dispatches externalReload
     *  into its existing adapter and keeps its serial; this method is not used for Markdown reload. */
    replace<A extends SessionAdapter>(
        documentId: string,
        kind: string,
        bytesGeneration: number,
        create: (owner: SessionOwner) => A,
    ): SessionEntry<A>;

    /** Owner check used by the path-explicit funnel after resolving the tab's current document id. */
    isLiveOwner(documentId: string, owner: SessionOwner): boolean;

    /** Entry's one pending predicate, or just the ledger when the tab has no session yet. */
    hasPendingEdits(documentId: string): boolean;

    /** Entry's pinned capture, or the cold tab's latest source; undefined for an unknown document. */
    checkpoint(documentId: string): SessionContentSource | undefined;

    /** App only, after the closing barrier; never caused by hide, pane unmount, rename or diskRev. */
    release(documentId: string, cause: SessionReleaseCause): boolean;

    /** Called after all outgoing-vault barriers settle; never resets the page's serial allocator. */
    clear(cause: 'vault-switch'): void;
}

/** App owns exactly one instance for its life; its structural bindings avoid cross-store imports.
 *  This interface checkpoint intentionally has no implementation and is imported by nothing. */
export declare function createDocumentSessions(bindings: SessionStoreBindings): DocumentSessionStore;
