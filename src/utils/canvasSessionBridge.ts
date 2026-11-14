import type { ContentSource, SourceOwner } from './documentBuffers';
import type { DocumentSessionStore, SessionAdapter } from './documentSessions';

/** The identity belongs to App even before an editable canvas host is ready. */
export interface CanvasSessionBridge extends SessionAdapter {
    /** StrictMode and additional panes attach to the same engine session. */
    attach<A extends SessionAdapter>(create: (owner: SourceOwner) => A): A;
    dispose(): Promise<void>;
}

export type AttachCanvasSession = <A extends SessionAdapter>(
    documentId: string,
    create: (owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean) => A,
) => A;

/** Attach only through App's already-created entry, never from a parallel pane-owned store. */
export function attachCanvasSession<A extends SessionAdapter>(
    sessions: DocumentSessionStore,
    documentId: string,
    create: (owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean) => A,
): A {
    const entry = sessions.get(documentId);
    if (!entry || !('attach' in entry.adapter) || typeof entry.adapter.attach !== 'function') {
        throw new Error('Canvas session identity is not ready');
    }
    const isLiveOwner = (owner: SourceOwner) => sessions.isLiveOwner(documentId, owner);
    return (entry.adapter as CanvasSessionBridge).attach(owner => {
        if (!isLiveOwner(owner)) throw new DOMException('Canvas session ended', 'AbortError');
        const adapter = create(owner, isLiveOwner);
        if (!isLiveOwner(owner)) throw new DOMException('Canvas session ended', 'AbortError');
        return adapter;
    });
}

/**
 * A PDF reader may need a document identity before Annotate is opened. This
 * adapter upgrades that one identity in place; it never creates a parallel
 * document or changes the session serial and its resource slots.
 */
export function createCanvasSessionBridge(owner: SourceOwner, coldSource: () => ContentSource): CanvasSessionBridge {
    let adapter: SessionAdapter | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposeAdapter: (() => void | Promise<void>) | undefined;
    let releaseWork: Promise<void> | undefined;
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
            const disposable = next as SessionAdapter & { dispose?: () => void | Promise<void> };
            disposeAdapter = disposable.dispose?.bind(next);
            try {
                const detach = next.onChange(emit);
                // A synchronous first report can cause App to release the
                // entry before onChange returns its cleanup.
                if (disposed) { detach(); throw new Error('Canvas session was released during attachment'); }
                unsubscribe = detach;
            } catch (error) {
                adapter = undefined;
                const dispose = disposeAdapter;
                disposeAdapter = undefined;
                if (dispose) void Promise.resolve().then(dispose).catch(() => {});
                throw error;
            }
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
        dispose() {
            if (releaseWork) return releaseWork;
            disposed = true;
            const detach = unsubscribe;
            const dispose = disposeAdapter;
            unsubscribe = undefined;
            disposeAdapter = undefined;
            adapter = undefined;
            let detachError: unknown;
            try { detach?.(); } catch (error) { detachError = error; }
            releaseWork = Promise.resolve().then(async () => {
                // A detach error wins over a dispose error, as a throw in `finally` would make it.
                let disposeFailed = false;
                let disposeError: unknown;
                try { await dispose?.(); } catch (error) { disposeFailed = true; disposeError = error; }
                if (detachError !== undefined) throw detachError;
                if (disposeFailed) throw disposeError;
            });
            return releaseWork;
        },
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
                const detach = unsubscribe;
                unsubscribe = undefined;
                adapter = undefined;
                detach?.();
            };
        },
    };
}
