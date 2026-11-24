import { useEffect, useState } from 'react';

/** The renderer's readiness as the board host shows it; structurally the whiteboard viewer's own readiness. */
export type BoardReadiness = 'loading' | 'ready' | 'read-only' | 'failed';
/** What the renderer holds for the current revision. Structurally the whiteboard viewer's own progress. */
export type BoardPaintProgress = { readonly kind: 'current' } | { readonly kind: 'pending'; readonly reason: 'building' | 'waiting-memory'; readonly drawn?: boolean }
    | { readonly kind: 'failed'; readonly message: string };

export interface BoardPaintStatusProps {
    readonly readiness?: BoardReadiness;
    readonly paint?: BoardPaintProgress;
    readonly isVisible: boolean;
    /** The session's failure or read-only message; for a scene failure it is the actual error. */
    readonly reason: string | null;
    /** What the person calls the document: a notebook said "Loading drawing…" while it opened. */
    readonly noun: BoardNoun;
}
export type BoardNoun = 'drawing' | 'notebook' | 'PDF';

/** The renderer's honest status over the board. Loading until complete pixels exist; a pending mark while the last
 * coherent pixels stay on screen; the actual error on failure. It is display only: it never blocks input or saving,
 * and it never claims readiness that the renderer has not reported. */
export default function BoardPaintStatus({ readiness, paint, isVisible, reason, noun }: BoardPaintStatusProps) {
    const pending = isVisible && readiness !== 'failed' && readiness !== 'loading' && paint?.kind === 'pending';
    // An ordinary edit repaints in a frame or two; showing the mark at once flashed it on every stroke.
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (!pending) { setShown(false); return; }
        const timer = setTimeout(() => setShown(true), 500);
        return () => clearTimeout(timer);
    }, [pending]);
    if (!isVisible || !readiness) return null;
    if (readiness === 'failed') {
        const message = paint?.kind === 'failed' ? paint.message : reason ?? `This ${noun} could not be drawn.`;
        return <div className="board-paint-status board-paint-status-failed" role="alert" data-paint-state="failed">{message}</div>;
    }
    if (readiness === 'loading') {
        const waiting = paint?.kind === 'pending' && paint.reason === 'waiting-memory';
        return <div className="board-paint-status board-paint-status-loading" role="status" data-paint-state="loading">
            {waiting ? `Waiting for memory to draw this ${noun}…` : `Loading ${noun}…`}</div>;
    }
    if (paint?.kind === 'failed') {
        return <div className="board-paint-status board-paint-status-failed" role="alert" data-paint-state="failed">Could not draw this {noun}: {paint.message}</div>;
    }
    if (paint?.kind === 'pending' && shown) {
        return <div className="board-paint-status board-paint-status-pending" role="status" data-paint-state="pending">
            {paint.reason === 'waiting-memory' ? 'Waiting for memory…' : 'Updating…'}</div>;
    }
    return null;
}
