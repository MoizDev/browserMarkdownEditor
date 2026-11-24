let active = 0;
const listeners = new Set<(active: number) => void>();

/** Foreground document opens outrank background index reads. */
export function beginForegroundRead(): () => void {
    active++;
    for (const listener of listeners) listener(active);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        active--;
        for (const listener of listeners) listener(active);
    };
}

export function observeForegroundReads(listener: (active: number) => void): () => void {
    listeners.add(listener);
    listener(active);
    return () => { listeners.delete(listener); };
}
