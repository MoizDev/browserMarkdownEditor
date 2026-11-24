import type { DocumentBufferStore } from './documentBuffers';
import type { DocumentAccessors } from './documentAccessors.types';
import { useDocumentRevision } from './useDocumentRevision';

/** App creates this once; its store resolves each path at the moment of use. */
export function createDocumentAccessors(store: DocumentBufferStore): DocumentAccessors {
    return {
        contentOf: store.contentOf,
        snapshotOf: store.snapshotOf,
        revisionOf: store.revisionOf,
        useDocumentRevision(documentId) { return useDocumentRevision(store, documentId); },
    };
}
export type { DocumentAccessors } from './documentAccessors.types';
