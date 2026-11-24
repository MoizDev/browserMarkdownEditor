const listeners = new Set<() => void>();
export function subscribeSearchChanges(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function notifySearchChanges(): void { for (const listener of listeners) listener(); }
