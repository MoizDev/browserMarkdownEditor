export interface IndexProgress { phase: 'sweeping' | 'idle'; done: number; total: number }
let current: IndexProgress | null = null;
let unavailable = false;
const listeners = new Set<() => void>();
export function setIndexProgress(progress: IndexProgress | null): void {
    current = progress;
    for (const listener of listeners) listener();
}
export function setIndexUnavailable(value: boolean): void {
    if (unavailable === value) return;
    unavailable = value;
    for (const listener of listeners) listener();
}
export function getIndexUnavailable(): boolean { return unavailable; }
export function subscribeIndexProgress(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getIndexProgress(): IndexProgress | null { return current; }
