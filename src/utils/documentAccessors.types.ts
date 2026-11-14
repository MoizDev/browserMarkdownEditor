import type { BufferRevision, BufferSnapshot } from './documentBuffers';

/** App-lifetime accessors, resolving the document at its current path. */
export interface DocumentAccessors {
    contentOf(path: string): string | undefined;
    snapshotOf(path: string): BufferSnapshot | undefined;
    revisionOf(path: string): BufferRevision | undefined;
    useDocumentRevision(documentId: string): BufferRevision | undefined;
}
