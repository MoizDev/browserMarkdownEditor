let epoch = 0;
const listeners = new Set<() => void>();

export function bumpSaveEpoch(): void {
    epoch++;
    for (const listener of listeners) listener();
}

export function subscribeSaveEpoch(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSaveEpoch(): number {
    return epoch;
}
