// C4.4: the broker reserves a terminal slot even before the lazy terminal chunk loads.
let active = false;
const listeners = new Set<(active: boolean) => void>();

export function getTerminalContextActive(): boolean {
    return active;
}

export function setTerminalContextActive(value: boolean): void {
    if (active === value) return;
    active = value;
    for (const listener of listeners) listener(value);
}

export function subscribeTerminalContext(listener: (active: boolean) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
