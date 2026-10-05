// How many terminals are open, as a tiny external store.
//
// Written by the terminal chunk's store, read by the agent chunk (which asks
// before an update or an uninstall restarts VaultAgent and ends every shell)
// and by anything in the main chunk that wants to say "N running". It imports
// nothing: reading a count must not pull the terminal chunk, and so xterm,
// into the agent's or the main bundle. The terminal and the agent stay
// independent features — this number is the one thing they share.

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
