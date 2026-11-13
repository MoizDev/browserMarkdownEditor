/** Save-funnel ownership is a document id plus the session store's page-unique serial. */
export interface SourceOwner {
    readonly documentId: string;
    readonly session: number;
}

/** Immutable worker inputs for exactly one source revision; never reads the live session. */
export interface BuildJob {
    readonly kind: 'build';
    readonly revision: number;
    run(signal: AbortSignal): Promise<Uint8Array | Blob>;
}

/** Binary/build branches are published for engine adapters; C-19 implements string storage only. */
export type SnapshotData = string | Uint8Array | Blob | BuildJob;

/** A pinned snapshot whose synchronous, side-effect-free read remains valid for the app's life. */
export interface DeferredSource {
    readonly kind: 'deferred';
    readonly owner: SourceOwner;
    readonly revision: number;
    read(): SnapshotData;
}

export type ContentSource = string | DeferredSource;

/** App revisions, not a reporter's revision, decide whether the buffer is dirty. */
export interface BufferRevision {
    readonly revision: number;
    readonly savedRevision: number;
}

/** Only the newest accepted source and its newest flatten may be retained. */
export interface DocumentBuffer extends BufferRevision {
    readonly owner: SourceOwner;
    readonly source: ContentSource;
    /** Text authority only; false does not prohibit binary-aware saving. */
    readonly readable: boolean;
    readonly flat?: { readonly revision: number; readonly text: string };
}

/** Synchronously captured before any await in the save or conflict-copy path. */
export interface BufferSnapshot {
    readonly revision: number;
    readonly data: SnapshotData;
}

/** App owns one store, outside React; path accessors resolve the current document on every call. */
export interface DocumentBufferStore {
    /** Initial disk text is clean. Reopening an existing id never replaces its unsaved source.
     *  Before its first session, the owner has session=0 (a serial no live session may use). */
    open(documentId: string, source: string, readable: boolean): Readonly<DocumentBuffer>;

    /** Raw latest-source access by id, without flattening, for the session bridge and save owner. */
    get(documentId: string): Readonly<DocumentBuffer> | undefined;

    /** Rebind metadata when App creates/replaces a session; never increments the content revision. */
    setOwner(documentId: string, owner: SourceOwner): void;

    /** Loaded representation controls text access, independently of save permission. */
    setReadable(documentId: string, readable: boolean): void;

    /** Each accepted string report increments App's revision and drops the old flatten.
     *  fromDisk also marks that revision saved. Missing ids and non-string sources return undefined;
     *  deferred/binary/build handling is typed only here and comes in a later package. */
    report(documentId: string, source: ContentSource, fromDisk?: boolean): Readonly<DocumentBuffer> | undefined;

    /** Acknowledges only a captured, existing revision; an old write never cleans a newer edit. */
    markSaved(documentId: string, revision: number): boolean;

    /** The single dirty predicate for the ledger (sessions add their own unreported work). */
    isDirty(documentId: string): boolean;

    /** O(1), stable until either ledger number changes; usable by a React-free external-store reader. */
    revisionForDocument(documentId: string): BufferRevision | undefined;

    /** Per-document revision notifications; useDocumentRevision is a caller-side React adapter. */
    subscribe(documentId: string, listener: () => void): () => void;

    /** Latest readable text, otherwise undefined. Never a promise; one flatten per new revision. */
    contentOf(path: string): string | undefined;

    /** Binary-aware save/conflict snapshot, independent of readable. Future data branches are typed only. */
    snapshotOf(path: string): BufferSnapshot | undefined;

    /** The same ledger as revisionForDocument, resolving today's id at the supplied path. */
    revisionOf(path: string): BufferRevision | undefined;

    /** App removes buffers with their documents, after any closing write has settled. */
    remove(documentId: string): boolean;

    /** Only a completed outgoing-vault barrier may clear all buffers. */
    clear(): void;
}

/** App creates one instance for its life. The resolver reads App-level refs, never a pane closure.
 *  This interface checkpoint intentionally has no implementation or runtime caller. */
export declare function createDocumentBuffers(
    documentIdAtPath: (path: string) => string | undefined,
): DocumentBufferStore;
