import { useCallback, useSyncExternalStore } from 'react';
import type { BufferRevision, DocumentBufferStore } from './documentBuffers';

/** Subscribe only to this document's ledger, never to another pane's edits. */
export function useDocumentRevision(store: DocumentBufferStore, documentId: string): BufferRevision | undefined {
    const subscribe = useCallback((listener: () => void) => store.subscribe(documentId, listener), [store, documentId]);
    const snapshot = useCallback(() => store.revisionForDocument(documentId), [store, documentId]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
