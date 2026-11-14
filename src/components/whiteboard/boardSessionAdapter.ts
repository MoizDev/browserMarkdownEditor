import type { ContentSource, SourceOwner } from '../../utils/documentBuffers';
import type { SessionAdapter } from '../../utils/documentSessions';

/** Structural boundary keeps the lazy host independent of engine construction. The App's
 * session store owns this adapter and all panes receive the same underlying board object. */
export interface BoardSessionPort extends SessionAdapter {
    readonly owner: SourceOwner;
    readonly isReadOnly: boolean;
    readonly readOnlyReason?: string | null;
}
export interface HostedBoardAdapter<S extends BoardSessionPort> extends SessionAdapter {
    readonly owner: SourceOwner;
    readonly board: S;
}

/** Called inside sessions.ensure/replace, with that store's freshly allocated owner. The
 * liveness callback is App-owned and resolves identity, not a path captured by a pane. */
export function createBoardSessionAdapter<S extends BoardSessionPort>(
    owner: SourceOwner, board: S, isLiveOwner: (owner: SourceOwner) => boolean,
): HostedBoardAdapter<S> {
    if (board.owner.documentId !== owner.documentId || board.owner.session !== owner.session) throw new Error('Board session owner mismatch');
    const live = () => isLiveOwner(owner);
    const sourceForOwner = (source: ContentSource) => typeof source !== 'string'
        && source.owner.documentId === owner.documentId && source.owner.session === owner.session;
    return {
        owner, board,
        hasPendingEdits: () => live() && board.hasPendingEdits(),
        checkpoint() {
            if (!live()) throw new DOMException('Board session ended', 'AbortError');
            const source = board.checkpoint();
            if (!sourceForOwner(source)) throw new Error('Board checkpoint owner mismatch');
            return source;
        },
        acknowledge(revision, outcome) { if (live()) board.acknowledge(revision, outcome); },
        ...(board.drain ? { drain: () => live() ? board.drain!() : Promise.resolve() } : {}),
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
