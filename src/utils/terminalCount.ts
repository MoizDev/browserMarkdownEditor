let count = 0;
const listeners = new Set<() => void>();

export function getTerminalCount(): number {
    return count;
}

export function setTerminalCount(next: number): void {
    if (next === count) return;
    count = next;
    for (const listener of listeners) listener();
}

export function subscribeTerminalCount(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
