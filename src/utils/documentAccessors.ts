import type { DocumentBufferStore } from './documentBuffers';
import type { DocumentAccessors } from './documentAccessors.types';
import { useDocumentRevision } from './useDocumentRevision';

export function createDocumentAccessors(store: DocumentBufferStore): DocumentAccessors {
    return {
        contentOf: store.contentOf,
        snapshotOf: store.snapshotOf,
        revisionOf: store.revisionOf,
        useDocumentRevision(documentId) { return useDocumentRevision(store, documentId); },
    };
}
export type { DocumentAccessors } from './documentAccessors.types';
