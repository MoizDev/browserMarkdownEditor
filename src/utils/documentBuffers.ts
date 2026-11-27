export interface SourceOwner {
    readonly documentId: string;
    readonly session: number;
}

export interface BuildJob {
    readonly kind: 'build';
    readonly revision: number;
    run(signal: AbortSignal): Promise<Uint8Array | Blob>;
}

export type SnapshotData = string | Uint8Array | Blob | BuildJob;

export interface SourceLease { release(): void }

export interface DeferredSource {
    readonly kind: 'deferred';
    readonly owner: SourceOwner;
    readonly revision: number;
    read(): SnapshotData;
    retain?(): SourceLease;
}

export type ContentSource = string | DeferredSource;

export function sourceIsNewer(candidate: ContentSource, prior: ContentSource | undefined): boolean {
    if (typeof candidate === 'string') return candidate !== prior;
    return prior === undefined || typeof prior === 'string'
        || candidate.owner.documentId !== prior.owner.documentId || candidate.owner.session !== prior.owner.session
        || candidate.revision > prior.revision;
}

export interface SourceReportOptions {
    readonly fromDisk?: boolean;
}

export interface BufferRevision {
    readonly revision: number;
    readonly savedRevision: number;
}

export interface DocumentBuffer extends BufferRevision {
    readonly owner: SourceOwner;
    readonly source: ContentSource;
    readonly readable: boolean;
    readonly flushable: boolean;
    readonly flat?: { readonly revision: number; readonly text: string };
}

export interface BufferSnapshot {
    readonly revision: number;
    readonly data: SnapshotData;
}

export interface PinnedBufferSnapshot extends BufferSnapshot, SourceLease {}

export interface DocumentBufferStore {
    open(documentId: string, source: string, readable: boolean): Readonly<DocumentBuffer>;

    get(documentId: string): Readonly<DocumentBuffer> | undefined;

    setOwner(documentId: string, owner: SourceOwner): void;

    setReadable(documentId: string, readable: boolean): void;

    setFlushable(documentId: string, flushable: boolean): void;

    report(documentId: string, source: ContentSource, fromDisk?: boolean, flushable?: boolean): Readonly<DocumentBuffer> | undefined;

    /** Acknowledges only a captured, existing revision; an old write never cleans a newer edit.
     *  Returns true only when savedRevision advances, not whether the disk write succeeded. */
    markSaved(documentId: string, revision: number): boolean;

    isDirty(documentId: string): boolean;

    revisionForDocument(documentId: string): BufferRevision | undefined;

    subscribe(documentId: string, listener: () => void): () => void;

    contentOf(path: string): string | undefined;
    contentForDocument(documentId: string): string | undefined;

    snapshotOf(path: string): BufferSnapshot | undefined;
    snapshotForDocument(documentId: string): BufferSnapshot | undefined;
    retainSnapshotOf(path: string): PinnedBufferSnapshot | undefined;
    retainSnapshotForDocument(documentId: string): PinnedBufferSnapshot | undefined;

    revisionOf(path: string): BufferRevision | undefined;

    remove(documentId: string): boolean;

    clear(): void;
}

export function createDocumentBuffers(
    documentIdAtPath: (path: string) => string | undefined,
): DocumentBufferStore {
    type OwnedBuffer = DocumentBuffer & { readonly sourceLease?: SourceLease };
    const buffers = new Map<string, Readonly<OwnedBuffer>>();
    const snapshots = new Map<string, { revision: number; data: SnapshotData }>();
    const revisions = new Map<string, BufferRevision>();
    const listeners = new Map<string, Set<() => void>>();
    const notify = (documentId: string) => {
        for (const listener of [...(listeners.get(documentId) ?? [])]) listener();
    };
    const publish = (documentId: string, next: OwnedBuffer): Readonly<OwnedBuffer> => {
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

    const retainSnapshotForDocument = (documentId: string): PinnedBufferSnapshot | undefined => {
        const buffer = buffers.get(documentId);
        if (!buffer) return undefined;
        const lease = typeof buffer.source === 'string' ? undefined : buffer.source.retain?.();
        try {
            const snapshot = readSnapshot(documentId, buffer);
            let released = false;
            return { ...snapshot, release() { if (!released) { released = true; lease?.release(); } } };
        } catch (error) { lease?.release(); throw error; }
    };

    return {
        open(documentId, source, readable) {
            const existing = buffers.get(documentId);
            if (existing) return existing;
            return publish(documentId, {
                owner: Object.freeze({ documentId, session: 0 }),
                source, revision: 0, savedRevision: 0, readable, flushable: false,
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
        setFlushable(documentId, flushable) {
            const buffer = buffers.get(documentId);
            if (buffer && buffer.flushable !== flushable) publish(documentId, { ...buffer, flushable });
        },
        report(documentId, source, fromDisk = false, flushable) {
            const buffer = buffers.get(documentId);
            if (!buffer) return undefined;
            const revision = buffer.revision + 1;
            if (!Number.isSafeInteger(revision)) throw new RangeError('Document revision exhausted');
            const sourceLease = typeof source === 'string' ? undefined : source.retain?.();
            snapshots.delete(documentId);
            try {
                return publish(documentId, {
                    owner: buffer.owner, source, sourceLease, revision,
                    savedRevision: fromDisk ? revision : buffer.savedRevision,
                    readable: buffer.readable, flushable: fromDisk ? false : flushable ?? buffer.flushable,
                });
            } finally { buffer.sourceLease?.release(); }
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
        retainSnapshotForDocument,
        retainSnapshotOf(path) {
            const documentId = documentIdAtPath(path);
            return documentId === undefined ? undefined : retainSnapshotForDocument(documentId);
        },
        revisionOf(path) {
            const documentId = documentIdAtPath(path);
            return documentId === undefined ? undefined : revisions.get(documentId);
        },
        remove(documentId) {
            const buffer = buffers.get(documentId);
            if (!buffer || !buffers.delete(documentId)) return false;
            buffer.sourceLease?.release();
            snapshots.delete(documentId);
            revisions.delete(documentId);
            notify(documentId);
            return true;
        },
        clear() {
            const documentIds = [...buffers.keys()];
            const owned = [...buffers.values()];
            buffers.clear();
            for (const buffer of owned) buffer.sourceLease?.release();
            snapshots.clear();
            revisions.clear();
            for (const documentId of documentIds) notify(documentId);
        },
    };
}
