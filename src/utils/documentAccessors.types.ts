import type { BufferRevision, BufferSnapshot } from './documentBuffers';

export interface DocumentAccessors {
    contentOf(path: string): string | undefined;
    snapshotOf(path: string): BufferSnapshot | undefined;
    revisionOf(path: string): BufferRevision | undefined;
    useDocumentRevision(documentId: string): BufferRevision | undefined;
}

export interface DocumentIdentityAccessors {
    contentForDocument(documentId: string): string | undefined;
    snapshotForDocument(documentId: string): BufferSnapshot | undefined;
}
