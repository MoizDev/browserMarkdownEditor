import type { ContentSource, SourceOwner } from '../../utils/documentBuffers';
import type { SessionAdapter } from '../../utils/documentSessions';

/** Structural boundary keeps the lazy host independent of engine construction. The App's
 * session store owns this adapter and all panes receive the same underlying board object. */
export interface BoardSessionPort extends SessionAdapter {
    readonly owner: SourceOwner;
    readonly isReadOnly: boolean;
    readonly readOnlyReason?: string | null;
    dispose?(): void | Promise<void>;
}
export interface HostedBoardAdapter<S extends BoardSessionPort> extends SessionAdapter {
    readonly owner: SourceOwner;
    readonly board: S;
    /** Called only after the real editing view has installed its required services. */
    activateEditing?(): void;
    /** What an old board's conversion left out or repaired. Held with the session, not the pane, so it is shown once:
     * a pane remounted by a tab switch does not bring back a notice the person put away. */
    readonly importNotice?: { readonly text: string; isDismissed(): boolean; dismiss(): void };
    dispose(): void | Promise<void>;
}

/** Called inside sessions.ensure/replace, with that store's freshly allocated owner. The
 * liveness callback is App-owned and resolves identity, not a path captured by a pane. */
export function createBoardSessionAdapter<S extends BoardSessionPort>(
    owner: SourceOwner, board: S, isLiveOwner: (owner: SourceOwner) => boolean, disposeBoard?: () => void | Promise<void>,
): HostedBoardAdapter<S> {
    if (board.owner.documentId !== owner.documentId || board.owner.session !== owner.session) throw new Error('Board session owner mismatch');
    let disposed = false, cleanup: Promise<void> | undefined;
    const live = () => !disposed && isLiveOwner(owner);
    const sourceForOwner = (source: ContentSource) => typeof source !== 'string'
        && source.owner.documentId === owner.documentId && source.owner.session === owner.session;
    return {
        owner, board,
        dispose() {
            if (cleanup) return cleanup;
            disposed = true;
            cleanup = Promise.resolve().then(() => disposeBoard ? disposeBoard() : board.dispose?.());
            return cleanup;
        },
        hasPendingEdits: () => live() && board.hasPendingEdits(),
        checkpoint() {
            if (!live()) throw new DOMException('Board session ended', 'AbortError');
            const source = board.checkpoint();
            if (!sourceForOwner(source)) throw new Error('Board checkpoint owner mismatch');
            return source;
        },
        acknowledge(revision, outcome) { if (live()) board.acknowledge(revision, outcome); },
        ...(board.drain ? { drain: () => live() ? board.drain!() : Promise.resolve() } : {}),
        ...(board.onPending ? { onPending: (listener: () => void) => board.onPending!(() => { if (live()) listener(); }) } : {}),
        ...(board.mediaReferences ? { mediaReferences: () => live() ? board.mediaReferences!() : undefined } : {}),
        ...(board.mediaReferenceIssues ? { mediaReferenceIssues: () => live() ? board.mediaReferenceIssues!() : undefined } : {}),
        ...(board.journalDelta ? { journalDelta: () => live() ? board.journalDelta!() : undefined } : {}),
        ...(board.recover ? { recover: (payload: unknown) => {
            if (!live()) throw new DOMException('Board session ended', 'AbortError');
            if (board.isReadOnly) throw new Error(board.readOnlyReason ?? 'Board is read-only');
            return board.recover!(payload);
        } } : {}),
        onChange(listener) {
            return board.onChange(source => { if (live() && sourceForOwner(source)) listener(source); });
        },
    };
}
