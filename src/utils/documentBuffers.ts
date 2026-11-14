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

/** Binary/build branches are pinned by the engine adapter for a later save. */
export type SnapshotData = string | Uint8Array | Blob | BuildJob;

/** A pinned snapshot whose synchronous, side-effect-free read remains valid for the app's life. */
export interface DeferredSource {
    readonly kind: 'deferred';
    readonly owner: SourceOwner;
    readonly revision: number;
    read(): SnapshotData;
}

export type ContentSource = string | DeferredSource;

/** A disk reload reports its new immutable source without creating an unsaved edit. */
export interface SourceReportOptions {
    readonly fromDisk?: boolean;
}

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

    /** Each accepted report increments App's revision and drops the old flatten.
     *  fromDisk also marks that revision saved. App rejects a stale source owner before reporting. */
    report(documentId: string, source: ContentSource, fromDisk?: boolean): Readonly<DocumentBuffer> | undefined;

    /** Acknowledges only a captured, existing revision; an old write never cleans a newer edit.
     *  Returns true only when savedRevision advances, not whether the disk write succeeded. */
    markSaved(documentId: string, revision: number): boolean;

    /** The single dirty predicate for the ledger (sessions add their own unreported work). */
    isDirty(documentId: string): boolean;

    /** O(1), stable until either ledger number changes; usable by a React-free external-store reader. */
    revisionForDocument(documentId: string): BufferRevision | undefined;

    /** Per-document revision notifications; useDocumentRevision is a caller-side React adapter. */
    subscribe(documentId: string, listener: () => void): () => void;

    /** Latest readable text, otherwise undefined. Never a promise; one flatten per new revision. */
    contentOf(path: string): string | undefined;
    contentForDocument(documentId: string): string | undefined;

    /** Binary-aware save/conflict snapshot, independent of readable. */
    snapshotOf(path: string): BufferSnapshot | undefined;
    snapshotForDocument(documentId: string): BufferSnapshot | undefined;

    /** The same ledger as revisionForDocument, resolving today's id at the supplied path. */
    revisionOf(path: string): BufferRevision | undefined;

    /** App removes buffers with their documents, after any closing write has settled. */
    remove(documentId: string): boolean;

    /** Only a completed outgoing-vault barrier may clear all buffers. */
    clear(): void;
}

/** App creates one instance for its life. The resolver reads App-level refs, never a pane closure.
 *  Still unwired: C-20 owns representation/save guards and the existing save funnel. */
export function createDocumentBuffers(
    documentIdAtPath: (path: string) => string | undefined,
): DocumentBufferStore {
    const buffers = new Map<string, Readonly<DocumentBuffer>>();
    // A source can flatten to text, bytes, a Blob or a BuildJob. Both accessors
    // share this one capture so an expensive read is not repeated per revision.
    const snapshots = new Map<string, { revision: number; data: SnapshotData }>();
    // A React external-store snapshot must stay identical on a cache fill or
    // owner change, and must not retain the document's content inside React.
    const revisions = new Map<string, BufferRevision>();
    const listeners = new Map<string, Set<() => void>>();
    const notify = (documentId: string) => {
        for (const listener of [...(listeners.get(documentId) ?? [])]) listener();
    };
    const publish = (documentId: string, next: DocumentBuffer): Readonly<DocumentBuffer> => {
        const buffer = Object.freeze(next);
        buffers.set(documentId, buffer);
        const previous = revisions.get(documentId);
        if (!previous || previous.revision !== buffer.revision || previous.savedRevision !== buffer.savedRevision) {
            revisions.set(documentId, Object.freeze({ revision: buffer.revision, savedRevision: buffer.savedRevision }));
            notify(documentId);
        }
        return buffer;
    };
    const readSnapshot = (documentId: string, buffer: Readonly<DocumentBuffer>): BufferSnapshot => {
        const cached = snapshots.get(documentId);
        if (cached?.revision === buffer.revision) return cached;
        const source = buffer.source;
        const data = typeof source === 'string' ? source : source.read();
        if (typeof source !== 'string' && typeof data === 'object' && data !== null
            && 'kind' in data && data.kind === 'build' && (data as BuildJob).revision !== source.revision) {
            throw new Error('A build job must belong to its captured source revision');
        }
        const snapshot = Object.freeze({ revision: buffer.revision, data });
        snapshots.set(documentId, snapshot);
        return snapshot;
    };

    const contentForDocument = (documentId: string): string | undefined => {
        const buffer = buffers.get(documentId);
        if (!buffer || !buffer.readable) return undefined;
        if (buffer.flat?.revision === buffer.revision) return buffer.flat.text;
        const data = readSnapshot(documentId, buffer).data;
        if (typeof data !== 'string') return undefined;
        const flat = Object.freeze({ revision: buffer.revision, text: data });
        buffers.set(documentId, Object.freeze({ ...buffer, flat }));
        return flat.text;
    };
    const snapshotForDocument = (documentId: string): BufferSnapshot | undefined => {
        const buffer = buffers.get(documentId);
        return buffer ? readSnapshot(documentId, buffer) : undefined;
    };

    return {
        open(documentId, source, readable) {
            const existing = buffers.get(documentId);
            if (existing) return existing;
            return publish(documentId, {
                owner: Object.freeze({ documentId, session: 0 }),
                source, revision: 0, savedRevision: 0, readable,
            });
        },
        get: documentId => buffers.get(documentId),
        setOwner(documentId, owner) {
            const buffer = buffers.get(documentId);
            if (!buffer) return;
            if (owner.documentId !== documentId || !Number.isSafeInteger(owner.session) || owner.session < 0) {
                throw new TypeError('A buffer owner must name this document and a nonnegative session serial');
            }
            if (buffer.owner.session === owner.session) return;
            publish(documentId, { ...buffer, owner: Object.freeze({ ...owner }) });
        },
        setReadable(documentId, readable) {
            const buffer = buffers.get(documentId);
            if (buffer && buffer.readable !== readable) publish(documentId, { ...buffer, readable });
        },
        report(documentId, source, fromDisk = false) {
            const buffer = buffers.get(documentId);
            if (!buffer) return undefined;
            snapshots.delete(documentId);
            const revision = buffer.revision + 1;
            if (!Number.isSafeInteger(revision)) throw new RangeError('Document revision exhausted');
            return publish(documentId, {
                owner: buffer.owner, source, revision,
                savedRevision: fromDisk ? revision : buffer.savedRevision,
                readable: buffer.readable,
            });
        },
        markSaved(documentId, revision) {
            const buffer = buffers.get(documentId);
            if (!buffer || !Number.isSafeInteger(revision) || revision < 0
                || revision > buffer.revision || revision <= buffer.savedRevision) return false;
            publish(documentId, { ...buffer, savedRevision: revision });
            return true;
        },
        isDirty(documentId) {
            const buffer = buffers.get(documentId);
            return !!buffer && buffer.revision > buffer.savedRevision;
        },
        revisionForDocument: documentId => revisions.get(documentId),
        subscribe(documentId, listener) {
            let set = listeners.get(documentId);
            if (!set) listeners.set(documentId, set = new Set());
            const subscribed = set;
            subscribed.add(listener);
            return () => {
                subscribed.delete(listener);
                if (!subscribed.size && listeners.get(documentId) === subscribed) listeners.delete(documentId);
            };
        },
        contentForDocument,
        contentOf(path) {
            const documentId = documentIdAtPath(path);
            return documentId === undefined ? undefined : contentForDocument(documentId);
        },
        snapshotForDocument,
        snapshotOf(path) {
            const documentId = documentIdAtPath(path);
            return documentId === undefined ? undefined : snapshotForDocument(documentId);
        },
        revisionOf(path) {
            const documentId = documentIdAtPath(path);
            return documentId === undefined ? undefined : revisions.get(documentId);
        },
        remove(documentId) {
            if (!buffers.delete(documentId)) return false;
            snapshots.delete(documentId);
            revisions.delete(documentId);
            notify(documentId);
            return true;
        },
        clear() {
            const documentIds = [...buffers.keys()];
            buffers.clear();
            snapshots.clear();
            revisions.clear();
            // Subscriptions outlive an entry until their caller unsubscribes;
            // dropping them here would miss a same-id kind replacement.
            for (const documentId of documentIds) notify(documentId);
        },
    };
}
