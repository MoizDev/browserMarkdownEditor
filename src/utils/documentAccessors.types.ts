import type { BufferRevision, BufferSnapshot } from './documentBuffers';

/** App-lifetime accessors, resolving the document at its current path. */
export interface DocumentAccessors {
    contentOf(path: string): string | undefined;
    snapshotOf(path: string): BufferSnapshot | undefined;
    revisionOf(path: string): BufferRevision | undefined;
    useDocumentRevision(documentId: string): BufferRevision | undefined;
}

/** Identity-based reads for a newly seeded document before its pane attaches. */
export interface DocumentIdentityAccessors {
    contentForDocument(documentId: string): string | undefined;
    snapshotForDocument(documentId: string): BufferSnapshot | undefined;
}
