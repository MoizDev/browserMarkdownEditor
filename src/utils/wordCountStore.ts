export interface WordCounts { words: number; chars: number }

let focusedPath: string | null = null;
let pending: WordCounts | null = null;
let frame = 0;
const listeners = new Set<(counts: WordCounts) => void>();

export function focusWordCounts(path: string | null): void {
    focusedPath = path;
    pending = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
}

export function publishWordCounts(path: string, counts: WordCounts): void {
    if (path !== focusedPath) return;
    pending = counts;
    if (frame) return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        const next = pending;
        pending = null;
        if (next) for (const listener of listeners) listener(next);
    });
}

export function subscribeWordCounts(listener: (counts: WordCounts) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
