export interface IndexProgress { phase: 'sweeping' | 'idle'; done: number; total: number }
let current: IndexProgress | null = null;
const listeners = new Set<() => void>();
export function setIndexProgress(progress: IndexProgress | null): void {
    current = progress;
    for (const listener of listeners) listener();
}
export function subscribeIndexProgress(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getIndexProgress(): IndexProgress | null { return current; }
