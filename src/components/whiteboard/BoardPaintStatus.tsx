import { useEffect, useState } from 'react';

export type BoardReadiness = 'loading' | 'ready' | 'read-only' | 'failed';
export type BoardPaintProgress = { readonly kind: 'current' } | { readonly kind: 'pending'; readonly reason: 'building' | 'waiting-memory'; readonly drawn?: boolean }
    | { readonly kind: 'failed'; readonly message: string };

export interface BoardPaintStatusProps {
    readonly readiness?: BoardReadiness;
    readonly paint?: BoardPaintProgress;
    readonly isVisible: boolean;
    readonly reason: string | null;
    readonly noun: BoardNoun;
}
export type BoardNoun = 'drawing' | 'notebook' | 'PDF';

export default function BoardPaintStatus({ readiness, paint, isVisible, reason, noun }: BoardPaintStatusProps) {
    const pending = isVisible && readiness !== 'failed' && readiness !== 'loading' && paint?.kind === 'pending';
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
