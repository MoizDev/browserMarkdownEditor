import type { DebugOverlayProps } from './chrome/DebugOverlay';

export interface BoardDebugStats {
    readonly frameTimeMs: number;
    readonly backend: string;
    readonly nodeCount: number;
    readonly visibleCount: number;
    readonly selectionCount: number;
    readonly outlines: DebugOverlayProps['outlines'];
}

const EMPTY: BoardDebugStats = { frameTimeMs: 0, backend: '', nodeCount: 0, visibleCount: 0, selectionCount: 0, outlines: [] };
const listeners = new Set<() => void>();
let stats: BoardDebugStats = EMPTY;
let lastPresentedAt = Number.NaN;

export function getBoardDebugStats(): BoardDebugStats { return stats; }

export function subscribeBoardDebugStats(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function recordBoardPresentation(at: number, backend: string): void {
    const interval = at - lastPresentedAt;
    lastPresentedAt = at;
    stats = { ...stats, backend, frameTimeMs: Number.isFinite(interval) && interval > 0 && interval < 1000 ? interval : stats.frameTimeMs };
}

export function publishBoardDebugStats(patch: Partial<Omit<BoardDebugStats, 'backend' | 'frameTimeMs'>>): void {
    stats = { ...stats, ...patch };
    for (const listener of listeners) listener();
}

export function resetBoardDebugStats(): void {
    stats = EMPTY;
    lastPresentedAt = Number.NaN;
    for (const listener of listeners) listener();
}
