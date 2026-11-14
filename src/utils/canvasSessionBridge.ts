import type { ContentSource, SourceOwner } from './documentBuffers';
import type { SessionAdapter } from './documentSessions';

/** The identity belongs to App even before an editable canvas host is ready. */
export interface CanvasSessionBridge extends SessionAdapter {
    /** StrictMode and additional panes attach to the same engine session. */
    attach<A extends SessionAdapter>(create: (owner: SourceOwner) => A): A;
}

/**
 * A PDF reader may need a document identity before Annotate is opened. This
 * adapter upgrades that one identity in place; it never creates a parallel
 * document or changes the session serial and its resource slots.
 */
export function createCanvasSessionBridge(owner: SourceOwner, coldSource: () => ContentSource): CanvasSessionBridge {
    let adapter: SessionAdapter | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    const listeners = new Set<(source: ContentSource) => void>();
    const owned = (source: ContentSource): boolean => typeof source !== 'string'
        && source.owner.documentId === owner.documentId && source.owner.session === owner.session;
    const emit = (source: ContentSource) => {
        // Once migrated, a canvas must never send an ownerless legacy string.
        // App also checks the current store serial on every report.
        if (disposed || !owned(source)) return;
        for (const listener of [...listeners]) listener(source);
    };
    return {
        attach<A extends SessionAdapter>(create: (owner: SourceOwner) => A): A {
            if (disposed) throw new Error('Cannot attach a released canvas session');
            if (adapter) return adapter as A;
            const next = create(owner);
            adapter = next;
            try { unsubscribe = next.onChange(emit); }
            catch (error) { adapter = undefined; throw error; }
            return next;
        },
        hasPendingEdits: () => adapter?.hasPendingEdits() ?? false,
        checkpoint() {
            if (!adapter) return coldSource();
            const source = adapter.checkpoint();
            if (!owned(source)) throw new Error('Canvas checkpoint has a stale or missing owner');
            return source;
        },
        acknowledge(revision, outcome) { adapter?.acknowledge(revision, outcome); },
        async drain() { await adapter?.drain?.(); },
        journalDelta() { return adapter?.journalDelta?.(); },
        async recover(payload) {
            if (!adapter?.recover) throw new Error('Canvas session is not ready for recovery');
            await adapter.recover(payload);
        },
        onChange(listener) {
            if (disposed) throw new Error('Cannot subscribe to a released canvas session');
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (listeners.size) return;
                // The store detaches before releasing its slots; a late engine
                // callback must not report into the next session at this path.
                disposed = true;
                unsubscribe?.();
                unsubscribe = undefined;
                adapter = undefined;
            };
        },
    };
}
