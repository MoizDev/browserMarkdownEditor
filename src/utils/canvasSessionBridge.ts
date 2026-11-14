import type { ContentSource, SourceOwner } from './documentBuffers';
import type { DocumentSessionStore, SessionAdapter } from './documentSessions';

/** The identity belongs to App even before an editable canvas host is ready. */
export interface CanvasSessionBridge extends SessionAdapter {
    /** StrictMode and additional panes attach to the same engine session. */
    attach<A extends SessionAdapter>(create: (owner: SourceOwner) => A, commit?: (adapter: A, owner: SourceOwner) => void): A;
    /** Rejected provisional engines retire before another preparation or owner release. */
    settled(): Promise<void>;
    peek<A extends SessionAdapter>(): A | undefined;
    dispose(): Promise<void>;
}

export type AttachCanvasSession = <A extends SessionAdapter>(
    documentId: string,
    create: (owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean) => A,
    commit?: (adapter: A, owner: SourceOwner) => void,
) => A;

/** Attach only through App's already-created entry, never from a parallel pane-owned store. */
export function attachCanvasSession<A extends SessionAdapter>(
    sessions: DocumentSessionStore,
    documentId: string,
    create: (owner: SourceOwner, isLiveOwner: (owner: SourceOwner) => boolean) => A,
    commit?: (adapter: A, owner: SourceOwner) => void,
): A {
    const entry = sessions.get(documentId);
    if (!entry || !('attach' in entry.adapter) || typeof entry.adapter.attach !== 'function') {
        throw new Error('Canvas session identity is not ready');
    }
    const isLiveOwner = (owner: SourceOwner) => sessions.isLiveOwner(documentId, owner);
    return (entry.adapter as CanvasSessionBridge).attach(owner => {
        if (!isLiveOwner(owner)) throw new DOMException('Canvas session ended', 'AbortError');
        return create(owner, isLiveOwner);
    }, (adapter, owner) => {
        if (!isLiveOwner(owner)) throw new DOMException('Canvas session ended', 'AbortError');
        commit?.(adapter, owner);
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
    let unsubscribePending: (() => void) | undefined;
    let disposeAdapter: (() => void | Promise<void>) | undefined;
    let releaseWork: Promise<void> | undefined;
    let disposed = false;
    const retiring = new Set<Promise<void>>();
    let retirementFailed = false, retirementError: unknown;
    const retire = (dispose: () => void | Promise<void>) => {
        const work = Promise.resolve().then(dispose);
        retiring.add(work);
        void work.then(() => { retiring.delete(work); }, error => {
            retiring.delete(work); retirementFailed = true; retirementError ??= error;
        });
    };
    const settled = async () => {
        while (retiring.size) await Promise.allSettled([...retiring]);
        if (retirementFailed) throw retirementError;
    };
    const listeners = new Set<(source: ContentSource) => void>();
    const pendingListeners = new Set<() => void>();
    const emitPending = () => { if (!disposed) for (const listener of [...pendingListeners]) listener(); };
    const owned = (source: ContentSource): boolean => typeof source !== 'string'
        && source.owner.documentId === owner.documentId && source.owner.session === owner.session;
    const emit = (source: ContentSource) => {
        // Once migrated, a canvas must never send an ownerless legacy string.
        // App also checks the current store serial on every report.
        if (disposed || !owned(source)) return;
        for (const listener of [...listeners]) listener(source);
    };
    return {
        peek<A extends SessionAdapter>() { return disposed ? undefined : adapter as A | undefined; },
        settled,
        attach<A extends SessionAdapter>(create: (owner: SourceOwner) => A, commit?: (adapter: A, owner: SourceOwner) => void): A {
            if (disposed) throw new Error('Cannot attach a released canvas session');
            if (adapter) return adapter as A;
            if (retiring.size || retirementFailed) throw new Error('A rejected canvas engine has not retired');
            const next = create(owner);
            adapter = next;
            const disposable = next as SessionAdapter & { dispose?: () => void | Promise<void> };
            disposeAdapter = disposable.dispose?.bind(next);
            let committed = false, stagedSource: ContentSource | undefined;
            try {
                const detach = next.onChange(source => {
                    if (committed) emit(source); else stagedSource = source;
                });
                // A synchronous first report can cause App to release the
                // entry before onChange returns its cleanup.
                if (disposed) { detach(); throw new Error('Canvas session was released during attachment'); }
                unsubscribe = detach;
                const detachPending = next.onPending?.(() => { if (committed) emitPending(); });
                if (detachPending) {
                    if (disposed) { detachPending(); throw new Error('Canvas session was released during attachment'); }
                    unsubscribePending = detachPending;
                }
                if (disposed) throw new Error('Canvas session was released during attachment');
                // A cold dirty source may change during C5 preparation. Peek is provisional
                // here so App can authorize its exact checkpoint; failed CAS keeps coldSource.
                commit?.(next, owner);
                committed = true;
            } catch (error) {
                const detach = unsubscribe, detachPending = unsubscribePending;
                unsubscribe = undefined;
                unsubscribePending = undefined;
                try { detachPending?.(); } catch (cleanupError) { console.error('Canvas pending subscription cleanup failed:', cleanupError); }
                try { detach?.(); } catch (cleanupError) { console.error('Canvas subscription cleanup failed:', cleanupError); }
                adapter = undefined;
                const dispose = disposeAdapter;
                disposeAdapter = undefined;
                if (dispose) retire(dispose);
                throw error;
            }
            // Once the buffer accepted this engine, a notification failure must not
            // roll it back and leave the retained source pointing at a disposed runtime.
            if (stagedSource !== undefined) emit(stagedSource);
            emitPending();
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
            pendingListeners.clear();
            const detach = unsubscribe;
            const detachPending = unsubscribePending;
            const dispose = disposeAdapter;
            unsubscribe = undefined;
            unsubscribePending = undefined;
            disposeAdapter = undefined;
            adapter = undefined;
            let detachError: unknown;
            try { detachPending?.(); } catch (error) { detachError = error; }
            try { detach?.(); } catch (error) { detachError ??= error; }
            releaseWork = Promise.resolve().then(async () => {
                // A detach error wins over a dispose error, as a throw in `finally` would make it.
                let disposeFailed = false;
                let disposeError: unknown;
                try { await dispose?.(); } catch (error) { disposeFailed = true; disposeError = error; }
                let retireFailed = false, retireError: unknown;
                try { await settled(); } catch (error) { retireFailed = true; retireError = error; }
                if (detachError !== undefined) throw detachError;
                if (disposeFailed) throw disposeError;
                if (retireFailed) throw retireError;
            });
            return releaseWork;
        },
        mediaReferences() { return adapter?.mediaReferences?.(); },
        mediaReferenceIssues() { return adapter?.mediaReferenceIssues?.(); },
        journalDelta() { return adapter?.journalDelta?.(); },
        async recover(payload) {
            if (!adapter?.recover) throw new Error('Canvas session is not ready for recovery');
            await adapter.recover(payload);
        },
        onPending(listener) {
            if (disposed) throw new Error('Cannot subscribe to a released canvas session');
            pendingListeners.add(listener);
            return () => { pendingListeners.delete(listener); };
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
                const detach = unsubscribe, detachPending = unsubscribePending;
                unsubscribe = undefined;
                unsubscribePending = undefined;
                adapter = undefined;
                try { detachPending?.(); } finally { detach?.(); }
            };
        },
    };
}
