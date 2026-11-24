// The terminal reservation exists before the lazy terminal or renderer is loaded.
let active = false;
const listeners = new Set<(active: boolean) => void>();

export function getTerminalContextActive(): boolean { return active; }

export function setTerminalContextActive(value: boolean): void {
    if (active === value) return;
    active = value;
    for (const listener of listeners) listener(value);
}

export function subscribeTerminalContext(listener: (active: boolean) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
